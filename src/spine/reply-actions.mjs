// reply-actions.mjs — E's LIMBS: the emitted-action surface a conversation being
// can drive from inside its OWN reply (operator 2026-07-04, "long overdue", ROADMAP
// §3 Conversation-E API). "Similar to react": E's reply text may carry own-line
// ACTION commands that the spine parses out, STRIPS from the surfaced prose, records
// RAW in the transcript (nothing E emitted is ever lost), then EXECUTES against the
// bridge AFTER the reply is recorded.
//
// This is the same shape as the persona-marker / emitted-command machinery
// (src/emitted-commands.mjs) extended into real limbs: own-line, one action per line,
// a slash mid-sentence is just prose. The parse is PURE (parseReplyActions); the
// executor (createReplyActions.execute) is the only effectful half.
//
// FAIL-CLOSED (the operator's hard constraint):
//   - every action executes ONLY in E's OWN conversation (ev.chatId) — the emit
//     syntax carries NO chat target, so cross-chat is impossible by construction;
//     the SOLE exception is /ask, which reaches ONLY the config-named advice channel
//     (mode: auto) via the injected `askAdvice` callback — never an arbitrary chat,
//     and fail-closed (dropped + logged) when no advice channel is configured;
//   - a malformed action line is STRIPPED and LOGGED, never surfaced, never executed;
//   - a /media path must resolve INSIDE the conversation dir (E's confined cwd) —
//     traversal / absolute paths are rejected at parse AND re-checked at execute;
//   - /edit and /delete only touch a message the bridge itself SENT (wasSentByUs);
//   - an execution error is logged, never crashes the turn.
//
// EMIT SYNTAX (documented for E in config/skeletons/room/00-identity.md):
//   /react #<id> <emoji>       react to message #<id>
//   /reply #<id> <text>        quote-reply to message #<id>
//   /media <path> [caption]    send a file from this conversation's folder (relative path)
//   /edit #<id> <text>         edit one of your OWN earlier messages
//   /delete #<id>              delete one of your OWN earlier messages
//   /ask <question>            (mode: auto) consult the operator in the advice channel
import { resolve as resolvePath, relative as relPath, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';

// The reserved action verbs. A line is an ACTION-family line iff (trimmed) it starts
// with '/' + one of these + whitespace-or-EOL — nothing else is ever touched, so
// ordinary prose (even prose that mentions "/react") passes through untouched.
const ACTION_VERBS = new Set(['react', 'reply', 'media', 'edit', 'delete', 'ask']);
const ACTION_LINE = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i;

// A tiny word→emoji alias table so `/react like` works as well as `/react 👍`.
// Beeper's reactionKey also accepts shortcodes/custom keys; a literal emoji or any
// unrecognized token passes straight through as the reactionKey.
const EMOJI_ALIASES = {
  like: '👍', thumbs: '👍', yes: '👍', ok: '👌', no: '👎', check: '✅', cross: '❌',
  heart: '❤️', love: '❤️', laugh: '😂', lol: '😂', cry: '😢', sad: '😢', wow: '😮',
  fire: '🔥', party: '🎉', pray: '🙏', thanks: '🙏', think: '🤔', eyes: '👀',
};
function resolveEmoji(tok) {
  const t = String(tok ?? '').trim();
  if (!t) return null;
  return EMOJI_ALIASES[t.toLowerCase()] ?? t;
}

// A '#<id>' token → the bare id. Beeper message ids are per-chat sequence numbers;
// accept word-chars + dash only. STRICTNESS IS LOAD-BEARING: it rejects a
// documentation/prose placeholder like `#<id>` (angle brackets aren't \w) so an
// echoed help line or an example never resolves to a live target — the "impossible to
// fire by accident" bar. A malformed target makes the whole action malformed →
// stripped + logged, never executed.
const ID_RE = /^#([\w-]+)$/;
// The text-carrying actions (reply/edit): '#<id> <text>' with a STRICT id.
const ID_TEXT_RE = /^#([\w-]+)\s+([\s\S]+)$/;

// A syntactically-unsafe media path (defense-in-depth; the executor re-checks
// containment against the resolved conversation dir): empty, absolute, a drive
// letter, or containing a '..' segment or a null byte.
function unsafePath(p) {
  const s = String(p ?? '');
  if (!s) return 'empty path';
  if (s.includes('\0')) return 'null byte';
  if (/[<>]/.test(s)) return 'placeholder, not a path';   // a doc line like "/media <path>" is not a real send
  if (isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s) || /^[\\/]/.test(s)) return 'absolute path';
  if (s.split(/[\\/]/).some((seg) => seg === '..')) return 'parent traversal (..)';
  return null;
}

// Parse ONE action line's arguments into an executable action, or a malformed
// verdict. `ev` supplies the chatId every action is pinned to.
function parseOne(verb, args, ev) {
  const chatId = ev?.chatId ?? null;
  const raw = String(args ?? '').trim();
  switch (verb) {
    case 'react': {
      // #<id> <emoji> — STRICT: the target id is required (no default to "the
      // message being answered") so a degenerate "/react <emoji>" can never
      // silently fire against an arbitrary message; it is malformed and stripped
      // instead. The emoji must be a SINGLE token (a real emoji has no spaces,
      // even multi-codepoint ones) with no placeholder brackets — so a doc line
      // like "#<id> <emoji>  react to…" is malformed, not a live react.
      const toks = raw ? raw.split(/\s+/) : [];
      if (toks.length !== 2 || !ID_RE.test(toks[0])) return { ok: false, reason: 'react: expected "#<id> <emoji>"' };
      if (/[<>\[\]]/.test(toks[1])) return { ok: false, reason: 'react: placeholder, not an emoji' };
      const emoji = resolveEmoji(toks[1]);
      if (!emoji) return { ok: false, reason: 'react: no emoji' };
      const targetId = ID_RE.exec(toks[0])[1];
      return { ok: true, action: { type: 'react', chatId, targetId, emoji } };
    }
    case 'reply': {
      // #<id> <text>
      const m = ID_TEXT_RE.exec(raw);
      if (!m) return { ok: false, reason: 'reply: expected "#<id> <text>"' };
      return { ok: true, action: { type: 'reply', chatId, targetId: m[1], text: m[2].trim() } };
    }
    case 'edit': {
      // #<id> <text> — an own-message edit (ownership enforced at execute).
      const m = ID_TEXT_RE.exec(raw);
      if (!m) return { ok: false, reason: 'edit: expected "#<id> <text>"' };
      return { ok: true, action: { type: 'edit', chatId, targetId: m[1], text: m[2].trim() } };
    }
    case 'delete': {
      // #<id> — an own-message delete (ownership enforced at execute).
      const m = ID_RE.exec(raw);
      if (!m) return { ok: false, reason: 'delete: expected "#<id>"' };
      return { ok: true, action: { type: 'delete', chatId, targetId: m[1] } };
    }
    case 'ask': {
      // <question> — the WHOLE line is the question. The ONE sanctioned cross-chat emit:
      // it carries NO chat target (the destination is the config advice channel, resolved
      // at execute), so E can never aim it at another conversation. A placeholder echo
      // ("/ask <question>") or an empty ask is malformed → stripped + logged, never sent.
      if (!raw) return { ok: false, reason: 'ask: empty question' };
      if (/[<>]/.test(raw)) return { ok: false, reason: 'ask: placeholder, not a real question' };
      return { ok: true, action: { type: 'ask', chatId, question: raw } };
    }
    case 'media': {
      // <path> [caption]. A leading "quoted path" tolerates a filename with spaces.
      let path, caption = null;
      const q = /^"([^"]+)"\s*([\s\S]*)$/.exec(raw);
      if (q) { path = q[1]; caption = q[2].trim() || null; }
      else { const sp = raw.indexOf(' '); if (sp < 0) { path = raw; } else { path = raw.slice(0, sp); caption = raw.slice(sp + 1).trim() || null; } }
      const bad = unsafePath(path);
      if (bad) return { ok: false, reason: `media: ${bad}` };
      return { ok: true, action: { type: 'media', chatId, path, caption } };
    }
    default:
      return { ok: false, reason: `unknown action /${verb}` };
  }
}

/**
 * PURE split of a reply into { prose, run, stripped }.
 *   prose    — the reply with every action-family line removed (what gets surfaced)
 *   run      — well-formed actions to execute (in order)
 *   stripped — malformed action lines { raw, reason } (logged, never executed/surfaced)
 * @param {string} text  the being's raw reply
 * @param {object} ev    the InboundEvent (supplies chatId + the default react target)
 */
export function parseReplyActions(text, ev = {}) {
  const proseLines = [];
  const run = [];
  const stripped = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = ACTION_LINE.exec(line.trim());
    const verb = m ? m[1].toLowerCase() : null;
    if (!verb || !ACTION_VERBS.has(verb)) { proseLines.push(line); continue; }
    const r = parseOne(verb, m[2] ?? '', ev);
    if (r.ok) run.push(r.action);
    else stripped.push({ raw: line.trim(), reason: r.reason });
  }
  // Collapse the blank lines a removed action leaves behind; trim the ends.
  const prose = proseLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { prose, run, stripped };
}

/**
 * The effectful executor. Injected with the bridge port + persona resolvers + a
 * conversation-dir resolver (for /media confinement). Exposes .parse (the pure
 * split) and .execute (run the actions against the bridge, confined + logged).
 */
export function createReplyActions({ bridge, bodyEmojiOf = () => null, labelOf = () => null, resolveConvDir = async () => null, askAdvice = null, onLog = () => {} } = {}) {
  if (!bridge) throw new Error('createReplyActions: bridge is required');
  // The /ask limb delegates the sole sanctioned cross-chat post to the advice service
  // (createAdvice.ask). Absent (unit tests, no advice wiring) → fail-closed: log + drop,
  // never a bridge send. Keeps reply-actions' "every direct bridge action targets
  // ev.chatId" invariant honest — the cross-chat send lives ONLY in the advice service.
  const _askAdvice = askAdvice ?? (async ({ question } = {}) => { onLog(`ask: no advice channel wired — dropped (fail-closed): ${JSON.stringify(String(question ?? '').slice(0, 120))}`); return false; });

  async function runMedia(a, ev, being) {
    const convDir = await resolveConvDir(ev);
    if (!convDir) { onLog(`media: no conversation dir for ${ev.surface}/${ev.chatId} — skipped`); return; }
    const abs = resolvePath(convDir, a.path);
    const rel = relPath(convDir, abs);
    // Belt-and-suspenders confinement: the resolved path must stay INSIDE convDir.
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) { onLog(`media: "${a.path}" escapes the conversation dir — rejected (fail-closed)`); return; }
    if (!existsSync(abs)) { onLog(`media: file not found "${a.path}" in ${convDir} — skipped`); return; }
    const ok = await bridge.sendMedia?.(ev.chatId, abs, { caption: a.caption, bodyEmoji: bodyEmojiOf(being), label: labelOf(being) });
    if (!ok) onLog(`media: send failed "${a.path}"`);
  }

  async function runOne(a, ev, being) {
    switch (a.type) {
      case 'react': {
        const ok = await bridge.react?.(ev.chatId, a.targetId, a.emoji);
        if (!ok) onLog(`react: ${a.emoji} → #${a.targetId} failed`);
        return;
      }
      case 'reply': {
        // A persona-stamped quote-reply (reuses the bridge's send + replyTo threading).
        const r = await bridge.send?.(ev.chatId, a.text, { replyTo: a.targetId, bodyEmoji: bodyEmojiOf(being), label: labelOf(being) });
        if (r?.blocked || r == null) onLog(`reply: → #${a.targetId} not delivered`);
        return;
      }
      case 'ask': {
        // The ONE sanctioned cross-chat emit. Delegated to the advice service, which
        // resolves the config advice channel, posts the question (tagged with this
        // conversation's name), and stores the origin mapping for answer routing.
        // Fail-closed inside _askAdvice when no advice channel is configured.
        const ok = await _askAdvice({ ev, question: a.question, being });
        if (!ok) onLog(`ask: not delivered (no advice channel or post failed): ${JSON.stringify(String(a.question).slice(0, 120))}`);
        return;
      }
      case 'media': return runMedia(a, ev, being);
      case 'edit': {
        if (!(await bridge.wasSentByUs?.(ev.chatId, a.targetId))) { onLog(`edit: #${a.targetId} is not one of our messages — rejected (fail-closed)`); return; }
        const ok = await bridge.editOwn?.(ev.chatId, a.targetId, a.text, { bodyEmoji: bodyEmojiOf(being), label: labelOf(being) });
        if (!ok) onLog(`edit: #${a.targetId} failed`);
        return;
      }
      case 'delete': {
        if (!(await bridge.wasSentByUs?.(ev.chatId, a.targetId))) { onLog(`delete: #${a.targetId} is not one of our messages — rejected (fail-closed)`); return; }
        const ok = await bridge.deleteOwn?.(ev.chatId, a.targetId);
        if (!ok) onLog(`delete: #${a.targetId} failed`);
        return;
      }
      default: onLog(`action: unknown type ${a?.type}`);
    }
  }

  return {
    parse: (text, ev) => parseReplyActions(text, ev),
    /**
     * Execute the parsed actions. `stripped` lines are logged (never run). Every
     * action targets ev.chatId (the emit syntax has no cross-chat target); errors are
     * swallowed to onLog so a bad limb can never crash the turn.
     */
    async execute(run = [], stripped = [], ev = {}, { being = 'e' } = {}) {
      for (const s of stripped) onLog(`stripped malformed action (${s.reason}): ${JSON.stringify(String(s.raw).slice(0, 120))}`);
      for (const a of run) {
        try { await runOne(a, ev, being); }
        catch (e) { onLog(`action ${a?.type} failed: ${e?.message ?? e}`); }
      }
    },
  };
}
