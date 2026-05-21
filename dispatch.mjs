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
  } catch (e) {
    logger?.error?.(`!! transcript (${label}) ${path}: ${e?.message ?? e}`);
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
  fs = defaultFs,
  logger = console,
  migrations = [],
  personaEmoji = '🐶',
  personaName = 'egpt',
  readPersonality = async () => null,
  routeContext = {},
  sessionOptions = {},
  stateDir,
  threadContextForMeta = defaultThreadContext,
} = {}) {
  if (!stateDir) throw new Error('createDispatchRuntime: stateDir is required');
  if (!brain?.stream) throw new Error('createDispatchRuntime: brain.stream is required');

  const paths = makePaths(stateDir);
  let migrationPromise = null;
  let stateQueue = Promise.resolve();

  async function readState() {
    try {
      return parseConvState(await fs.readFile(paths.conversationsYaml, 'utf8'));
    } catch (e) {
      if (e?.code !== 'ENOENT') logger?.error?.(`!! readState(${paths.conversationsYaml}): ${e?.message ?? e}`);
      return emptyState();
    }
  }

  async function writeState(state) {
    await fs.mkdir(dirname(paths.conversationsYaml), { recursive: true });
    const tmp = `${paths.conversationsYaml}.tmp-${process.pid}-${clockMs(clock)}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.writeFile(tmp, serializeConvState(state), 'utf8');
    await fs.rename(tmp, paths.conversationsYaml);
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
      const current = await readState();
      const out = await mutator(current);
      const nextState = out?.state ?? current;
      if (out?.write) await writeState(nextState);
      return { ...out, state: nextState };
    });
    stateQueue = nextTask.catch(() => {});
    return nextTask;
  }

  async function logActivity(type, surface, threadId, ...fields) {
    await appendActivity({ fs, paths, clock, logger, type, surface, threadId, fields });
  }

  async function runDefaultBrainTurn(text, onPartial = () => {}, threadCtx = {}) {
    const baseSessionOpts = typeof sessionOptions === 'function'
      ? await sessionOptions({ text, threadCtx })
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
        sessionOpts.cwd = sysThread.threadCwd ?? convEntry.threadCwd ?? stateDir;
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
        const identity = await readPersonality(convEntry.personality || 'default');
        if (identity) {
          wrappedText = `${identity}\n\n---\n\n${text}`;
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

    let brainPromise;
    try {
      brainPromise = Promise.resolve(brain.stream(
        { history: wrappedText, message: wrappedText },
        onPartial,
        sessionOpts,
      ));
    } catch (e) {
      brainPromise = Promise.reject(e);
    }

    const header = !fs.existsSync?.(fpath)
      ? (isSystemThread
          ? `# @e ${threadId} log\n\n`
          : `# @e conversation — ${threadCtx.name ?? threadId}\n\nthread: ${threadId}  ·  surface: ${threadCtx.surface ?? '?'}  ·  slug: ${threadCtx.slug ?? '?'}\n\n`)
      : '';
    await appendTranscript({
      fs,
      logger,
      path: fpath,
      body: header + text + '\n\n',
      label: 'inbound',
    });
    await logActivity('RECV', threadCtx.surface ?? '?', threadId, `${text.length}ch`);

    try {
      const result = await brainPromise;
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
      await runMigrations();
      return readState();
    },
    runDefaultBrainTurn,
    submitIncoming,
  };
}
