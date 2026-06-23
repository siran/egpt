import { existsSync as nodeExistsSync } from 'node:fs';
import {
  appendFile as nodeAppendFile,
  mkdir as nodeMkdir,
  readFile as nodeReadFile,
  rename as nodeRename,
  stat as nodeStat,
  unlink as nodeUnlink,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import { parseInput } from './src/interpreter.mjs';
import { splitEmittedReply } from './src/emitted-commands.mjs';
import { resolveRoute } from './src/room.mjs';
import { makeSerialByKey } from './src/serial-by-key.mjs';
import { renderFrontMatter } from './src/transcript-meta.mjs';
import { seedPointers } from './src/pointers.mjs';
import { formatDispatchLine } from './src/dispatch-line.mjs';
import {
  emptyState,
  ensureContact,
  getContact,
  getSystemThread,
  isMuted,
  parse as parseConvState,
  patchContact,
  renameLogLine,
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
  stat: nodeStat,
  unlink: nodeUnlink,
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

function isMissingResumeError(text) {
  const msg = String(text ?? '');
  return /thread\/resume failed/i.test(msg)
    || /no rollout found for thread id/i.test(msg)
    || /no rollout found/i.test(msg)
    || /resume failed/i.test(msg);
}

// The resumed claude session + the new message overflowed the model's context
// window. Distinct from a missing-resume (the session loads fine; it's just too
// big now) and from a generic brain failure. Recovery = reset the thread and
// retry fresh; transcript.md preserves the conversation regardless. (Confirmed
// 2026-06-21: SPOILER's session grew to 4 MB / 179k tok and the periodic
// compactor couldn't reduce it, so the live being kept emitting this verbatim.)
export function isContextOverflowError(text) {
  const msg = String(text ?? '');
  return /prompt is too long/i.test(msg)
    || /too many tokens/i.test(msg)
    || /maximum context length/i.test(msg)
    || /context (?:window|length)[^.]{0,40}exceed/i.test(msg)
    || /exceed[^.]{0,40}context (?:window|length)/i.test(msg);
}

export function isBrainFailureResult(text) {
  const msg = String(text ?? '').trim();
  return /^!!\s+/.test(msg)
    || /^\[(?:codex|claude(?:-sdk|-code)?)\s+(?:exit|timed out)\b/i.test(msg)
    || /invalid_request_error/i.test(msg)
    || /model .*not supported/i.test(msg)
    || /not supported when using Codex/i.test(msg)
    || /\b(?:401|403|429)\b/.test(msg)
    || /\b(?:unauthorized|authentication|rate.?limit|quota)\b/i.test(msg);
}

export function registrySurface(threadCtx = {}) {   // exported for tests
  const tid = String(threadCtx.threadId ?? '');
  const s = threadCtx.surface ?? '';
  if (s === 'whatsapp' || s === 'wa' || s.startsWith('wa-')) return 'whatsapp';
  if (s === 'telegram' || s === 'tg' || s.startsWith('tg-')) return 'telegram';
  // Infer the WA surface from the thread id when surface isn't set. Baileys
  // JIDs carry '@' (…@g.us / …@s.whatsapp.net); Beeper room ids do NOT — they
  // are '!<room>:beeper.local'. Without recognizing Beeper ids here, every
  // Beeper chat fell through to surface=null → not per-contact → its transcript
  // was dumped into the _unrouted catch-all instead of its own per-chat folder
  // (regression from the baileys→Beeper transport move; operator 2026-06-11:
  // every WA chat MUST keep its own transcript — transcripts are first-class).
  if (tid.includes('@') || tid.includes(':beeper')) return 'whatsapp';
  return null;
}

function makePaths(stateDir) {
  const root = stateDir;
  return {
    root,
    activityLog: join(root, 'logs', 'access.log'),
    conversationsYaml: join(root, 'conversations.yaml'),
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
    await fs.mkdir(dirname(paths.activityLog), { recursive: true });
    await fs.appendFile(
      paths.activityLog,
      [clockIso(clock), type, `${surface ?? '?'}/${threadId ?? '?'}`, ...fields].join('\t') + '\n',
      'utf8',
    );
  } catch (e) {
    logger?.error?.(`!! activity-log ${type}: ${e?.message ?? e}`);
  }
}

// Per-chat transcript rolling-window archive (operator 2026-05-22:
// "transcript.md as a rolling window of last 8 days, archive older to
// memories/transcript-yyyy-mm-dd.md"). Track which date each transcript
// file last received content on, so we know when to insert a new day
// header and when to sweep for archiving.
const TRANSCRIPT_KEEP_DAYS = 8;
const _lastTranscriptDate = new Map();   // filePath → 'YYYY-MM-DD' (last write)

// Split older sections out of transcript.md into memories/transcript-
// YYYY-MM-DD.md. Idempotent — sections already archived (still labeled
// `## YYYY-MM-DD` but absent from transcript.md after the rewrite) stay
// in their memories files. Triggered when the date changes on append;
// fast no-op when no archive needed.
// All mutations of a given transcript file run ONE AT A TIME through this
// serializer (keyed by file path). The archive/rotation paths do a
// read → rewrite-tmp → rename-over; an append landing between the read and
// the rename goes to the OLD inode and is silently lost. Plain appends are
// serialized through the same key so they can never straddle a rewrite.
const _byTranscriptPath = makeSerialByKey();

async function archiveOldTranscriptDays(fs, transcriptPath, todayIso) {
  const today = todayIso.slice(0, 10);
  const cutoff = new Date(today + 'T00:00:00.000Z');
  cutoff.setUTCDate(cutoff.getUTCDate() - TRANSCRIPT_KEEP_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  let content;
  try { content = await fs.readFile(transcriptPath, 'utf8'); }
  catch (e) { return; }
  if (!content) return;

  // Parse `## YYYY-MM-DD` headers at line start. Capture everything
  // before the first header as preamble (file's identity heading +
  // pre-date entries).
  const re = /^## (\d{4}-\d{2}-\d{2})\b/gm;
  const matches = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    matches.push({ date: m[1], index: m.index });
  }
  if (matches.length === 0) return;

  const preamble = content.slice(0, matches[0].index);
  const sections = matches.map((mm, i) => {
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
    return { date: mm.date, body: content.slice(mm.index, end) };
  });

  const keep = sections.filter(s => s.date >= cutoffStr);
  const archive = sections.filter(s => s.date < cutoffStr);
  if (archive.length === 0) return;

  const memDir = join(dirname(transcriptPath), 'memories');
  try { await fs.mkdir(memDir, { recursive: true }); }
  catch (e) { return; }

  // Group archived sections by date (multiple sections on the same date
  // can happen across daemon restarts). Append each date's content to
  // memories/transcript-YYYY-MM-DD.md.
  const byDate = new Map();
  for (const sec of archive) {
    if (!byDate.has(sec.date)) byDate.set(sec.date, '');
    byDate.set(sec.date, byDate.get(sec.date) + sec.body);
  }
  for (const [date, body] of byDate.entries()) {
    const memPath = join(memDir, `transcript-${date}.md`);
    try { await fs.appendFile(memPath, body, 'utf8'); }
    catch (e) { /* best effort */ }
  }

  // Rewrite transcript.md with preamble + kept sections only. Atomic.
  const newContent = preamble + keep.map(s => s.body).join('');
  const tmp = transcriptPath + '.tmp-' + process.pid + '-' + Date.now();
  try {
    await fs.writeFile(tmp, newContent, 'utf8');
    await fs.rename(tmp, transcriptPath);
  } catch (e) { /* best effort; leave file alone if rename failed */ }
}

// Returns the date header to PREPEND to the next entry (so the new
// day's section starts), or '' if same-day. Caches per-file so we only
// re-archive on date changes. On the first write to a file in this
// session, peeks at the file's last section header to seed the cache.
// Exported for tests (transcript-serialization.test.mjs).
export async function maybePrefixDateHeader(fs, transcriptPath, clock) {
  // Fast path outside the serializer: same-day cache hit costs nothing.
  const todayIso = clockIso(clock);
  const today = todayIso.slice(0, 10);
  if (_lastTranscriptDate.get(transcriptPath) === today) return '';
  return _byTranscriptPath(transcriptPath, () => _maybePrefixDateHeaderLocked(fs, transcriptPath, todayIso, today));
}

async function _maybePrefixDateHeaderLocked(fs, transcriptPath, todayIso, today) {
  // Re-check under the lock: a concurrent caller may have archived and
  // set the cache while we waited; without this both would prepend a
  // duplicate `## today` header.
  const cached = _lastTranscriptDate.get(transcriptPath);
  if (cached === today) return '';

  // Cache miss: check the file's last `## YYYY-MM-DD` if any.
  if (cached == null) {
    try {
      const content = await fs.readFile(transcriptPath, 'utf8');
      const matches = [...content.matchAll(/^## (\d{4}-\d{2}-\d{2})\b/gm)];
      if (matches.length > 0) {
        const lastDate = matches[matches.length - 1][1];
        if (lastDate === today) {
          _lastTranscriptDate.set(transcriptPath, today);
          return '';
        }
      }
    } catch (e) { /* file doesn't exist yet — that's fine */ }
  }

  // Date is different (or first time seeing this file with a today
  // mismatch). Archive old sections, set the cache, return a header.
  await archiveOldTranscriptDays(fs, transcriptPath, todayIso);
  _lastTranscriptDate.set(transcriptPath, today);
  return `## ${today}\n\n`;
}

// Size-based rotation for append-only logs. Checked every Nth call by
// the caller (size-on-every-append is too costly). Operator (2026-05-22):
// "noted a big e-activity that needs to be rotated."
const LOG_ROTATE_MAX_BYTES = 5 * 1024 * 1024;   // 5 MB
async function rotateIfBig(fs, path) {
  try {
    let st;
    try { st = await fs.stat?.(path); }
    catch (e) { return; }
    if (!st || st.size <= LOG_ROTATE_MAX_BYTES) return;
    const backup = path + '.1';
    try { await fs.unlink(backup); } catch (e) { /* no prior backup — fine */ }
    await fs.rename(path, backup);
  } catch (e) {
    // best-effort; never blocks the main path
  }
}

// Exported for tests (transcript-serialization.test.mjs).
export async function appendTranscript({ fs, logger, path, body, label }) {
  return _byTranscriptPath(path, async () => {
    try {
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.appendFile(path, body, 'utf8');
      return true;
    } catch (e) {
      logger?.error?.(`!! transcript (${label}) ${path}: ${e?.message ?? e}`);
      return false;
    }
  });
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
    // personaReply (operator 2026-06-08): this is a genuine persona reply, so
    // mark it provable on the WA bridge — a later quote-reply to it authorizes
    // reply-to-E. (TG bridge ignores the unknown opt.)
    result = await bridge.send?.(body, { chatId, personaReply: personaName });
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
  // WA edit-stream factory (streamFactoryRef.current). When present, the persona
  // reply edit-streams as the brain generates instead of a one-shot send. Null →
  // one-shot via deliverBridgeReply (shell / Telegram / tests).
  streamFactory = null,
  // Optional: execute an own-line slash command emitted in the brain's reply.
  // (line, meta) -> { isCommand, handled }. isCommand=false means "not a real
  // command, fold back into prose"; true means strip it (ran or blocked). The
  // allowlist + safety policy live in the caller's runner, not here.
  runEmittedCommand = null,
  stateDir,
}) {
  let personaPrompt;
  if (meta._personaBodyOverride) {
    personaPrompt = meta._personaBodyOverride;
  } else if (meta.inboundLine) {
    // ONE PATH (operator 2026-06-16): the canonical message unit, built ONCE at
    // the nucleus entry (egpt.mjs submitInner) with its #id (+ stage-direction
    // wrapping for a reaction). The SAME string is logged to transcript below and
    // fed to the brain — no re-derivation here. This is the line the model sees.
    personaPrompt = meta.inboundLine;
  } else if (meta.autoDispatched && meta.fromWhatsApp && formatAutoDispatchLine) {
    // Defensive fallback for a direct caller that didn't pre-build the unit (e.g.
    // a test). Production always sets meta.inboundLine, so this never fires live.
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
      msgId: meta.waMsgKey,
      stageDirection: !!meta.isReaction,
    });
  } else {
    personaPrompt = formatPersonaPrompt(meta, decision.body);
  }

  // (reply-fallback prompt retired 2026-06-08 — replyPersona is now the
  // persona E provably replied AS, never an inferred @e default.)
  // Reply-gated chat (mention / mention-direct): prepend the editable mode note
  // so @e knows its replies are logged-not-surfaced unless @mentioned.
  if (meta.modeNote) {
    personaPrompt = `${meta.modeNote}\n\n${personaPrompt}`;
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

  // MODE GATE is known BEFORE the turn (it's the chat's reply PERMISSION, not the
  // reply text — operator 2026-06-04: "MODEL'S REPLY IS IRRELEVANT FOR GATING").
  // Fails CLOSED for WA: replyAllowed must be EXPLICITLY true.
  const _gateAllow = meta.fromWhatsApp ? (meta.replyAllowed === true) : (meta.replyAllowed !== false);

  // SINGLE STREAMING PATH (operator 2026-06-23): the persona reply edit-streams as
  // the brain generates, via the same WA streamFactory the resident path uses.
  // LAZY — the stream opens on the FIRST real token, so a mode-withheld or silent
  // turn never posts a placeholder (no gate-on-silence delete for the common case).
  const _isMention = !!meta.mention;
  const _chatId = meta.waChatId;
  const _fmtBody = (text) => `${personaEmoji} ${personaName}: ${String(text ?? '')}`;
  const _canStream = _gateAllow && typeof streamFactory === 'function' && meta.fromWhatsApp && _chatId != null;
  let _stream = null;
  const _streamOpts = { chatId: _chatId, replyAllowed: meta.replyAllowed, isReaction: meta.isReaction, persona: personaName };
  // A MENTION opens the stream UPFRONT (🤔 thinking… → reply → ✅, showThink) and
  // ALWAYS surfaces — even a '…'. An unmentioned auto-on turn streams LAZILY
  // (opens on the first real token, no placeholder) so a silent turn never
  // pollutes the chat (operator 2026-06-23).
  if (_canStream && _isMention) {
    _stream = streamFactory(_fmtBody('🤔 thinking…'), { ..._streamOpts, showThink: true });
  }
  const _onPartial = _canStream
    ? (partial) => {
        const t = String(partial ?? '');
        if (!t.trim()) return;
        if (!_stream) _stream = streamFactory(_fmtBody(t), _streamOpts);
        else _stream.update(_fmtBody(t));
      }
    : () => {};

  const reply = await runDefaultBrainTurn(personaPrompt, _onPartial, threadCtx);
  // The brain still RAN (so E has the message in context), but a chat whose mode +
  // mention-status don't permit a reply gets NOTHING delivered (we never opened a
  // stream — _canStream was false), whatever the reply says.
  if (!_gateAllow) {
    const where = meta.waChatId ?? meta.telegramChatId ?? 'shell';
    logOut(`@e: read ${where} (mode gate withheld reply — processed for context, not sent; replyAllowed=${meta.replyAllowed})`);
    return { kind: 'suppressed', reply, threadCtx, personaPrompt };
  }
  // Silence policy (operator 2026-06-23): a deliberate '…' FLOWS everywhere and
  // is REPRESSED only for conversation-e — E stays quiet in human group/contact
  // chats, but in system-e (Self) its '…' is delivered (a real signal there).
  // An EMPTY reply never ships anywhere (nothing to send; we never manufacture a
  // '…' the model didn't give). Reached only past the mode gate.
  // A MENTION always surfaces (even '…' — the operator asked, a reply is owed).
  // Only an UNMENTIONED conversation-e represses '…' (ambient quiet). An EMPTY
  // reply never ships anywhere (nothing to send; never manufactured).
  const _emptyReply = String(reply ?? '').trim() === '';
  const _repress = !_isMention && !threadCtx._isSystemPersonality;
  if (_emptyReply || (isSilence(reply) && _repress)) {
    if (_stream) await _stream.delete?.();   // remove anything streamed
    const where = meta.waChatId ?? meta.telegramChatId ?? 'shell';
    logOut(`@e: silence from ${where} (${_emptyReply ? 'empty' : 'unmentioned conversation-e represses …'} — not sent)`);
    return { kind: 'silence', reply, threadCtx, personaPrompt };
  }

  // Emitted commands: pull own-line slash commands out of the reply and run
  // the allowed ones (the caller's runner enforces the allowlist). What's left
  // is the prose actually delivered. A line the runner says ISN'T a command
  // (unknown/inline) is folded back into prose. Only reached past the gates,
  // so a chat that can't get a reply also can't trigger a command.
  let deliverReply = reply;
  const emitted = [];
  if (typeof runEmittedCommand === 'function') {
    const proseLines = [];
    for (const seg of splitEmittedReply(reply)) {
      if (seg.isCommand) {
        const res = await runEmittedCommand(seg.text, meta).catch(e => {
          errOut?.(`runEmittedCommand("${seg.text}"): ${e?.message ?? e}`);
          return { isCommand: false };
        });
        if (res?.isCommand) { emitted.push({ line: seg.text, handled: !!res.handled }); continue; }
      }
      proseLines.push(seg.raw);
    }
    deliverReply = proseLines.join('\n').trim();
    // Command-only turn: the action(s) ran, there's no prose to send.
    if (emitted.length && !deliverReply) {
      if (_stream) await _stream.delete?.();   // nothing to render
      return { kind: 'commands', reply: '', threadCtx, personaPrompt, emitted };
    }
  }

  // Deliver: finish the live stream (edit it to the final prose), or one-shot via
  // deliverBridgeReply when we never streamed (shell / Telegram / no factory).
  let delivery;
  if (_stream) {
    await _stream.finish(_fmtBody(deliverReply));
    delivery = { sent: true, streamed: true };
  } else {
    delivery = await deliverBridgeReply({
      bridge,
      clock,
      errOut,
      fs,
      logger,
      mdToTgHtml,
      meta,
      personaEmoji,
      personaName,
      reply: deliverReply,
      stateDir,
    });
  }
  return { kind: 'reply', reply: deliverReply, threadCtx, delivery, personaPrompt, emitted };
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
  // Egpt-wide manifest (e_identity.md) content — legacy fallback only now.
  loadManifest = async () => '',
  // Identity-folder feed (operator 2026-05-26): concatenated identities/<name>/
  // NN-*.md. Preferred source for a NEW contact's first-turn grounding.
  loadIdentityFeed = async () => '',
  // Room folders this contact's jids belong to (operator 2026-05-27). A
  // per-contact E that is part of a room gets FULL access to that room's
  // folder (~/.egpt/rooms/<name>/) — so it can read the shared transcript and
  // the room's files when a member asks "what was said while I was away?".
  // Returns absolute dir paths; merged into the confined sandbox below.
  roomDirsForJids = async () => [],
  // Operator-configured custom directory grants (operator 2026-05-27), sourced
  // from conversations/config.yaml — a file OUTSIDE the contact sandbox, so
  // conversation-e can never widen its own access. Resolves a contact
  // ({ slug, personality, jids }) to a list of { path, access } entries
  // (access: 'full' | 'read'). All paths join the confined addDirs; read-only
  // paths are additionally enforced by the brain's write-deny hook. Managed by
  // the operator via `/e path add|rm`.
  grantDirsForContact = async () => [],
  readPersonality = async () => null,
  // Per-personality allowed_tools resolver. Defaults to `null` =
  // "don't override what sessionOptions returned". Inject the
  // conversations-state.readPersonalityMeta when you want security
  // scoping: each contact gets the tool subset its personality
  // declares (system → 'all', default → read-only, etc.).
  readPersonalityMeta = null,
  recordDefaultSession = null,
  resolveBrain = null,
  routeContext = {},
  runUrlBrainTurn = null,
  runWarmBrainTurn = null,
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
      : `Live message from the chat follows (the daemon's standard envelope is \`Sender@[Chat or group name] (HH:MM): <body>\`):`;
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
      `outbox events you write to ~/.egpt/state/outbox/ actually get sent.`,
      `If a request needs the web, a file, or past context — use the`,
      `tool, don't apologize for being Claude. Your WORKING DIRECTORY is`,
      `THIS conversation's OWN folder (you are sandboxed to it): Read`,
      `./transcript.md for the history of this thread, ./identity.d/ for`,
      `who you are here, ./pointers.md if present, ./media/ for saved`,
      `files. For the web you have WebSearch + WebFetch DIRECTLY — no`,
      `permission needed, just use them (a visible CDP browser is also`,
      `reachable via an outbox event for richer browsing). Check, then`,
      `act; don't ask the operator how to do something you can already do.`,
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

  let _activityWriteCount = 0;
  async function logActivity(type, surface, threadId, ...fields) {
    await appendActivity({ fs, paths, clock, logger, type, surface, threadId, fields });
    // Periodic size-check rotation so a runaway voice-stream session
    // can't grow e-activity.log unbounded. Operator (2026-05-22):
    // "noted a big e-activity that needs to be rotated."
    _activityWriteCount++;
    if (_activityWriteCount % 200 === 0) {
      await rotateIfBig(fs, paths.activityLog);
    }
  }

  async function runDefaultBrainTurn(text, onPartial = () => {}, threadCtx = {}) {
    const resolved = resolveBrain
      ? await resolveBrain({ text, threadCtx })
      : { brain, brainType: 'default', dbCfg: {}, isUrlBrain: false };
    const turnBrain = resolved?.brain ?? brain;
    const brainType = resolved?.brainType ?? resolved?.name ?? 'default';
    const dbCfg = resolved?.dbCfg ?? {};
    const fallbackResolved = resolved?.fallback ?? null;
    const fallbackBrain = fallbackResolved?.brain ?? null;
    const fallbackBrainType = fallbackResolved?.brainType ?? fallbackResolved?.name ?? null;
    const fallbackDbCfg = fallbackResolved?.dbCfg ?? {};
    if (!turnBrain?.stream) {
      if (!fallbackBrain?.stream) {
        return resolved?.missingMessage ?? `!! default brain "${brainType}" not found. /config default_brain {"type":"claude-code"}`;
      }
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
    const fallbackBaseSessionOpts = fallbackBrain?.stream && typeof sessionOptions === 'function'
      ? await sessionOptions({
          text,
          threadCtx,
          brain: fallbackBrain,
          brainType: fallbackBrainType,
          dbCfg: fallbackDbCfg,
          fallbackFor: brainType,
        })
      : (fallbackBrain?.stream ? { ...sessionOptions } : null);

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
          renamedFrom: r.renamedFrom ?? null,
          renamedTo: r.renamedTo ?? null,
        };
      });
      convSlug = ensured.slug;
      convEntry = ensured.entry;
      isNewContact = ensured.isNew;

      // Self-heal: a placeholder 'contact-*' folder is renamed on disk to follow
      // the now-known chat title, so THIS turn's transcript continues in the
      // named dir (convSlug already points to the new slug). Non-fatal — the
      // mkdir below recreates the dir if the move couldn't happen.
      if (ensured.renamedFrom && ensured.renamedTo) {
        try {
          const newDir = paths.slugDir(surface, ensured.renamedTo);
          await fs.rename(paths.slugDir(surface, ensured.renamedFrom), newDir);
          // Log the rename inside the conversation folder (operator 2026-06-14).
          await fs.appendFile(join(newDir, 'renames.log'),
            renameLogLine(ensured.renamedFrom, ensured.renamedTo, 'name changed'), 'utf8').catch(() => {});
          logSystem(`conversations: re-slugged "${ensured.renamedFrom}" → "${ensured.renamedTo}" (name changed)`);
        } catch (e) {
          if (e?.code !== 'ENOENT') logSystem(`conversations: re-slug rename "${ensured.renamedFrom}"→"${ensured.renamedTo}" failed: ${e?.message ?? e}`);
        }
      }

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
      // Surface it to the caller (dispatchPersonaTurn) so it can apply the
      // silence policy: '…' is repressed ONLY for conversation-e, and FLOWS for
      // system-e (Self) (operator 2026-06-23).
      threadCtx._isSystemPersonality = isSystemPersonality;
      const sluggedDir = paths.slugDir(surface, convSlug);
      await fs.mkdir(sluggedDir, { recursive: true });
      // Seed ./pointers.md into the chat's own folder (inside E's sandbox) so the
      // prelude's "read ./pointers.md" actually resolves — the old root-level
      // ~/.egpt/e-pointers.md was unreachable, leaving E lost (operator 2026-06-16).
      // Write-if-missing, so a customized card is never clobbered; backfills
      // existing folders on their next dispatch.
      await seedPointers(fs, sluggedDir);
      if (isSystemPersonality) {
        const stateNow = await updateState((state) => ({ state, write: false }));
        const sysThread = getSystemThread(stateNow.state) ?? {};
        sessionOpts.sessionId = sysThread.threadId ?? null;
        sessionOpts.cwd = sysThread.threadCwd ?? convEntry.threadCwd ?? systemCwd ?? stateDir;
        isNewContact = !sysThread.threadId;
      } else {
        sessionOpts.sessionId = convEntry.threadId ?? null;
        sessionOpts.cwd = convEntry.threadCwd ?? sluggedDir;
        // The contact's full jid set. conversations.yaml keys each entry BY
        // its primary jid (the entry itself has no `jids:` field in the
        // current schema), so without including threadCtx.threadId here both
        // room-membership lookup and media-dir mapping would receive an empty
        // array — silently disabling auto room-folder access for every
        // single-jid contact (operator 2026-05-28, eGPT2).
        const _contactJids = (() => {
          const set = new Set();
          if (threadCtx?.threadId) set.add(threadCtx.threadId);
          for (const j of (convEntry.jids ?? [])) if (j) set.add(j);
          return [...set];
        })();
        let roomDirs = [];
        try { roomDirs = (await roomDirsForJids(_contactJids)) ?? []; }
        catch (e) { logger?.error?.(`!! roomDirsForJids: ${e?.message ?? e}`); }
        let grantEntries = [];
        try {
          grantEntries = (await grantDirsForContact({
            slug: convSlug, personality: convEntry.personality ?? 'default', jids: _contactJids,
          })) ?? [];
        } catch (e) { logger?.error?.(`!! grantDirsForContact: ${e?.message ?? e}`); }
        const grantDirs = grantEntries.map(e => (typeof e === 'string' ? e : e?.path)).filter(Boolean);
        const readOnlyDirs = grantEntries
          .filter(e => e && typeof e === 'object' && e.access === 'read')
          .map(e => e.path).filter(Boolean);
        sessionOpts.addDirs = [
          sessionOpts.cwd,
          sluggedDir,
          ..._contactJids.map(j => paths.jidMediaDir(j)),
          ...roomDirs,
          ...grantDirs,
        ];
        // Read-only grants: in the sandbox (above) so reads work; the brain
        // adds a PreToolUse hook that denies write-class tools under these.
        if (readOnlyDirs.length) sessionOpts.readOnlyDirs = readOnlyDirs;
        // Confine conversation-e's file tools to its own dirs. A restricted
        // allowed_tools list (no Bash) is NOT enough — listing Read there
        // pre-approves reads of ANY absolute path, so a contact could read
        // ~/.egpt/config.yaml. The claude-sdk brain turns confineToDirs into
        // a PreToolUse hook that denies out-of-sandbox paths. system-e (the
        // branch above) deliberately omits this — it is unrestricted.
        sessionOpts.confineToDirs = sessionOpts.addDirs;
      }

      if (isNewContact && !threadCtx.bypassAutoWrap) {
        const personality = convEntry.personality || 'default';
        // Preferred: the identity FOLDER feed (identities/<name>/ concat). Fall
        // back to the legacy personality prelude + manifest when no folder.
        let feed = '';
        try { feed = (await loadIdentityFeed(personality)) ?? ''; } catch (e) { logger?.error?.(`!! loadIdentityFeed: ${e?.message ?? e}`); }
        if (feed.trim()) {
          wrappedText = `${feed.trim()}\n\n---\n\nLive message from the chat (envelope \`Sender@[Chat or group name] (HH:MM): body\`):\n${text}`;
        } else {
          const identity = (await readPersonality(personality)) ?? '';
          let manifest = '';
          try { manifest = (await loadManifest()) ?? ''; } catch (e) { logger?.error?.(`!! loadManifest: ${e?.message ?? e}`); }
          if (manifest.trim() || identity.trim()) {
            const prelude = buildLineagePrelude({ identity, personality, text });
            wrappedText = manifest.trim() ? `${manifest.trim()}\n\n---\n\n${prelude}` : prelude;
          }
        }
      }

      // Per-personality tool scoping. Overrides whatever sessionOptions
      // returned (which defaults to default_brain.allowed_tools — usually
      // 'all'). Without this override, EVERY per-contact dispatch would
      // get the brain's full tool set, meaning a contact could potentially
      // talk the model into shelling out, writing outbox events that
      // masquerade as the operator, etc. The personality file's
      // `allowed_tools` frontmatter is the canonical per-contact scope.
      if (typeof readPersonalityMeta === 'function') {
        try {
          const meta = await readPersonalityMeta(convEntry?.personality || 'default');
          if (meta && meta.allowed_tools !== undefined) {
            sessionOpts.allowedTools = meta.allowed_tools;
          }
        } catch (e) {
          logger?.error?.(`!! personality meta lookup: ${e?.message ?? e}`);
        }
      }
      // Tell E its CURRENT tools, every turn (operator 2026-06-16). The lineage
      // prelude is first-turn-only and a resumed thread is stale, so E kept saying
      // "no tengo acceso a internet" even though WebSearch was in --allowedTools.
      // Derive a concise capabilities line from the resolved scope and ship it as
      // --append-system-prompt (sent on EVERY spawn → always accurate).
      const _scoped = Array.isArray(sessionOpts.allowedTools) ? sessionOpts.allowedTools : [];
      if (_scoped.length) {
        const _bins = _scoped.map((t) => /^Bash\(([^:)\s]+)/.exec(String(t))?.[1]).filter(Boolean);
        const _named = _scoped.filter((t) => !String(t).startsWith('Bash('));
        const _caps = [
          _named.includes('WebSearch')
            ? 'You HAVE WebSearch + WebFetch — real and ready. When asked anything you are not sure of (a result/score, who sang a song, news, a fact, a definition), call WebSearch IMMEDIATELY and answer from the results. NEVER tell the user you "lack internet / live access" — you have WebSearch; only a literal live video feed is unavailable.'
            : '',
          _named.length ? `Your tools this turn: ${_named.join(', ')} (file tools work only inside this chat's own folder).` : '',
          _bins.length ? `You may also RUN these binaries (via Bash, inside this folder): ${_bins.join(', ')}. Just use them; don't ask permission.` : '',
        ].filter(Boolean).join(' ');
        if (_caps) sessionOpts.appendSystemPrompt = [sessionOpts.appendSystemPrompt, _caps].filter(Boolean).join('\n\n');
      }
    }

    const startMs = clockMs(clock);
    const threadId = threadCtx.threadId ?? 'shell';
    const isSystemPersonality = convEntry?.personality === 'system';
    // Slug: per-contact convSlug, else the thread's own slug, else (for the shell
    // surface) 'main'. The shell is a surface like any other now — its transcript
    // lives at conversations/shell/main/transcript.md. The old system-thread
    // special-case under state/ was retired 2026-06-23 (heartbeat gone, shell moved).
    const logSlug = convSlug ?? threadCtx.slug ?? (surface === 'shell' ? 'main' : null);
    const baseDir = isSystemPersonality
      ? paths.systemSlugDir
      : logSlug && surface
      ? paths.slugDir(surface, logSlug)
      : join(paths.conversationsDir, '_unrouted');
    const fpath = join(baseDir, 'transcript.md');
    const nowStamp = stamp(clock);
    const replyClock = nowStamp.slice(11, 16);
    const personaTag = isSystemPersonality ? 'system-e' : '@e';

    const header = !fs.existsSync?.(fpath)
      // YAML front matter: who the transcript is with + the resumable thread
      // + the persona on it + an operator notes slot. Written once, at
      // creation. network/phone/type/participants are enriched later by the
      // collector (GENOME §5); the fields available here are populated now.
      ? renderFrontMatter({
          name:      threadCtx.name ?? threadId,
          surface:   threadCtx.surface ?? '?',
          slug:      threadCtx.slug ?? logSlug,
          thread_id: threadId,
          persona:   isSystemPersonality ? 'system-e' : 'e',
        })
      : '';
    // 8-day rolling window: insert a `## YYYY-MM-DD` section header when the date
    // changes; archive sections older than TRANSCRIPT_KEEP_DAYS into memories/.
    const dateHeader = await maybePrefixDateHeader(fs, fpath, clock);
    const inboundLogged = await appendTranscript({
      fs,
      logger,
      path: fpath,
      body: header + dateHeader + text + '\n\n',
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
      const applyRuntimeSessionShape = (base, { sameBrainType = true } = {}) => ({
        ...sessionOpts,
        ...(base ?? {}),
        cwd: sessionOpts.cwd,
        ...(sessionOpts.addDirs ? { addDirs: sessionOpts.addDirs } : {}),
        ...(sessionOpts.readOnlyDirs ? { readOnlyDirs: sessionOpts.readOnlyDirs } : {}),
        ...(sessionOpts.confineToDirs ? { confineToDirs: sessionOpts.confineToDirs } : {}),
        ...(sessionOpts.allowedTools !== undefined ? { allowedTools: sessionOpts.allowedTools } : {}),
        ...(!sameBrainType && isPerContactDispatch ? { sessionId: null } : {}),
      });

      const fallbackAttempt = fallbackBrain?.stream
        ? {
            brain: fallbackBrain,
            brainType: fallbackBrainType,
            dbCfg: fallbackDbCfg,
            sessionOpts: applyRuntimeSessionShape(fallbackBaseSessionOpts, { sameBrainType: fallbackBrainType === brainType }),
          }
        : null;

      const warmScope = isPerContactDispatch
        ? `${surface}:${convSlug ?? threadId}`
        : `system:${threadId}`;
      const warmClass = isPerContactDispatch
        ? (isSystemPersonality ? 'system' : 'conversation')
        : 'system';
      const runAttempt = async (attempt) => {
        if (typeof runWarmBrainTurn === 'function') {
          const warmResult = await runWarmBrainTurn({
            key: `e:${attempt.brainType}:${warmScope}`,
            klass: warmClass,
            text: wrappedText,
            onPartial,
            sessionOpts: attempt.sessionOpts,
            brainType: attempt.brainType,
            dbCfg: attempt.dbCfg,
            threadCtx,
          });
          if (warmResult != null) return warmResult;
        }
        return attempt.brain.stream(
          { history: wrappedText, message: wrappedText },
          onPartial,
          attempt.sessionOpts,
        );
      };

      let usedAttempt = { brain: turnBrain, brainType, dbCfg, sessionOpts };
      let result;
      try {
        if (!turnBrain?.stream) throw new Error(`default brain "${brainType}" not found`);
        result = await runAttempt(usedAttempt);
      } catch (primaryError) {
        if (!fallbackAttempt || threadCtx._fallbackTried) throw primaryError;
        const msg = primaryError?.message ?? String(primaryError);
        logSystem(`@e: ${brainType} failed (${msg.slice(0, 160)}); trying ${fallbackAttempt.brainType} fallback`);
        result = await runAttempt(fallbackAttempt);
        usedAttempt = fallbackAttempt;
      }

      let final = typeof result === 'object' ? (result.text ?? '') : (result ?? '');
      const triedResume = !!(isPerContactDispatch && convSlug && convEntry?.threadId);
      // Reset + retry fresh when the stored session can't be resumed (missing
      // rollout) OR it overflowed the context window. Most brains THROW on
      // overflow (caught below), but codex/url brains can return it as text — so
      // check here too. transcript.md preserves history across the reset.
      if (triedResume && !threadCtx._retried && (isMissingResumeError(final) || isContextOverflowError(final))) {
        const overflowed = isContextOverflowError(final);
        await updateState((state) => {
          const next = isSystemPersonality
            ? setSystemThread(state, { threadId: null, threadCreatedAt: null, identityInjectedAt: null })
            : patchContact(state, surface, convSlug, {
                threadId: null,
                threadCreatedAt: null,
                identityInjectedAt: null,
              });
          return { state: next, write: true };
        });
        logSystem(`@e: stored thread for "${convSlug}" ${overflowed ? 'overflowed its context window' : 'could not be resumed'}; cleared it and retrying fresh`);
        return await runDefaultBrainTurn(text, onPartial, { ...threadCtx, _retried: true });
      }
      if (usedAttempt.brainType === brainType && fallbackAttempt && !threadCtx._fallbackTried && isBrainFailureResult(final)) {
        logSystem(`@e: ${brainType} returned failure (${String(final).slice(0, 160)}); trying ${fallbackAttempt.brainType} fallback`);
        result = await runAttempt(fallbackAttempt);
        usedAttempt = fallbackAttempt;
        final = typeof result === 'object' ? (result.text ?? '') : (result ?? '');
      }

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
        await recordDefaultSession?.({ sessionId: newThreadId, brainType: usedAttempt.brainType, dbCfg: usedAttempt.dbCfg });
      }

      // A being's reply is a MEMBER CONTRIBUTION (GENOME §2.5 / C7.6b): for a
      // per-chat conversation, record it in the ONE member line — exactly like
      // inbound (formatDispatchLine + the body emoji) — so E is not special-cased.
      // System/heartbeat logs (not per-contact) keep the [@e]: shape. Logging is
      // uniform (I3); the emit gate (the caller) filters only surfacing, never
      // the format. (operator 2026-06-16)
      const replyLine = isPerContactDispatch
        ? formatDispatchLine({
            senderName: personaName,
            chatName: threadCtx.name ?? convSlug ?? threadId,
            surface: threadCtx.surface,
            body: `${personaEmoji} ${final}`,
            ts: clockMs(clock),
          })
        : `[${personaTag} (${replyClock})]: ${final}`;
      await appendTranscript({
        fs,
        logger,
        path: fpath,
        body: `${replyLine}\n\n`,
        label: 'reply',
      });
      await logActivity('REPLY', threadCtx.surface ?? '?', threadId, `${String(final).length}ch`, `${clockMs(clock) - startMs}ms`);
      return String(final).trim();   // empty stays empty — never manufacture a '...' (drop-paths treat '' as silence)
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
      // CONTEXT OVERFLOW (operator 2026-06-21): the resumed session + this
      // message blew the model's context window. Left alone the being surfaces
      // "Prompt is too long" verbatim into the chat (observed in SPOILER, and
      // `/e new` couldn't clear it while the warm pool held the stale session).
      // Reset the thread — transcript.md preserves the full history — and retry
      // ONCE on a fresh session; the warm pool's session-identity guard drops the
      // stale open session for us. This is the reactive backstop to the periodic
      // compactor; it recovers even when compaction never ran.
      if (triedResume && !threadCtx._retried && isContextOverflowError(msg)) {
        await updateState((state) => ({
          state: isSystemPersonality
            ? setSystemThread(state, { threadId: null, threadCreatedAt: null, identityInjectedAt: null })
            : patchContact(state, surface, convSlug, { threadId: null, threadCreatedAt: null, identityInjectedAt: null }),
          write: true,
        }));
        logSystem(`@e: "${convSlug}" overflowed its context window; reset the thread and retrying fresh`);
        return await runDefaultBrainTurn(text, onPartial, { ...threadCtx, _retried: true });
      }
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
