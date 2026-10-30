// liveness.mjs — the chat sees that a being is alive (operator 2026-10-15: "there are turns
// running... perhaps the bridge can maintain an animation"; "bridge must not evict background
// agents on its own ... instead we can prompt model if they're still necessary. if
// unresponsiveness then post in egpt logging group").
//
// Rides the spine's tick (STOP-first). Every message is THE reply path's (sender.open), pulsed with
// the sender's `pulse` and settled with its `end`:
//   · a running turn: its placeholder shows the elapsed time; once the placeholder is past its edit
//     window a status message takes over, rolled to a fresh one each window, ended ✓ with the turn.
//   · background work: ONE status message per chat, listing every being's tasks there (operator 2026-10-30:
//     "group these jobs by chat"). Opened when a turn ends leaving work running — posted as that turn's
//     being, a reply to its own message, as is each rolled one. A finished task's wake does not end it (the
//     wake posts its own placeholder and answers there): the task drops off on the next pulse. Ended ✓ once
//     the chat has no work left, or on a /standdown's line.
//   · background running ASK_AFTER_MS: the being is asked through the wake path whether it is still
//     needed; no answer → one line to the logging group. Nothing is evicted or killed here.
import { LIVE_FRAME_MARK } from '../dispatch-line.mjs';
import { elapsed } from './sender.mjs';

export const LIVENESS_EVERY_MS = 15_000;       // every live message's pulse (operator 2026-10-16); config liveness.every_ms overrides (read each tick)
export const ASK_AFTER_MS = 2 * 3_600_000;     // continuous background work this long → ask, then once per interval
export const ASK_ANSWER_MS = 30 * 60_000;      // an ask with no answer by then → the logging group

const STILL_THINKING = `${LIVE_FRAME_MARK} still thinking…`;

// A chat's background work as its status says it: each task labelled by its being, unless all of it is
// `being`'s own — the being the line is posted as, whose stamp already says whose it is.
export function workOf(tasks, being, labelOf) {
  const own = tasks.every((t) => t.being === being);
  return tasks.map((t) => (own ? t.description : `${labelOf(t.being)} — ${t.description}`));
}

// `allBackground`: () => [{ being, surface, chatId, description, since }] — every live background task, in
// the chat a finished one would wake (boot: the pool's).
export function createLiveness({ sender, allBackground = null, now, everyMs = () => LIVENESS_EVERY_MS, stopped = () => false, labelOf = (b) => b, ask = null, report = null, note = () => {} }) {
  const turns = new Set();     // { out, being, ev, chat, auto, since, last, status }
  const bg = new Map();        // chatId → { out, being, ev, chat, auto, last, what, quiet, reply, asks }; `being` posts it
  const chatNames = new Map(); // chatId → the chat's name, for the logging-group line
  const names = (tasks) => tasks.map((t) => t.description).join('; ');
  const age = (tasks, t) => t - Math.min(...tasks.map((x) => x.since ?? t));
  // the chat's status lists its tasks one per line (operator 2026-10-30: "una por línea, con su bullet"); log lines join them
  const listed = (what) => what.map((x) => `\n• ${x}`).join('');
  const working = (what) => `⚙️ working in background:${listed(what)}`;
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

  // Per being: `tasks` are `being`'s own in the chat of status `s`, and the ask wakes that being.
  function maybeAsk(s, being, tasks, t) {
    const a = s.asks.get(being);
    const ms = age(tasks, t);
    const { surface, chatId } = s.ev;
    if (!ask || ms < ASK_AFTER_MS || (a && (!a.settled || t - a.at < ASK_AFTER_MS))) return;
    if ([...turns].some((x) => x.being === being && x.ev.chatId === chatId)) return;
    const what = names(tasks);
    const rec = { at: t, settled: false, reported: false, text: `${labelOf(being)} in ${chatNames.get(chatId) ?? chatId}: background task(s) ${what} running ${elapsed(ms)}, the being did not answer whether they are still needed.` };
    s.asks.set(being, rec);
    note(`liveness: ${being}/${chatId} — background task(s) ${what} running ${elapsed(ms)}, asking whether still needed`);
    const line = `[egpt] Your background task(s) ${what} have been running for ${elapsed(ms)}. Are they still necessary? Stop any that aren't, and report.`;
    Promise.resolve(ask({ being, surface, chatId, summaries: tasks.map((x) => x.description), line }))
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
    let all = null;
    for (const [chatId, s] of bg) {
      if (t - s.last < every) continue;
      s.last = t;
      all ??= allBackground?.() ?? [];
      const tasks = all.filter((x) => x.chatId === chatId);
      if (!tasks.length) {
        // one quiet tick: a wake may be on its way — and none while a turn runs here: it may start more
        if (!s.quiet || [...turns].some((x) => x.ev.chatId === chatId)) { s.quiet = true; continue; }
        bg.delete(chatId);
        end(s.out, `✓ background work ended:${listed(s.what)}`);
        continue;
      }
      s.quiet = false;
      s.what = workOf(tasks, s.being, labelOf);
      s.out = roll(s.out, s, working(s.what), age(tasks, t));
      for (const being of new Set(tasks.map((x) => x.being))) maybeAsk(s, being, tasks.filter((x) => x.being === being), t);
    }
    for (const s of bg.values()) for (const a of s.asks.values()) if (!a.settled && t - a.at >= ASK_ANSWER_MS) unanswered(a);
  }

  return {
    tick() { try { tick(); } catch (err) { note(`liveness: tick failed — ${err?.message ?? err}`); } },
    // A reply turn is live: its placeholder is pulsed until it ends.
    turnStarted({ out, being, ev, chat, auto = false }) {
      const x = { out, being, ev, chat, auto, since: now(), last: now(), status: null };
      turns.add(x);
      if (ev.chatName) chatNames.set(ev.chatId, ev.chatName);
      return x;
    },
    // …and ended: settle its overflow status; background work left running in its chat gets the chat's ONE status.
    turnEnded(x) {
      if (!x || !turns.delete(x)) return;
      if (x.status) end(x.status, `✓ ${elapsed(now() - x.since)}`);
      const chatId = x.ev.chatId;
      if (bg.has(chatId) || stopped()) return;
      const tasks = (allBackground?.() ?? []).filter((t) => t.chatId === chatId);
      if (!tasks.length) return;
      const reply = { replyTo: x.out?.confirmedId ?? null, replyIn: x.out?.confirmedIn ?? null };   // the turn's own message, where it was said
      const s = { being: x.being, ev: x.ev, chat: x.chat, auto: x.auto, last: now(), what: workOf(tasks, x.being, labelOf), quiet: false, reply, asks: new Map() };
      s.out = open(s, working(s.what));
      bg.set(chatId, s);
      note(`liveness: ${x.being}/${chatId} — background task(s) ${s.what.join('; ')} still running, status opened`);
    },
    // A /standdown ended the chat's work: its status ends on `text`. False: it had none.
    endStatus(chatId, text) {
      const s = bg.get(chatId);
      if (!s) return false;
      bg.delete(chatId);
      end(s.out, text);
      return true;
    },
  };
}
