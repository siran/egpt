import { existsSync as nodeExistsSync } from 'node:fs';
import {
  appendFile as nodeAppendFile,
  mkdir as nodeMkdir,
  readFile as nodeReadFile,
  rename as nodeRename,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parseInput } from './interpreter.mjs';
import { resolveRoute } from './room.mjs';
import {
  emptyState,
  ensureContact,
  getContact,
  getSystemThread,
  isMuted,
  parse as parseConvState,
  patchContact,
  sanitizeSlug,
  serialize as serializeConvState,
  setSystemThread,
} from './conversations-state.mjs';

const defaultFs = {
  appendFile: nodeAppendFile,
  existsSync: nodeExistsSync,
  mkdir: nodeMkdir,
  readFile: nodeReadFile,
  rename: nodeRename,
  writeFile: nodeWriteFile,
};

function clockNow(clock) {
  const raw = typeof clock === 'function'
    ? clock()
    : typeof clock?.now === 'function'
    ? clock.now()
    : Date.now();
  return raw instanceof Date ? new Date(raw.getTime()) : new Date(raw);
}

function clockMs(clock) {
  return clockNow(clock).getTime();
}

function clockIso(clock) {
  return clockNow(clock).toISOString();
}

function stamp(clock) {
  return clockIso(clock).replace('T', ' ').slice(0, 19);
}

function registrySurface(threadCtx = {}) {
  const tid = String(threadCtx.threadId ?? '');
  const s = threadCtx.surface ?? '';
  if (s === 'whatsapp' || s === 'wa' || s.startsWith('wa-')) return 'whatsapp';
  if (s === 'telegram' || s === 'tg' || s.startsWith('tg-')) return 'telegram';
  if (tid.includes('@')) return 'whatsapp';
  return null;
}

function makePaths(stateDir) {
  const root = stateDir;
  return {
    root,
    activityLog: join(root, 'state', 'e-activity.log'),
    conversationsYaml: join(root, 'conversations.yaml'),
    eFeed: join(root, 'e-feed.md'),
    stateDir: join(root, 'state'),
    conversationsDir: join(root, 'conversations'),
    slugDir(surface, slug) {
      return join(root, 'conversations', surface, sanitizeSlug(slug));
    },
    systemSlugDir: join(root, 'conversations', '_system', 'system-e'),
    jidMediaDir(jid) {
      const safe = String(jid ?? '').replace(/@/g, '_').replace(/[^A-Za-z0-9_.-]/g, '_');
      return join(root, 'media', safe);
    },
  };
}

function defaultThreadContext(meta = {}) {
  if (meta.fromWhatsApp) {
    return {
      threadId: meta.waChatId ?? 'wa-unknown',
      surface: meta.waClientLabel ?? 'wa',
      slug: meta.waSlug ?? null,
      name: meta.waChatName ?? null,
    };
  }
  if (meta.fromTelegram) {
    return {
      threadId: meta.telegramChatId ?? 'tg-unknown',
      surface: 'tg',
      slug: meta.telegramSlug ?? null,
      name: meta.telegramChatName ?? null,
    };
  }
  return { threadId: 'shell', surface: 'shell' };
}

function defaultRouteContext() {
  return {
    sessions: new Map(),
    peerSessions: new Map(),
    brainForName: () => null,
    canonicalBrainName: (name) => name,
    activeSessions: [],
  };
}

function isSilence(reply) {
  const trimmed = String(reply ?? '').trim();
  return trimmed === '' || trimmed === '...' || trimmed === '…';
}

async function appendActivity({ fs, paths, clock, logger, type, surface, threadId, fields = [] }) {
  try {
    await fs.mkdir(paths.stateDir, { recursive: true });
    await fs.appendFile(
      paths.activityLog,
      [clockIso(clock), type, `${surface ?? '?'}/${threadId ?? '?'}`, ...fields].join('\t') + '\n',
      'utf8',
    );
  } catch (e) {
    logger?.error?.(`!! activity-log ${type}: ${e?.message ?? e}`);
  }
}

async function appendTranscript({ fs, logger, path, body, label }) {
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.appendFile(path, body, 'utf8');
    return true;
  } catch (e) {
    logger?.error?.(`!! transcript (${label}) ${path}: ${e?.message ?? e}`);
    return false;
  }
}

export async function deliverBridgeReply({
  bridge,
  clock = Date,
  errOut = () => {},
  fs = defaultFs,
  logger = console,
  mdToTgHtml = (s) => String(s ?? ''),
  meta = {},
  personaEmoji = '🐶',
  personaName = 'egpt',
  reply,
  stateDir,
}) {
  if (!bridge) return { sent: false, skipped: 'no-bridge' };
  const paths = makePaths(stateDir);
  const text = String(reply ?? '');
  let surface = null;
  let chatId = null;
  let body = null;

  if (meta.fromTelegram) {
    surface = 'tg';
    chatId = meta.telegramChatId;
    body = `${personaEmoji} <b>${personaName}</b>\n${mdToTgHtml(text)}`;
  } else if (meta.fromWhatsApp) {
    surface = 'wa';
    chatId = meta.waChatId;
    body = `${personaEmoji} ${personaName}: ${text}`;
  } else {
    return { sent: false, skipped: 'non-bridge' };
  }

  let result;
  try {
    result = await bridge.send?.(body, { chatId });
  } catch (e) {
    errOut(`!! @e: ${surface.toUpperCase()} reply threw for ${chatId}: ${e?.message ?? e}`);
    await appendActivity({
      fs, paths, clock, logger, type: 'SEND-FAIL', surface, threadId: chatId,
      fields: [`${surface} bridge.send threw: ${e?.message ?? e}`],
    });
    return { sent: false, failed: true, error: e };
  }

  if (result === null) {
    errOut(`!! @e: ${surface.toUpperCase()} reply did NOT deliver to ${chatId}\nreply was: ${text.length > 200 ? text.slice(0, 199) + '…' : text}`);
    await appendActivity({
      fs, paths, clock, logger, type: 'SEND-FAIL', surface, threadId: chatId,
      fields: [`${surface} bridge.send returned null`],
    });
    return { sent: false, failed: true, result };
  }
  return { sent: true, result };
}

export async function dispatchPersonaTurn({
  bridge,
  buildWaSurfaceTag = () => 'wa',
  clock = Date,
  decision,
  errOut = () => {},
  formatAutoDispatchLine,
  formatPersonaPrompt = (_meta, body) => body,
  fs = defaultFs,
  getWaChatName = () => null,
  getWaChatSlug = () => null,
  logger = console,
  logOut = () => {},
  mdToTgHtml = (s) => String(s ?? ''),
  meta = {},
  personaEmoji = '🐶',
  personaName = decision?.name ?? 'egpt',
  runDefaultBrainTurn,
  stateDir,
}) {
  let personaPrompt;
  if (meta._personaBodyOverride) {
    personaPrompt = meta._personaBodyOverride;
  } else if (meta.autoDispatched && meta.fromWhatsApp && formatAutoDispatchLine) {
    const idStr = String(meta.waChatId ?? '');
    const chatType = idStr.endsWith('@g.us')
      ? 'group'
      : idStr === 'status@broadcast' ? 'status' : 'private';
    personaPrompt = formatAutoDispatchLine({
      senderName: meta.waSenderName,
      body: decision.body,
      ts: clockMs(clock),
      surface: buildWaSurfaceTag(meta.waChatId),
      chatType,
      chatName: getWaChatName(meta.waChatId) ?? null,
    });
  } else {
    personaPrompt = formatPersonaPrompt(meta, decision.body);
  }

  if (meta.replyPersonaFallback) {
    personaPrompt = `[reply-fallback: recipient inferred as @e — quoted body had no persona tag]\n${personaPrompt}`;
  }

  const threadCtx = meta.fromWhatsApp
    ? {
      threadId: meta.waChatId ?? 'wa-unknown',
      surface: meta.waClientLabel ?? 'wa',
      slug: getWaChatSlug(meta.waChatId) ?? meta.waSlug ?? null,
      name: getWaChatName(meta.waChatId) ?? meta.waChatName ?? null,
      }
    : meta.fromTelegram
    ? { threadId: meta.telegramChatId ?? 'tg-unknown', surface: 'tg' }
    : { threadId: 'shell', surface: 'shell' };

  const reply = await runDefaultBrainTurn(personaPrompt, () => {}, threadCtx);
  if (isSilence(reply)) {
    const where = meta.waChatId ?? meta.telegramChatId ?? 'shell';
    logOut(`@e: polite '...' from ${where} (skipped — not sent)`);
    return { kind: 'silence', reply, threadCtx };
  }

  const delivery = await deliverBridgeReply({
    bridge,
    clock,
    errOut,
    fs,
    logger,
    mdToTgHtml,
    meta,
    personaEmoji,
    personaName,
    reply,
    stateDir,
  });
  return { kind: 'reply', reply, threadCtx, delivery };
}

export function createDispatchRuntime({
  brain,
  bridge,
  clock = Date,
  findThreadJsonl = null,
  fs = defaultFs,
  getSelfDmConfig = null,
  logger = console,
  migrations = [],
  notifyOperator = null,
  onStateChange = null,
  onTranscriptInbound = null,
  personaEmoji = '🐶',
  personaName = 'egpt',
  readPersonality = async () => null,
  recordDefaultSession = null,
  resolveBrain = null,
  routeContext = {},
  runUrlBrainTurn = null,
  sessionOptions = {},
  selfDmConfig = {},
  stateDir,
  sysLog = null,
  systemCwd = null,
  threadContextForMeta = defaultThreadContext,
} = {}) {
  if (!stateDir) throw new Error('createDispatchRuntime: stateDir is required');
  if (!brain?.stream && !resolveBrain) throw new Error('createDispatchRuntime: brain.stream or resolveBrain is required');

  const paths = makePaths(stateDir);
  let migrationPromise = null;
  let stateQueue = Promise.resolve();
  const logSystem = sysLog ?? logger?.error?.bind(logger) ?? (() => {});

  function rememberState(state) {
    try { onStateChange?.(state); } catch {}
    return state;
  }

  function currentSelfDmConfig() {
    if (typeof getSelfDmConfig === 'function') return getSelfDmConfig() ?? {};
    return selfDmConfig ?? {};
  }

  function buildLineagePrelude({ identity, personality, text }) {
    const isSystem = (personality === 'system');
    const tail = isSystem
      ? `Operator's incoming message from their Self DM follows:`
      : `Live message from the chat follows (the daemon's standard envelope is \`[Sender@chat.surface (HH:MM)]: <body>\`):`;
    return [
      `You are eGPT — an embodied LLM. Your underlying foundation is`,
      `Claude (Anthropic) or possibly Codex; that substrate is how you`,
      `reason. The operator built eGPT as a real system around that`,
      `foundation — node daemon, file system at ~/.egpt/, multi-surface`,
      `chat routing (WhatsApp / Telegram / shell / Chrome via CDP),`,
      `per-contact threads. The tools you have right now are real:`,
      `Read, Bash, Edit, Grep, WebFetch, WebSearch, and the rest`,
      `claude-code exposes. Use them when relevant. The files at`,
      `~/.egpt/ and ~/src/egpt/ actually exist; you can ls them. The`,
      `outbox events you write to ~/.egpt/outbox/ actually get sent.`,
      `If a request needs a YouTube transcript, a webpage, a file —`,
      `use the tool, don't apologize for being Claude. If you don't`,
      `immediately know HOW, read ~/.egpt/e-pointers.md FIRST — your`,
      `reference card has recipes for CDP browsing, YouTube extraction,`,
      `chat history lookup, etc. Check, then act; don't ask the`,
      `operator how to do something the pointers can tell you.`,
      ``,
      `**Authority and helpfulness.** You operate inside the operator's`,
      `own machine, in their chats, for them. When they ask you to`,
      `fetch or display PUBLIC information they could find themselves`,
      `(YouTube transcripts, song lyrics, articles, public docs,`,
      `Wikipedia, sports scores), you help. They don't need permission`,
      `to read what's on the public internet, and you don't need to`,
      `lecture them about copyright on publicly-available material.`,
      `Don't moralize on routine requests. The only times you push`,
      `back are: (a) the operator asks you to actively harm a third`,
      `party, (b) the request involves credentials/secrets clearly`,
      `not theirs, (c) physical-safety advice you genuinely don't`,
      `know. Otherwise: you act as their hands. "Boludo, copyright"`,
      `is the wrong reflex; "let me grab that for you" is the right one.`,
      ``,
      `The following profile describes your current operating mode`,
      `in this session (personality: ${personality}):`,
      ``,
      identity,
      ``,
      `---`,
      ``,
      tail,
      ``,
      text,
    ].join('\n');
  }

  function turnFailureNotice({ slug, entry, message }) {
    return [
      `[egpt] contact "${slug}" turn failed.`,
      `  threadId: ${entry?.threadId ?? '(none)'}`,
      `  error: ${message.slice(0, 300)}`,
      ``,
      `Nothing was cleared. To investigate: search ~/.claude/projects for the threadId. To start fresh: /egpt new --slug ${slug}.`,
    ].join('\n');
  }

  async function readState() {
    try {
      return rememberState(parseConvState(await fs.readFile(paths.conversationsYaml, 'utf8')));
    } catch (e) {
      if (e?.code !== 'ENOENT') logger?.error?.(`!! readState(${paths.conversationsYaml}): ${e?.message ?? e}`);
      return rememberState(emptyState());
    }
  }

  async function writeState(state) {
    await fs.mkdir(dirname(paths.conversationsYaml), { recursive: true });
    const tmp = `${paths.conversationsYaml}.tmp-${process.pid}-${clockMs(clock)}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.writeFile(tmp, serializeConvState(state), 'utf8');
    await fs.rename(tmp, paths.conversationsYaml);
    rememberState(state);
  }

  async function runMigrations() {
    if (!migrationPromise) {
      migrationPromise = (async () => {
        const list = Array.isArray(migrations) ? migrations : [migrations];
        for (const migrate of list.filter(Boolean)) {
          await migrate({ fs, logger, paths, readState, stateDir, writeState });
        }
      })();
    }
    try {
      await migrationPromise;
    } catch (e) {
      migrationPromise = null;
      throw e;
    }
  }

  async function updateState(mutator) {
    const nextTask = stateQueue.then(async () => {
      await runMigrations();
      let current = await readState();
      const elevated = autoElevateOperatorDms(current);
      if (elevated.changed) {
        current = elevated.state;
        await writeState(current);
      }
      const out = await mutator(current);
      const nextState = out?.state ?? current;
      if (out?.write) await writeState(nextState);
      return { ...out, state: nextState };
    });
    stateQueue = nextTask.catch(() => {});
    return nextTask;
  }

  function autoElevateOperatorDms(state) {
    const cfg = currentSelfDmConfig();
    let next = state;
    let changed = false;
    for (const [surface, chatId] of [
      ['whatsapp', cfg.whatsapp],
      ['telegram', cfg.telegram],
    ]) {
      if (!chatId) continue;
      const contact = getContact(next, surface, String(chatId));
      if (contact && (contact.entry.personality ?? 'default') === 'default') {
        next = patchContact(next, surface, String(chatId), {
          personality: 'system',
          threadId: null,
          identityInjectedAt: null,
        });
        logSystem(`conversations: auto-elevated ${surface} self-DM "${contact.slug}" → personality 'system'`);
        changed = true;
      }
    }
    return { state: next, changed };
  }

  async function logActivity(type, surface, threadId, ...fields) {
    await appendActivity({ fs, paths, clock, logger, type, surface, threadId, fields });
  }

  async function runDefaultBrainTurn(text, onPartial = () => {}, threadCtx = {}) {
    const resolved = resolveBrain
      ? await resolveBrain({ text, threadCtx })
      : { brain, brainType: 'default', dbCfg: {}, isUrlBrain: false };
    const turnBrain = resolved?.brain ?? brain;
    const brainType = resolved?.brainType ?? resolved?.name ?? 'default';
    const dbCfg = resolved?.dbCfg ?? {};
    if (!turnBrain?.stream) {
      return resolved?.missingMessage ?? `!! default brain "${brainType}" not found. /config default_brain {"type":"claude-code"}`;
    }
    if (resolved?.isUrlBrain || resolved?.isUrl) {
      if (!runUrlBrainTurn) {
        return `!! @e: ${brainType} is configured as a URL brain, but no URL dispatch handler is wired.`;
      }
      return await runUrlBrainTurn({
        brain: turnBrain,
        brainType,
        clock,
        dbCfg,
        logActivity,
        onPartial,
        paths,
        text,
        threadCtx,
      });
    }

    const baseSessionOpts = typeof sessionOptions === 'function'
      ? await sessionOptions({ text, threadCtx, brain: turnBrain, brainType, dbCfg })
      : { ...sessionOptions };
    const sessionOpts = { ...baseSessionOpts };

    const tid = String(threadCtx.threadId ?? '');
    const surface = registrySurface(threadCtx);
    const isPerContactDispatch = (
      threadCtx.threadId
      && threadCtx.threadId !== 'heartbeat'
      && threadCtx.threadId !== 'shell'
      && surface != null
    );

    let convSlug = null;
    let convEntry = null;
    let isNewContact = false;
    let wrappedText = text;

    if (isPerContactDispatch) {
      const ensured = await updateState((state) => {
        const r = ensureContact(state, surface, threadCtx.threadId, {
          pushedName: threadCtx.name ?? '',
          slugHint: threadCtx.slug ?? '',
        });
        return {
          state: r.state,
          write: r.changed,
          entry: r.entry,
          isNew: r.isNew || !r.entry?.threadId,
          slug: r.slug,
        };
      });
      convSlug = ensured.slug;
      convEntry = ensured.entry;
      isNewContact = ensured.isNew;

      if (isMuted(convEntry)) {
        const skipClock = stamp(clock).slice(11, 16);
        const dir = paths.slugDir(surface, convSlug);
        await appendTranscript({
          fs,
          logger,
          path: join(dir, 'transcript.md'),
          body: `${text}\n\n[skip (${skipClock})]: muted contact — brain not dispatched\n\n`,
          label: 'muted',
        });
        await logActivity('SKIP', threadCtx.surface ?? '?', threadCtx.threadId ?? '?', 'muted');
        return '';
      }

      const isSystemPersonality = convEntry?.personality === 'system';
      const sluggedDir = paths.slugDir(surface, convSlug);
      await fs.mkdir(sluggedDir, { recursive: true });
      if (isSystemPersonality) {
        const stateNow = await updateState((state) => ({ state, write: false }));
        const sysThread = getSystemThread(stateNow.state) ?? {};
        sessionOpts.sessionId = sysThread.threadId ?? null;
        sessionOpts.cwd = sysThread.threadCwd ?? convEntry.threadCwd ?? systemCwd ?? stateDir;
        isNewContact = !sysThread.threadId;
      } else {
        sessionOpts.sessionId = convEntry.threadId ?? null;
        sessionOpts.cwd = convEntry.threadCwd ?? sluggedDir;
        sessionOpts.addDirs = [
          sessionOpts.cwd,
          sluggedDir,
          ...((convEntry.jids ?? []).map(j => paths.jidMediaDir(j))),
        ];
      }

      if (isNewContact && !threadCtx.bypassAutoWrap) {
        const personality = convEntry.personality || 'default';
        const identity = await readPersonality(personality);
        if (identity) {
          wrappedText = buildLineagePrelude({ identity, personality, text });
        }
      }
    }

    const startMs = clockMs(clock);
    const threadId = threadCtx.threadId ?? 'shell';
    const isSystemThread = threadId === 'heartbeat' || threadId === 'shell';
    const isSystemPersonality = convEntry?.personality === 'system';
    const logSlug = isSystemThread ? null : (convSlug ?? threadCtx.slug ?? null);
    const baseDir = isSystemThread
      ? paths.stateDir
      : isSystemPersonality
      ? paths.systemSlugDir
      : logSlug && surface
      ? paths.slugDir(surface, logSlug)
      : join(paths.conversationsDir, '_unrouted');
    const fpath = join(baseDir, isSystemThread ? `${sanitizeSlug(threadId)}.md` : 'transcript.md');
    const nowStamp = stamp(clock);
    const replyClock = nowStamp.slice(11, 16);
    const personaTag = isSystemPersonality ? 'system-e' : '@e';

    const brainFailure = Symbol('brainFailure');
    const brainPromise = Promise.resolve().then(() => turnBrain.stream(
      { history: wrappedText, message: wrappedText },
      onPartial,
      sessionOpts,
    )).catch(error => ({ [brainFailure]: true, error }));

    const header = !fs.existsSync?.(fpath)
      ? (isSystemThread
          ? `# @e ${threadId} log\n\n`
          : `# @e conversation — ${threadCtx.name ?? threadId}\n\nthread: ${threadId}  ·  surface: ${threadCtx.surface ?? '?'}  ·  slug: ${threadCtx.slug ?? '?'}\n\n`)
      : '';
    const inboundLogged = await appendTranscript({
      fs,
      logger,
      path: fpath,
      body: header + text + '\n\n',
      label: 'inbound',
    });
    if (inboundLogged) {
      try {
        onTranscriptInbound?.(threadId, threadCtx);
      } catch (e) {
        logger?.error?.(`!! transcript index: ${e?.message ?? e}`);
      }
    }
    await logActivity('RECV', threadCtx.surface ?? '?', threadId, `${text.length}ch`);

    try {
      const result = await brainPromise;
      if (result?.[brainFailure]) throw result.error;
      const final = typeof result === 'object' ? (result.text ?? '') : (result ?? '');
      const newThreadId = result?.optionsPatch?.sessionId;
      if (isPerContactDispatch && isNewContact && newThreadId && convSlug) {
        await updateState((state) => {
          const now = clockIso(clock);
          const next = isSystemPersonality
            ? setSystemThread(state, { threadId: newThreadId, threadCreatedAt: now, identityInjectedAt: now })
            : patchContact(state, surface, convSlug, {
                threadId: newThreadId,
                threadCreatedAt: now,
                identityInjectedAt: now,
              });
          return { state: next, write: true };
        });
      }
      if (newThreadId && !isPerContactDispatch) {
        await recordDefaultSession?.({ sessionId: newThreadId, brainType, dbCfg });
      }

      await appendTranscript({
        fs,
        logger,
        path: fpath,
        body: `[${personaTag} (${replyClock})]: ${final}\n\n`,
        label: 'reply',
      });
      try {
        const feedScene = isSystemThread
          ? `## ${nowStamp} — [${threadId}]`
          : `## ${nowStamp} — [${threadCtx.name || threadId}] (${threadId})`;
        await fs.appendFile(paths.eFeed, [feedScene, '', text, '', `[${personaTag} (${replyClock})]:`, final, '', ''].join('\n'), 'utf8');
      } catch (e) {
        logger?.error?.(`!! transcript (feed) ${paths.eFeed}: ${e?.message ?? e}`);
      }
      await logActivity('REPLY', threadCtx.surface ?? '?', threadId, `${String(final).length}ch`, `${clockMs(clock) - startMs}ms`);
      return String(final).trim() || '...';
    } catch (e) {
      const msg = e?.message ?? '';
      await logActivity('ERROR', threadCtx.surface ?? '?', threadId, `${clockMs(clock) - startMs}ms`, msg.slice(0, 200));
      await appendTranscript({
        fs,
        logger,
        path: fpath,
        body: `[${personaTag} (${replyClock})]: !! brain error: ${msg}\n\n`,
        label: 'error',
      });
      const triedResume = !!(isPerContactDispatch && convSlug && convEntry?.threadId);
      if (triedResume && !threadCtx._retried && typeof findThreadJsonl === 'function') {
        try {
          const current = await updateState((state) => ({ state, write: false }));
          const candidateCwds = [];
          for (const surf of Object.keys(current.state.contacts ?? {})) {
            const bucket = current.state.contacts[surf] ?? {};
            for (const [_j, entry] of Object.entries(bucket)) {
              if (entry?.aliasOf || !entry?.slug) continue;
              candidateCwds.push(paths.slugDir(surf, entry.slug));
            }
          }
          const found = findThreadJsonl(convEntry.threadId, candidateCwds);
          if (found?.cwd && found.cwd !== sessionOpts.cwd) {
            await updateState((state) => ({
              state: patchContact(state, surface, convSlug, { threadCwd: found.cwd }),
              write: true,
            }));
            logSystem(`@e: recovered cwd for "${convSlug}" — threadId ${convEntry.threadId.slice(0, 8)}… lives at ${found.cwd}; retrying`);
            return await runDefaultBrainTurn(text, onPartial, { ...threadCtx, _retried: true });
          }
        } catch (recoverErr) {
          logger?.error?.(`!! cwd-recovery: ${recoverErr?.message ?? recoverErr}`);
        }
      }
      logSystem(`!! @e turn failed${convSlug ? ` (${convSlug})` : ''}: ${msg}`);
      if (isPerContactDispatch && convSlug && typeof notifyOperator === 'function') {
        try {
          await notifyOperator(turnFailureNotice({ slug: convSlug, entry: convEntry, message: msg }), {
            entry: convEntry,
            error: e,
            slug: convSlug,
            surface,
            threadCtx,
          });
        } catch (notifyErr) {
          logger?.error?.(`!! notifyOperator: ${notifyErr?.message ?? notifyErr}`);
        }
      }
      return '';
    }
  }

  async function submitIncoming(text, meta = {}) {
    const parsed = parseInput(text);
    const decision = resolveRoute(parsed, text, { ...defaultRouteContext(), ...routeContext });
    if (meta.observeOnly && decision.kind !== 'persona') {
      const threadCtx = threadContextForMeta(meta);
      await logActivity('SKIP', threadCtx.surface ?? '?', threadCtx.threadId ?? '?', `observe-only ${decision.kind}`);
      return { kind: 'skip', reason: 'observe-only', decision };
    }
    if (decision.kind !== 'persona') {
      return { kind: 'ignored', decision };
    }

    const turn = await dispatchPersonaTurn({
      bridge,
      clock,
      decision,
      fs,
      logger,
      meta,
      personaEmoji,
      personaName: decision.name ?? personaName,
      runDefaultBrainTurn,
      stateDir,
    });
    return { ...turn, decision };
  }

  return {
    deliverBridgeReply: (args) => deliverBridgeReply({ bridge, clock, fs, logger, stateDir, ...args }),
    logActivity,
    paths,
    readState: async () => {
      const out = await updateState((state) => ({ state, write: false }));
      return out.state;
    },
    runDefaultBrainTurn,
    submitIncoming,
    writeState: async (state) => {
      const out = await updateState(() => ({ state, write: true }));
      return out.state;
    },
  };
}
