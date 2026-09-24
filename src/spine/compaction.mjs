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
import { dueForCompaction, windowForModel, criticallyOver } from '../tools/compact-being.mjs';

const DEFAULT_COOLING_MS = 120_000;   // 2 min of quiet after the last reply
export const DEFAULT_RATIO = 0.20;    // compact at 20% of the model window (operator 2026-06-30)

/**
 * THE compaction ratio the spine applies: `compaction.ratio` from config, else 0.20.
 * ONE owner, because there are two numbers in the tree and only this one is real —
 * compact-being.mjs also carries a COMPACT_RATIO of 0.25, but it is only that module's
 * default PARAMETER, used when a caller passes no ratio. The spine always passes this one,
 * so 0.25 reaches nothing but `node src/tools/compact-being.mjs`'s read-only printout.
 * /status reports what the spine applies, so it calls this rather than re-deriving it.
 */
export function compactionRatio(config) {
  return Number(config?.compaction?.ratio ?? DEFAULT_RATIO) || DEFAULT_RATIO;
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
  const pending = new Map();          // warm key -> timer handle
  const ratio = () => compactionRatio(getConfig());
  const coolingMs = () => Number(cfg().cooling_ms ?? DEFAULT_COOLING_MS) || DEFAULT_COOLING_MS;
  const windowOf = (model) => Number(cfg().context_window) || windowForModel(model);

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
  const _obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
  const _pos = (v) => { const n = typeof v === 'boolean' ? NaN : Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  const ratioFor = (o) => { const n = _pos(o?.ratio); return n && n <= 1 ? n : ratio(); };
  const coolingFor = (o) => _pos(o?.cooling_ms) ?? coolingMs();
  const windowFor = (model, o) => _pos(o?.context_window) ?? windowOf(model);
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
      const { due, tokens, threshold } = dueFor(target, { ratio: target.ratio ?? ratio() });
      if (!due) return;
      onLog(`compacting ${key} (${tokens} tok >= ${threshold})`);
      // native /compact through the SAME warm session (in place, same id). brainOptions
      // match the turn's so a live entry is reused (never a second session on the jsonl).
      await pool.run(key, '/compact', () => {}, { brainOptions: target.brainOptions, klass: 'conversation' });
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
      try { await target.armIdentityRefresh?.(); }
      catch (e) { onLog(`compact ${key}: compacted, but arming the identity re-feed failed: ${e?.message ?? e}`); }
    } catch (e) { onLog(`compact ${key}: ${e?.message ?? e}`); }
  }

  return {
    // Called after every bot turn. (Re)arms the cooling timer for this conversation;
    // the check + /compact run only once it goes quiet for the cooling period.
    afterTurn({ key, sessionId, model, cwd, allowedTools, compaction, armIdentityRefresh } = {}) {
      const over = _obj(compaction);
      if (!enabledFor(over) || !pool || !key || !sessionId) return;
      const prev = pending.get(key);
      if (prev !== undefined) scheduler.clear(prev);
      // The resolved ratio is FROZEN ONTO THE TARGET, not re-read when the timer fires: the
      // policy that armed this compaction is the one that should run it, and the alternative is
      // a conversation compacted under whichever config happened to be loaded a cooling period
      // later. `window` was already frozen here for the same reason.
      // `armIdentityRefresh` is frozen onto the target for the same reason the ratio and the
      // window are: the turn that armed this compaction is the turn whose being should get its
      // identity back, and it closes over that turn's scope/being (operator 2026-09-10).
      const target = { sessionId, model, window: windowFor(model, over), ratio: ratioFor(over), armIdentityRefresh, brainOptions: { sessionId, cwd, model, allowedTools } };
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
    stop() { for (const h of pending.values()) scheduler.clear(h); pending.clear(); },
  };
}
