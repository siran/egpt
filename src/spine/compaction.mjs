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
import { dueForCompaction, windowForModel } from '../tools/compact-being.mjs';

const DEFAULT_COOLING_MS = 120_000;   // 2 min of quiet after the last reply
const DEFAULT_RATIO = 0.20;           // compact at 20% of the model window (operator 2026-06-30)

export function createCompaction({
  pool,
  getConfig = () => ({}),
  scheduler = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) },
  dueFor = dueForCompaction,          // injectable for tests
  onLog = () => {},
} = {}) {
  const cfg = () => getConfig()?.compaction ?? {};
  const pending = new Map();          // warm key -> timer handle
  const ratio = () => Number(cfg().ratio ?? DEFAULT_RATIO) || DEFAULT_RATIO;
  const coolingMs = () => Number(cfg().cooling_ms ?? DEFAULT_COOLING_MS) || DEFAULT_COOLING_MS;
  const windowOf = (model) => Number(cfg().context_window) || windowForModel(model);

  async function fire(key, target) {
    pending.delete(key);
    try {
      const { due, tokens, threshold } = dueFor(target, { ratio: ratio() });
      if (!due) return;
      onLog(`compacting ${key} (${tokens} tok >= ${threshold})`);
      // native /compact through the SAME warm session (in place, same id). brainOptions
      // match the turn's so a live entry is reused (never a second session on the jsonl).
      await pool.run(key, '/compact', () => {}, { brainOptions: target.brainOptions, klass: 'conversation' });
    } catch (e) { onLog(`compact ${key}: ${e?.message ?? e}`); }
  }

  return {
    // Called after every bot turn. (Re)arms the cooling timer for this conversation;
    // the check + /compact run only once it goes quiet for the cooling period.
    afterTurn({ key, sessionId, model, cwd, allowedTools } = {}) {
      if (cfg().enabled === false || !pool || !key || !sessionId) return;
      const prev = pending.get(key);
      if (prev !== undefined) scheduler.clear(prev);
      const target = { sessionId, model, window: windowOf(model), brainOptions: { sessionId, cwd, model, allowedTools } };
      const h = scheduler.set(() => fire(key, target), coolingMs());
      h?.unref?.();
      pending.set(key, h);
    },
    stop() { for (const h of pending.values()) scheduler.clear(h); pending.clear(); },
  };
}
