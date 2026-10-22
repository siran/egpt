// liveness.mjs — the chat sees that a being is alive (operator 2026-10-15: "there are turns
// running... perhaps the bridge can maintain an animation"; "bridge must not evict background
// agents on its own ... instead we can prompt model if they're still necessary. if
// unresponsiveness then post in egpt logging group").
//
// Rides the spine's tick (STOP-first). Every message is THE reply path's (sender.open), pulsed with
// the sender's `pulse` and settled with its `end`:
//   · a running turn: its placeholder shows the elapsed time; once the placeholder is past its edit
//     window a status message takes over, rolled to a fresh one each window, ended ✓ with the turn.
//   · background work: ONE status message per being per chat, opened when the dispatching turn ends — as a
//     reply to that turn's own message, as is each rolled one — ended ✓ when a finished task's wake starts
//     (the wake posts its own placeholder) or the work is gone.
//   · background running ASK_AFTER_MS: the being is asked through the wake path whether it is still
//     needed; no answer → one line to the logging group. Nothing is evicted or killed here.
import { LIVE_FRAME_MARK } from '../dispatch-line.mjs';
import { elapsed } from './sender.mjs';

export const LIVENESS_EVERY_MS = 15_000;       // every live message's pulse (operator 2026-10-16); config liveness.every_ms overrides (read each tick)
export const ASK_AFTER_MS = 2 * 3_600_000;     // continuous background work this long → ask, then once per interval
export const ASK_ANSWER_MS = 30 * 60_000;      // an ask with no answer by then → the logging group

const STILL_THINKING = `${LIVE_FRAME_MARK} still thinking…`;

export function createLiveness({ sender, brain, now, everyMs = () => LIVENESS_EVERY_MS, stopped = () => false, labelOf = (b) => b, ask = null, report = null, note = () => {} }) {
  const turns = new Set();     // { out, being, ev, chat, auto, since, last, status }
  const bg = new Map();        // `${being} ${chatId}` → { out, being, ev, chat, auto, last, what, quiet, reply }
  const asks = new Map();      // same key → { at, settled, reported, text }
  const chatNames = new Map(); // same key → the chat's name, for the logging-group line
  const keyOf = (being, chatId) => `${being} ${chatId}`;
  const names = (tasks) => tasks.map((t) => t.description).join('; ');
  const working = (what) => `⚙️ working in background: ${what}`;
  const open = (e, label) => sender.open(e.chat, { being: e.being, status: label, auto: e.auto, origin: e.ev.chatId, ...e.reply });
  const end = (out, text = null) => Promise.resolve(out?.end?.(text)).catch((err) => note(`liveness: could not settle a status — ${err?.message ?? err}`));

  // Pulse `out`; once it is past its edit window, freeze it and open a fresh status in its place.
  function roll(out, e, label, ms) {
    if (out && out.pulse?.(ms, label) !== false) return out;
    if (out) end(out);
    return open(e, label);
  }

  function unanswered(a) {
    if (a.reported || stopped()) return;
    a.reported = true;
    note(`liveness: ${a.text}`);
    if (report) Promise.resolve(report(a.text)).catch((err) => note(`liveness: logging group refused the line — ${err?.message ?? err}`));
  }

  function maybeAsk(k, s, tasks, ms, t) {
    const a = asks.get(k);
    if (!ask || ms < ASK_AFTER_MS || (a && (!a.settled || t - a.at < ASK_AFTER_MS))) return;
    if ([...turns].some((x) => keyOf(x.being, x.ev.chatId) === k)) return;
    const what = names(tasks);
    const rec = { at: t, settled: false, reported: false, text: `${labelOf(s.being)} in ${chatNames.get(k) ?? s.ev.chatId}: background task(s) ${what} running ${elapsed(ms)}, the being did not answer whether they are still needed.` };
    asks.set(k, rec);
    note(`liveness: ${s.being}/${s.ev.chatId} — background task(s) ${what} running ${elapsed(ms)}, asking whether still needed`);
    const line = `[egpt] Your background task(s) ${what} have been running for ${elapsed(ms)}. Are they still necessary? Stop any that aren't, and report.`;
    Promise.resolve(ask({ being: s.being, surface: s.ev.surface, chatId: s.ev.chatId, summaries: tasks.map((x) => x.description), line }))
      .then((answered) => answered === true, () => false)
      .then((ok) => { rec.settled = true; if (!ok) unanswered(rec); });
  }

  function tick() {
    const t = now();
    const every = everyMs();
    for (const x of turns) {
      if (t - x.last < every) continue;
      x.last = t;
      if (!x.status && x.out.pulse?.(t - x.since) !== false) continue;
      x.status = roll(x.status, x, STILL_THINKING, t - x.since);
    }
    for (const [k, s] of bg) {
      if (t - s.last < every) continue;
      s.last = t;
      const tasks = brain.background?.(s.being, s.ev) ?? [];
      if (!tasks.length) {
        if (!s.quiet) { s.quiet = true; continue; }   // one quiet tick: a wake may be on its way
        bg.delete(k); asks.delete(k);
        end(s.out, `✓ background work ended: ${s.what}`);
        continue;
      }
      s.quiet = false;
      s.what = names(tasks);
      const ms = t - Math.min(...tasks.map((x) => x.since ?? t));
      s.out = roll(s.out, s, working(s.what), ms);
      maybeAsk(k, s, tasks, ms, t);
    }
    for (const a of asks.values()) if (!a.settled && t - a.at >= ASK_ANSWER_MS) unanswered(a);
  }

  return {
    tick() { try { tick(); } catch (err) { note(`liveness: tick failed — ${err?.message ?? err}`); } },
    // A reply turn is live: its placeholder is pulsed until it ends.
    turnStarted({ out, being, ev, chat, auto = false }) {
      const x = { out, being, ev, chat, auto, since: now(), last: now(), status: null };
      turns.add(x);
      if (ev.chatName) chatNames.set(keyOf(being, ev.chatId), ev.chatName);
      return x;
    },
    // …and ended: settle its overflow status; background work it left running gets ONE status here.
    turnEnded(x) {
      if (!x || !turns.delete(x)) return;
      if (x.status) end(x.status, `✓ ${elapsed(now() - x.since)}`);
      const k = keyOf(x.being, x.ev.chatId);
      if (bg.has(k) || stopped()) return;
      const tasks = brain.background?.(x.being, x.ev) ?? [];
      if (!tasks.length) return;
      const reply = { replyTo: x.out?.confirmedId ?? null, replyIn: x.out?.confirmedIn ?? null };   // the turn's own message, where it was said
      const s = { being: x.being, ev: x.ev, chat: x.chat, auto: x.auto, last: now(), what: names(tasks), quiet: false, reply };
      s.out = open(s, working(s.what));
      bg.set(k, s);
      note(`liveness: ${x.being}/${x.ev.chatId} — background task(s) ${s.what} still running, status opened`);
    },
    // A finished task's wake is starting: the being's status message ends on `text`. False: it had none.
    endStatus(being, chatId, text) {
      const k = keyOf(being, chatId);
      const s = bg.get(k);
      if (!s) return false;
      bg.delete(k);
      end(s.out, text);
      return true;
    },
  };
}
