// compaction.mjs — the §2c auto-compaction service (operator 2026-06-30): after a
// COOLING PERIOD following the bot's last reply in a conversation, if that
// conversation's warm session has grown past `ratio` of the model window, compact
// it IN PLACE with Anthropic's NATIVE /compact — sent through the warm pool for the
// session's own key (the egpt compact-being mechanism). The session stays thin, so
// warm turns + the first `--resume` after a restart stay fast; the full record
// lives in transcript.md, so nothing is lost (E reads it for history).
//
// brainpool calls afterTurn() once per turn; it (re)arms a per-conversation cooling
// timer. When the conversation goes quiet for the cooling period, we read the
// session's live token size and /compact only if it's over threshold. /compact
// queues behind any in-flight turn in the warm pool (never woven into one).
//
// AND THE IDENTITY IS RE-FED AFTERWARDS (operator 2026-09-10): the feed rides start, refresh,
// rethread and compaction. A native /compact rewrites the context in place, so the kickoff feed
// can be summarised away and a being would keep its thread while losing who it is. A compact that
// SUCCEEDS calls back into brainpool's `armIdentityRefresh` (handed in on afterTurn) — which is
// the same explicit-null gesture `/agents refresh` writes, so the re-feed rides the being's next
// real turn on the same session and there is no second feed path here. See fire() below.
//
// SANDBOXED BEINGS ARE COMPACTED HERE TOO (operator 2026-09-24, "go B"). Until that day the size
// probe looked for a session only in ~/.claude, a boxed being's CLI keeps it in its own store
// (~/.egpt-jsonl/<threadId>), and so no boxed being was ever due. compact-being's findSessionFile
// now finds a session BY ID in both roots, and a boxed being compacts at the same ratio, with the
// same identity re-feed, as any other. Claude Code's NATIVE autocompact stays on underneath as the
// backstop it already was - measured on kg: 16 native auto compactions, all at 934k-1,000k tokens
// of a 1M window, i.e. only once the window is essentially full, and never followed by a re-feed.
// THE FORCED FALLBACK, should this path ever fail, is to move that native trigger earlier with
// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (read in the claude.exe bundle, which calls it a TEST override -
// measure it before relying on it; it would still not re-feed the identity).
// THIS DECISION CAN BE REVISITED.
import { join } from 'node:path';
import { dueForCompaction, criticallyOver, compactionPolicy, compactionRatio, positiveOrNull } from '../tools/compact-being.mjs';

const DEFAULT_COOLING_MS = 120_000;   // 2 min of quiet after the last reply
// THE WARN GAP (operator 2026-10-08): the WARN threshold sits this fraction of the window BELOW the
// compact `ratio`, so the handoff is written and the operator is told a few % before the context
// actually compacts. Per-being/room overridable (compaction.warn_gap), same place as ratio.
const DEFAULT_WARN_GAP = 0.03;
// THE DEFAULT PRE-COMPACTION NOTICE text (top-level compaction_warn_notice). {agent} = being handle,
// {percent} = current fullness, {path} = the handoff file the being writes. Unset → this; blank → skip.
const DEFAULT_WARN_NOTICE = 'the conversation is at {percent}%, handoff being written, compaction next. you can read the handoff here: {path}';

// THE compaction ratio the spine applies, and its 0.20 default: defined in compact-being.mjs with
// the rest of the policy since 2026-09-24 (compactionPolicy - so /status reads the SAME rule the
// service applies), re-exported here so every existing importer keeps its import.
export { compactionRatio, DEFAULT_RATIO } from '../tools/compact-being.mjs';

// THE LINE THE ADMIN CHANNEL GETS when the spine compacts a being (operator 2026-09-24: "can the
// bridge emit notice of this when it happens?", then "make it's posted on admin channel, eGPT
// Admin"). Every node posts into that one channel, so the line names the NODE and the CHAT as well
// as the being: `node` is config's node_name, `label` the being's display name (brainpool's labelOf,
// the one its "lost its thread" alert uses), `chat` the conversation it was compacted in, `tokens`
// the size the compaction was decided at. A part that is unknown is left out, never invented. Pure,
// so the wording is pinned by a test.
export function compactedNotice({ node = null, label, chat = null, tokens } = {}) {
  const was = Number.isFinite(tokens) && tokens > 0 ? ` (was ${Math.round(tokens / 1000)}k tokens)` : '';
  const who = node ? `${node} · ${label}` : label;
  const where = chat ? ` in ${chat}` : '';
  return `🗜️ ${who}${where} compacted its context${was}. The full history stays in its transcript.md.`;
}

// THE PRE-COMPACTION WARN LINE the admin channel gets (operator 2026-10-08): a few % before the
// /compact, so the operator is warned AND the handoff already exists by the time the context is
// summarised away. THIS is the primary compaction notice now; compactedNotice's post-hoc line is a
// secondary confirmation. Same `node · chat` prefix as compactedNotice (every node posts into the
// one channel). `text` is the configurable compaction_warn_notice, already {agent}/{percent}/{path}-
// resolved by the service — which alone holds the live size and the handoff path. Pure, so its
// frame is pinned by a test.
export function warnNotice({ node = null, label, chat = null, text } = {}) {
  const who = node ? `${node} · ${label}` : label;
  const where = chat ? ` in ${chat}` : '';
  return `🗜️ ${who}${where}: ${text}`;
}

export function createCompaction({
  pool,
  getConfig = () => ({}),
  scheduler = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) },
  dueFor = dueForCompaction,          // injectable for tests
  criticalOver = criticallyOver,      // injectable for tests
  onLog = () => {},
} = {}) {
  const cfg = () => getConfig()?.compaction ?? {};
  // {agent} → the being's HANDLE in the configurable handoff_prompt / welcome strings (operator
  // 2026-10-04). A non-string (the key unset) yields '' so the caller SKIPS the gesture — today's
  // behaviour, byte-for-byte. A blank/whitespace string is treated as unset for the same reason.
  const resolveAgent = (tpl, agent) => (typeof tpl === 'string' && tpl.trim()) ? tpl.replaceAll('{agent}', agent) : '';
  const pending = new Map();          // warm key -> timer handle
  // THE WARN ONCE-GUARD (operator 2026-10-08): warm keys that have already fired their WARN step
  // (handoff + pre-compaction notice) and are waiting to cross the compact ratio. Cleared on the
  // /compact, and whenever the session reads back below the warn threshold (a fresh/compacted
  // thread), so the next growth warns again.
  const warned = new Set();
  const ratio = () => compactionRatio(getConfig());
  const coolingMs = () => Number(cfg().cooling_ms ?? DEFAULT_COOLING_MS) || DEFAULT_COOLING_MS;

  // PER-CONVERSATION OVERRIDES (operator 2026-09-03), carried in on afterTurn from brainpool's
  // resolveConv and using config.yaml's OWN `compaction:` key names — `enabled`, `ratio`,
  // `cooling_ms`, `context_window` — so there is one vocabulary and not a second dialect. For a
  // PINNED being the block they come from is its row in config/agents.yaml, which is the reason
  // this exists: a node-wide ratio is a compromise between conversations that do not compare.
  // wren is ONE THREAD carrying every chat he is addressed in, so he fills a window far faster
  // than any single chat does, and one number cannot be right for both.
  //
  // Absent or unusable ⇒ the node-global answer, unchanged. Every read is validated rather than
  // trusted: `Number(x) || fallback` would silently accept a ratio of 0 as falsy and a NEGATIVE
  // one as real, and a ratio of 0 means "compact after every single turn".
  //
  // BOOLEANS ARE REJECTED, and it is the ONE case where the fallback direction is what matters
  // rather than the validation: `Number(true)` is 1, so `ratio: true` would resolve to "compact
  // at 100% of the window" — never, in practice. And a conversation that overshoots is not
  // compacted late, it is LOST: brainpool's §7 overflow backstop RESETS to a fresh session. So a
  // typo that READS as "on" would silently arm the exact outcome this service exists to prevent,
  // and `enabled: true` sits directly above `ratio:` in the block, which makes transposing them
  // the realistic mistake. Numeric STRINGS are deliberately still coerced ('0.6' is an ordinary
  // YAML quoting accident, and it means what it says).
  //
  // THE RATIO AND THE WINDOW are compact-being's compactionPolicy (2026-09-24), the one rule
  // /status reads too; `_pos` is that module's positiveOrNull, the validation above.
  const _obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
  const _pos = positiveOrNull;
  const coolingFor = (o) => _pos(o?.cooling_ms) ?? coolingMs();
  // THE WARN GAP, per-being/room then node, else the default. A NON-NEGATIVE number (0 = warn
  // coincides with compact): zero is a legitimate "no early warning", so this is _nonNeg, not _pos.
  // Booleans and negatives rejected like every other read here (Number(true) is 1, which would warn
  // a full window early, i.e. never below 0).
  const _nonNeg = (v) => { const n = typeof v === 'boolean' ? NaN : Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
  const warnGapFor = (o) => _nonNeg(o?.warn_gap) ?? _nonNeg(cfg().warn_gap) ?? DEFAULT_WARN_GAP;
  // The configurable pre-compaction notice BODY (top-level compaction_warn_notice), {agent}/
  // {percent}/{path}-resolved. Unset → the operator default; a blank string → '' so the caller
  // SKIPS the notice (same degrade as handoff_prompt/welcome). {path} is the being's conversation
  // folder + handoffs/{agent}.handoff.md — what the being writes and the operator can open.
  const warnNoticeBody = (agent, tokens, window, cwd) => {
    const raw = getConfig()?.compaction_warn_notice;
    const tpl = (raw === undefined || raw === null) ? DEFAULT_WARN_NOTICE
      : (typeof raw === 'string' && raw.trim()) ? raw : '';
    if (!tpl) return '';
    const percent = window > 0 ? Math.round((tokens / window) * 100) : 0;
    const path = cwd ? join(cwd, 'handoffs', `${agent}.handoff.md`) : `handoffs/${agent}.handoff.md`;
    return tpl.replaceAll('{agent}', agent).replaceAll('{percent}', String(percent)).replaceAll('{path}', path);
  };
  // THE CRITICAL RATIO (operator 2026-09-14: "10 minutes of quiet or a critical .9"). The
  // cooling wait exists so a compact lands in a gap between turns instead of mid-exchange --
  // but the timer is RE-ARMED on every turn, so a conversation that stays busy never goes
  // quiet and never compacts, which is the one case where waiting is the dangerous choice.
  // A session that overshoots the window is not compacted late, it is LOST: brainpool's
  // overflow backstop RESETS it to a fresh session. So past this second, higher ratio the
  // compaction is armed with NO wait at all.
  //
  // Unset at both tiers => null => disabled, and the cooling wait is the only trigger, exactly
  // as before this existed. Validated like every other read here: booleans rejected, zero and
  // negatives rejected, and a ratio above 1 rejected (it could never fire, so it is a typo).
  const criticalRatio = () => { const n = _pos(cfg().critical_ratio); return n && n <= 1 ? n : null; };
  const criticalFor = (o) => { const n = _pos(o?.critical_ratio); return (n && n <= 1) ? n : criticalRatio(); };
  // enabled: false at EITHER tier disables. The per-conversation tier can also turn compaction
  // back ON for one being while the node has it off, which is why this is `??` and not an AND.
  const enabledFor = (o) => (o?.enabled ?? cfg().enabled) !== false;

  async function fire(key, target) {
    pending.delete(key);
    try {
      const compactRatio = target.ratio ?? ratio();
      const { due, tokens, threshold } = dueFor(target, { ratio: compactRatio });
      // No readable session (no file): nothing to measure, exactly the old `!due` return.
      if (!Number.isFinite(tokens)) return;
      // THE BEING'S HANDLE for {agent}: the first segment of the warm key
      // (`<being>:<engine>:<surface>:<slug>`, brainpool.mjs). The being being warned/compacted is
      // the one that writes the handoff and gets the welcome.
      const agent = String(key).split(':')[0];
      // ── TWO THRESHOLDS (operator 2026-10-08). The WARN threshold sits `warn_gap` of the window
      //    BELOW the compact `ratio` (frozen onto the target at arm time, alongside ratio/window),
      //    so the handoff is written and the operator told a few % before the context compacts. A
      //    compact-due session is NECESSARILY warn-due (warnRatio ≤ compactRatio), so `due` folds
      //    in — a thread that jumped straight past the compact ratio still gets its handoff first. ──
      const window = Number(target.window) || 0;
      const warnGap = Number.isFinite(target.warnGap) ? target.warnGap : DEFAULT_WARN_GAP;
      const warnRatio = Math.max(0, compactRatio - warnGap);
      const warnDue = due || tokens >= Math.round(window * warnRatio);
      // Below the warn threshold → nothing due. Re-arm the once-guard: the session reads this small
      // on a fresh thread AND right after any compaction (latestContextTokens ~0 past the boundary),
      // so clearing here is how "naturally on a fresh thread" and the post-compact reset both land.
      if (!warnDue) { warned.delete(key); return; }
      // ① WARN — FIRE ONCE PER THREAD (operator 2026-10-08). The handoff turn (MOVED here from the
      // compact step) + the pre-compaction admin notice. The `warned` guard stops a second tick
      // between warn and compact from repeating either; it is cleared on the /compact below.
      if (!warned.has(key)) {
        warned.add(key);
        // THE HANDOFF (operator 2026-10-04): ONE turn on the SAME warm session — still holding its
        // full pre-compact context — to write handoffs/{agent}.handoff.md in its own cwd, so it can
        // pick up seamlessly once the compact summarises that context away. NON-FATAL, the
        // compaction proceeds regardless; own try/catch, one log line; output not posted to chat.
        // Unset handoff_prompt → '' → skipped, today's behaviour exactly.
        const handoffPrompt = resolveAgent(cfg().handoff_prompt, agent);
        if (handoffPrompt) {
          try { await pool.run(key, handoffPrompt, () => {}, { brainOptions: target.brainOptions, klass: 'conversation' }); }
          catch (e) { onLog(`compact ${key}: handoff turn failed (compacting anyway): ${e?.message ?? e}`); }
        }
        // THE PRE-COMPACTION NOTICE to the admin channel (operator 2026-10-08) — the PRIMARY
        // compaction notice: "the conversation is at {percent}%, handoff being written, compaction
        // next. you can read the handoff here: {path}". brainpool's closure prefixes its node · chat
        // line. NON-FATAL; unset/blank text or no sink → skipped. Its own catch, like the handoff's.
        const body = warnNoticeBody(agent, tokens, window, target.brainOptions?.cwd);
        if (body) {
          try { await target.noticeWarn?.({ text: body }); }
          catch (e) { onLog(`compact ${key}: warn notice failed: ${e?.message ?? e}`); }
        }
      }
      // Still short of the compact ratio → warned, and waiting for the session to cross it.
      if (!due) return;
      // ② COMPACT — at `ratio`, unchanged. The handoff already ran at WARN, so it is NOT re-run here.
      onLog(`compacting ${key} (${tokens} tok >= ${threshold})`);
      // native /compact through the SAME warm session (in place, same id). brainOptions
      // match the turn's so a live entry is reused (never a second session on the jsonl).
      await pool.run(key, '/compact', () => {}, { brainOptions: target.brainOptions, klass: 'conversation' });
      warned.delete(key);   // compacted → clear the once-guard so the next growth warns again
      // …AND THE IDENTITY GOES BACK IN (operator 2026-09-10: the feed rides start, refresh,
      // rethread AND compaction). /compact rewrote this session's context in place, so the
      // kickoff feed can have been summarised away; arming re-feeds it on the being's next real
      // turn, on the same session, through the mechanism `/agents refresh` already uses. The
      // callback is brainpool's — it owns conversations.yaml; this function owns the one fact
      // brainpool cannot know, which is whether the compact happened.
      //
      // AFTER the run, NEVER before or around it. A compact that threw leaves the being unarmed:
      // a re-feed nobody needed costs a kickoff for nothing, and a state saying "identity gone"
      // beside a log saying "compact failed" is two records disagreeing about one event.
      //
      // ITS OWN catch, so the two failures stay distinguishable in the log rather than both
      // reading as a failed compact — here the compact SUCCEEDED and only the arming was lost.
      // ③ THE WELCOME rides the re-feed arming as its PAYLOAD (operator 2026-10-04): a configured
      // welcome, {agent}-resolved, is handed to armIdentityRefresh, which stores it beside the null
      // identityInjectedAt so brainpool's wrapFresh appends it AFTER the re-fed identity on the
      // first post-compact turn — pointing the being at the handoff it just wrote. Unset → '' →
      // armed without it, today's behaviour. GATED TO COMPACTION by construction: this service is
      // the only caller of armIdentityRefresh; `/agents refresh` writes the null gesture itself and
      // carries no welcome, so a plain refresh is unaffected.
      try { await target.armIdentityRefresh?.(resolveAgent(cfg().welcome, agent)); }
      catch (e) { onLog(`compact ${key}: compacted, but arming the identity re-feed failed: ${e?.message ?? e}`); }
      // …AND THE ADMIN CHANNEL GETS THE POST-HOC CONFIRMATION (operator 2026-09-24: "can the bridge
      // emit notice of this when it happens?"). SECONDARY since 2026-10-08: the PRIMARY compaction
      // notice is now the pre-compaction warn above (handoff path + percent). This one just confirms
      // the compact landed. brainpool's closure, bound to the being/conversation; only here, after a
      // compact that SUCCEEDED, own catch: a notice that could not be said is logged, never a failed compact.
      try { await target.noticeCompacted?.({ tokens }); }
      catch (e) { onLog(`compact ${key}: compacted, but the admin-channel notice failed: ${e?.message ?? e}`); }
    } catch (e) { onLog(`compact ${key}: ${e?.message ?? e}`); }
  }

  return {
    // Called after every bot turn. (Re)arms the cooling timer for this conversation;
    // the check + /compact run only once it goes quiet for the cooling period.
    afterTurn({ key, sessionId, model, cwd, allowedTools, compaction, armIdentityRefresh, noticeCompacted, noticeWarn } = {}) {
      const over = _obj(compaction);
      if (!enabledFor(over) || !pool || !key || !sessionId) return;
      const prev = pending.get(key);
      if (prev !== undefined) scheduler.clear(prev);
      // The resolved ratio is FROZEN ONTO THE TARGET, not re-read when the timer fires: the
      // policy that armed this compaction is the one that should run it, and the alternative is
      // a conversation compacted under whichever config happened to be loaded a cooling period
      // later. `window` was already frozen here for the same reason, and `warn_gap` now is too —
      // the warn threshold it derives belongs to the policy that armed this compaction.
      // `armIdentityRefresh` is frozen onto the target for the same reason the ratio and the
      // window are: the turn that armed this compaction is the turn whose being should get its
      // identity back, and it closes over that turn's scope/being (operator 2026-09-10).
      // `noticeCompacted` / `noticeWarn` are frozen for the same reason: each is bound to the being
      // and the conversation of the turn that armed this compaction, which is what the line names.
      const { window, ratio: frozenRatio } = compactionPolicy(getConfig(), model, over);
      const target = { sessionId, model, window, ratio: frozenRatio, warnGap: warnGapFor(over), armIdentityRefresh, noticeCompacted, noticeWarn, brainOptions: { sessionId, cwd, model, allowedTools } };
      // ALREADY CRITICAL? Then do not wait for a quiet that may never come. The probe reads a
      // BOUNDED TAIL of the session jsonl rather than the whole file (compact-being's
      // criticallyOver): this runs after every single turn, and the ordinary check's
      // readFileSync would be a multi-MB blocking read per reply on a being whose thread has
      // been alive for weeks.
      //
      // ITS OWN try/catch, and the fallback is the ordinary wait rather than nothing: a probe
      // that throws must not cost this conversation its cooling timer, which is the trigger
      // that worked before the critical ratio existed.
      const critical = criticalFor(over);
      let urgent = false;
      if (critical != null) {
        try { urgent = criticalOver(target, { ratio: critical }) === true; }
        catch (e) { onLog(`compact ${key}: critical probe failed, falling back to the cooling wait: ${e?.message ?? e}`); }
      }
      if (urgent) onLog(`${key} is past the critical ratio ${critical} - compacting now, not waiting for quiet`);
      const h = scheduler.set(() => fire(key, target), urgent ? 0 : coolingFor(over));
      h?.unref?.();
      pending.set(key, h);
    },
    stop() { for (const h of pending.values()) scheduler.clear(h); pending.clear(); warned.clear(); },
  };
}
