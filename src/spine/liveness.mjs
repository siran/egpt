// liveness.mjs — the chat sees that a being is alive (operator 2026-10-15: "there are turns
// running... perhaps the bridge can maintain an animation"; "bridge must not evict background
// agents on its own ... instead we can prompt model if they're still necessary. if
// unresponsiveness then post in egpt logging group").
//
// Rides the spine's tick (STOP-first):
//   · a running turn: its placeholder (THE reply path's, sender.open) shows the elapsed time, pulsed with
//     the sender's `pulse`; once the placeholder is past its edit window a status message takes over,
//     rolled to a fresh one each window, settled ✓ with the turn by the sender's `end`.
//   · background work: ONE status per chat, listing every being's tasks there (operator 2026-10-30: "group
//     these jobs by chat"), each with its elapsed time — POSTED, never edited (operator 2026-10-30: "en
//     lugar de editar los mensajes, puedes solo publicar el estatus de todas las tareas en un mensaje cada
//     cierto tiempo"; earlier: "puedes dar updates cada minuto, o cuando terminen"). A fresh message
//     (sender.post) when the chat's task list changes — a task appears or finishes, one post per pulse
//     however many did — else every liveness.background_every_ms while work runs; the tasks finished since
//     the last post are listed ✓. The first is posted when a turn ends leaving work running, as that
//     turn's being, a reply to its own message, as is every later one. A finished task's wake answers in
//     its own placeholder. Once the chat has no work left (one quiet pulse, and no turn running there: a
//     wake may start more), a last post lists what finished; a /standdown's line is posted instead.
//   · background running ASK_AFTER_MS: the being is asked through the wake path whether it is still
//     needed; no answer → one line to the logging group. Nothing is evicted or killed here.
import { LIVE_FRAME_MARK } from '../dispatch-line.mjs';
import { elapsed } from './sender.mjs';

export const LIVENESS_EVERY_MS = 15_000;       // every live message's pulse (operator 2026-10-16); config liveness.every_ms overrides (read each tick)
export const LIVENESS_BACKGROUND_EVERY_MS = 10 * 60_000;   // a chat's unchanged background status, posted again (operator 2026-10-30); config liveness.background_every_ms overrides (read each tick)
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
export function createLiveness({ sender, allBackground = null, now, everyMs = () => LIVENESS_EVERY_MS, backgroundEveryMs = () => LIVENESS_BACKGROUND_EVERY_MS, stopped = () => false, labelOf = (b) => b, ask = null, report = null, note = () => {} }) {
  const turns = new Set();     // { out, being, ev, chat, auto, since, last, status }
  const bg = new Map();        // chatId → { being, ev, chat, auto, reply, last, posted, seen, done, quiet, asks }; `being` posts it
  const chatNames = new Map(); // chatId → the chat's name, for the logging-group line
  const names = (tasks) => tasks.map((t) => t.description).join('; ');
  const age = (tasks, t) => t - Math.min(...tasks.map((x) => x.since ?? t));
  const open = (e, label) => sender.open(e.chat, { being: e.being, status: label, auto: e.auto, origin: e.ev.chatId });
  const end = (out, text = null) => Promise.resolve(out?.end?.(text)).catch((err) => note(`liveness: could not settle a status — ${err?.message ?? err}`));
  // A task, across pulses: the session's own id where it has one.
  const keyOf = (x) => `${x.being}\0${x.taskId ?? x.description}\0${x.since}`;
  // Said once, whole, as the chat's status being, a reply to its turn's message.
  const say = (s, text) => Promise.resolve()
    .then(() => sender.post(s.chat, text, { being: s.being, auto: s.auto, ...s.reply }))
    .catch((err) => note(`liveness: could not post a status — ${err?.message ?? err}`));
  // The chat's status: its running tasks •, those finished since the last post ✓, each with its elapsed time,
  // one per line (operator 2026-10-30: "una por línea, con su bullet").
  function post(s, running, t) {
    const listed = [...running, ...s.done];
    const what = workOf(listed, s.being, labelOf);
    const lines = listed.map((x, i) => `\n${i < running.length ? '•' : '✓'} ${what[i]} · ${elapsed((x.ended ?? t) - x.since)}`);
    s.posted = t;
    s.done = [];
    return say(s, `${running.length ? `⚙️ background work (${running.length}):` : '✓ background work done:'}${lines.join('')}`);
  }

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
      const live = new Set(tasks.map(keyOf));
      let changed = false;
      for (const [k, x] of s.seen) if (!live.has(k)) { s.seen.delete(k); s.done.push({ ...x, ended: t }); changed = true; }
      for (const x of tasks) if (!s.seen.has(keyOf(x))) { s.seen.set(keyOf(x), { being: x.being, description: x.description, since: x.since ?? t }); changed = true; }
      if (!tasks.length) {
        // one quiet pulse: a wake may be on its way — and none while a turn runs here: it may start more
        if (!s.quiet || [...turns].some((x) => x.ev.chatId === chatId)) { s.quiet = true; continue; }
        bg.delete(chatId);
        post(s, [], t);
        continue;
      }
      s.quiet = false;
      if (changed || t - s.posted >= backgroundEveryMs()) post(s, tasks.map((x) => s.seen.get(keyOf(x))), t);
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
      const t = now();
      if (x.status) end(x.status, `✓ ${elapsed(t - x.since)}`);
      const chatId = x.ev.chatId;
      if (bg.has(chatId) || stopped()) return;
      const tasks = (allBackground?.() ?? []).filter((task) => task.chatId === chatId);
      if (!tasks.length) return;
      const reply = { replyTo: x.out?.confirmedId ?? null, replyIn: x.out?.confirmedIn ?? null };   // the turn's own message, where it was said
      const s = { being: x.being, ev: x.ev, chat: x.chat, auto: x.auto, reply, last: t, posted: t, seen: new Map(), done: [], quiet: false, asks: new Map() };
      for (const task of tasks) s.seen.set(keyOf(task), { being: task.being, description: task.description, since: task.since ?? t });
      bg.set(chatId, s);
      post(s, tasks.map((task) => s.seen.get(keyOf(task))), t);
      note(`liveness: ${x.being}/${chatId} — background task(s) ${workOf(tasks, x.being, labelOf).join('; ')} still running, status posted`);
    },
    // A /standdown ended the chat's work: its line is posted as the status was, and nothing follows it.
    // False: the chat had no status (the caller says the line itself).
    async endStatus(chatId, text) {
      const s = bg.get(chatId);
      if (!s) return false;
      bg.delete(chatId);
      await say(s, text);
      return true;
    },
  };
}
