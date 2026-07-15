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
//   - a /reply targeting the message THIS REPLY ALREADY QUOTES is REDUNDANT (operator
//     2026-07-08, Zohykar rogue-twin) — the action is dropped, but its TEXT DEMOTES to
//     prose (2026-07-15): redundant is not malformed, and discarding content is a bug;
//   - a /media path must resolve INSIDE the conversation dir (E's confined cwd) —
//     traversal / absolute paths are rejected at parse AND re-checked at execute;
//   - /edit and /delete only touch a message the bridge itself SENT (wasSentByUs);
//   - an execution error is logged, never crashes the turn.
//
// EMIT SYNTAX (documented for E in config/skeletons/room/10-actions.md — a SPINE
// CONTRACT that feeds EVERY being independent of identity, operator 2026-07-06):
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
// verdict. `ev` supplies the chatId every action is pinned to; `opts.quotedId` is the
// message THIS reply is itself posted as a quote of (null = it quotes nothing).
function parseOne(verb, args, ev, opts = {}) {
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
      // REDUNDANCY GUARD (operator 2026-07-08, Zohykar rogue-twin; made HONEST + demoting
      // 2026-07-15). When the message E is ALREADY posting quotes the target, a /reply at that
      // same target would only duplicate the train as a second, un-stamped post — the rogue twin.
      //
      // The premise is the reply's ACTUAL quote target (opts.quotedId), NOT "the message being
      // answered" (ev.msgId). Those coincide only when the placeholder was in fact opened as a
      // quote of it; comparing against ev.msgId claimed a quote that did not exist and discarded
      // the ONE limb by which E could quote at all.
      //
      // Redundant is NOT malformed, so it DEMOTES rather than strips: only the TARGET is
      // redundant — the TEXT is E's actual reply, and stripping the line ate it whenever there
      // was no other prose (the live 2026-07-15 shape: E's whole reply was one /reply line, so
      // the turn went action-only and the placeholder was deleted with E's words inside it).
      // Demoted, the text becomes prose in the reply that already quotes the target: exactly one
      // message, nothing lost, and STILL no second post — the twin stays fixed. A /reply at any
      // OTHER message — or from a reply that quotes NOTHING — is untouched: that is the real,
      // useful case, and Beeper cannot retarget an existing message (its edit endpoint carries
      // no reply target), so it can only be honored as a fresh post.
      const quotedId = opts?.quotedId != null ? String(opts.quotedId) : null;
      if (quotedId && m[1] === quotedId) return { ok: false, demote: m[2].trim() };
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
 *   prose    — the reply with every action-family line removed (what gets surfaced), plus the
 *              TEXT of any redundant /reply, which DEMOTES to prose rather than being discarded
 *   run      — well-formed actions to execute (in order)
 *   stripped — malformed action lines { raw, reason } (logged, never executed/surfaced)
 * @param {string} text  the being's raw reply
 * @param {object} ev    the InboundEvent (supplies chatId + the default react target)
 * @param {object} opts  { quotedId } — the message this reply itself quotes (redundancy guard)
 */
export function parseReplyActions(text, ev = {}, opts = {}) {
  const proseLines = [];
  const run = [];
  const stripped = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = ACTION_LINE.exec(line.trim());
    const verb = m ? m[1].toLowerCase() : null;
    if (!verb || !ACTION_VERBS.has(verb)) { proseLines.push(line); continue; }
    const r = parseOne(verb, m[2] ?? '', ev, opts);
    // DEMOTE (redundant /reply): the action is dropped but its TEXT is content — it becomes
    // prose VERBATIM, never re-parsed, so an action-shaped payload can't smuggle a live limb.
    if (r.ok) run.push(r.action);
    else if (r.demote != null) proseLines.push(r.demote);
    else stripped.push({ raw: line.trim(), reason: r.reason });
  }
  // Collapse the blank lines a removed action leaves behind; trim the ends.
  const prose = proseLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { prose, run, stripped };
}

// A trailing INCOMPLETE line: could it still BECOME an action line once it terminates?
// The line's first non-space character is fixed as soon as it exists, so anything not
// starting with '/' can never be an action and streams at once. After the '/', either the
// verb is still being typed (no whitespace yet → viable iff some verb starts with it) or
// it is complete (→ viable iff it IS one of ours). '/reactx', '/hello world' and '/123'
// are all prose by this test, exactly as ACTION_LINE + ACTION_VERBS will judge them.
const VERB_PREFIX = /^\/([a-z]*)$/i;
function couldBecomeAction(fragment) {
  const t = String(fragment ?? '').trim();
  if (!t || t[0] !== '/') return false;
  const p = VERB_PREFIX.exec(t);
  if (p) return [...ACTION_VERBS].some((verb) => verb.startsWith(p[1].toLowerCase()));
  const m = ACTION_LINE.exec(t);
  return !!m && ACTION_VERBS.has(m[1].toLowerCase());
}

// Is this trailing fragment ALREADY a redundant /reply — i.e. one that will DEMOTE to prose?
// Load-bearing for streaming: a demoted line IS prose, so withholding it as a "viable action
// prefix" would hold it back forever (its line never terminates until the reply ends), and the
// very shape demote exists to rescue would never stream. Decidable early: ID_TEXT_RE requires
// whitespace after the id, and that whitespace FIXES the id — no later character can change it
// (only extend the text). So from `#<id> <first char>` on, the verdict is final and the text
// grows monotonically. Before that (`/reply #15971`) the target is still unknown → keep holding.
function isDemotingReply(fragment, opts = {}) {
  const quotedId = opts?.quotedId != null ? String(opts.quotedId) : null;
  if (!quotedId) return false;
  const m = ACTION_LINE.exec(String(fragment ?? '').trim());
  if (!m || m[1].toLowerCase() !== 'reply') return false;
  const a = ID_TEXT_RE.exec(String(m[2] ?? '').trim());
  return !!a && a[1] === quotedId;
}

/**
 * The prose a PARTIAL may safely stream (operator 2026-07-15: E's `/reply #<id> …` token
 * rendered live in the chat because the raw partial was piped straight to the placeholder).
 * Same PURE split as parseReplyActions — so the stream shows exactly what finish() will
 * deliver — plus the mid-line guard: a partial can end ANYWHERE, so its last line may be an
 * action still being typed ('/', '/re', '/reply #9'). A line-based parse would render that
 * fragment for a frame and snap it away once the newline landed, which only MOVES the bug.
 * Such a tail is WITHHELD until it terminates; a tail that can no longer become a STRIPPED
 * action — ordinary prose, or a /reply that will demote — streams immediately, so nothing E
 * will actually say is ever held back.
 *
 * The un-withheld tail is handed to parseReplyActions as part of the WHOLE text (not appended
 * to a separately-parsed head), so blank-line collapsing and demotion are decided exactly once,
 * by the same code that decides the finished reply. That is what keeps every frame a true
 * prefix of the delivered prose.
 * @param {string} partial  the cumulative raw text streamed so far
 * @param {object} ev       the InboundEvent (threaded to the same parse)
 * @param {object} opts     { quotedId } — same premise as parseReplyActions (see isDemotingReply)
 */
export function partialProse(partial, ev = {}, opts = {}) {
  const s = String(partial ?? '');
  const cut = s.lastIndexOf('\n');
  const tail = cut < 0 ? s : s.slice(cut + 1);
  const withhold = couldBecomeAction(tail) && !isDemotingReply(tail, opts);
  return parseReplyActions(withhold ? s.slice(0, cut + 1) : s, ev, opts).prose;
}

/**
 * The effectful executor. Injected with the bridge port + persona resolvers + a
 * conversation-dir resolver (for /media confinement). Exposes .parse (the pure
 * split) and .execute (run the actions against the bridge, confined + logged).
 */
export function createReplyActions({ bridge, bodyEmojiOf = () => null, labelOf = () => null, resolveConvDir = async () => null, askAdvice = null, defaultKey = 'e', onLog = () => {} } = {}) {
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
    parse: (text, ev, opts) => parseReplyActions(text, ev, opts),
    // The streaming half of the SAME split: what a partial may show (see partialProse).
    partialProse: (partial, ev, opts) => partialProse(partial, ev, opts),
    /**
     * Execute the parsed actions. `stripped` lines are logged (never run). Every
     * action targets ev.chatId (the emit syntax has no cross-chat target); errors are
     * swallowed to onLog so a bad limb can never crash the turn.
     */
    async execute(run = [], stripped = [], ev = {}, { being = defaultKey } = {}) {
      for (const s of stripped) onLog(`stripped malformed action (${s.reason}): ${JSON.stringify(String(s.raw).slice(0, 120))}`);
      for (const a of run) {
        try { await runOne(a, ev, being); }
        catch (e) { onLog(`action ${a?.type} failed: ${e?.message ?? e}`); }
      }
    },
  };
}
