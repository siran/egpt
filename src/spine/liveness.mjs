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
//     the last post are listed as each ended, the CLI's own verdict, never the being's words (An #2944,
//     2026-10-31: "si termina en error (muy raro) debería mostrar una X y el mensaje de error? esto debe ser
//     estructural, no pongas al SI a determinar el error cuando falla el proceso"): ✓ completed, ✗ failed
//     with the CLI's message, ⏹ stopped, ◦ not known — no success it cannot see. The first is posted when
//     a turn ends leaving work running, as that turn's being, a reply to its own message, as is every
//     later one. A finished task's wake answers in its own placeholder. Once the chat has no work left
//     (one quiet pulse, and no turn running there: a wake may start more), a last post lists what
//     finished — "done" only if all of it completed, else "ended", ⚠️ if any failed; a /standdown's line
//     is posted instead. A task a listed agent launched is listed under it, └, as deep as they go (An #2971,
//     2026-10-31: "are you listing parent and child process in the same level? in that case why not nest?");
//     one whose agent is not in the post stands on its own. The CLI's ambient tasks (watchers — "not
//     activity", its own doc) are in no status and keep none going.
//   · background running ASK_AFTER_MS: the being is asked through the wake path whether it is still
//     needed; no answer → one line to the logging group. Nothing is evicted or killed here.
import { LIVE_FRAME_MARK } from '../dispatch-line.mjs';
import { elapsed } from './sender.mjs';

export const LIVENESS_EVERY_MS = 15_000;       // every live message's pulse (operator 2026-10-16); config liveness.every_ms overrides (read each tick)
export const LIVENESS_BACKGROUND_EVERY_MS = 10 * 60_000;   // a chat's unchanged background status, posted again (operator 2026-10-30); config liveness.background_every_ms overrides (read each tick)
export const ASK_AFTER_MS = 2 * 3_600_000;     // continuous background work this long → ask, then once per interval
export const ASK_ANSWER_MS = 30 * 60_000;      // an ask with no answer by then → the logging group

const STILL_THINKING = `${LIVE_FRAME_MARK} still thinking…`;
// A finished task's mark, by how its session's CLI said it ended; none known → ◦.
const ENDED = { completed: '✓', failed: '✗', stopped: '⏹' };

// A chat's background work as its status says it: each task labelled by its being, unless all of it is
// `being`'s own — the being the line is posted as, whose stamp already says whose it is.
export function workOf(tasks, being, labelOf) {
  const own = tasks.every((t) => t.being === being);
  return tasks.map((t) => (own ? t.description : `${labelOf(t.being)} — ${t.description}`));
}

// `allBackground`: () => [{ being, surface, chatId, taskId, parentTaskId?, ambient?, description, since }] — every live background task,
// in the chat a finished one would wake (boot: the pool's). `outcomeOf`: ({ being, chatId, taskId }) =>
// { status, message } | null — how a finished one ended, as its session's CLI said it (boot: the pool's).
export function createLiveness({ sender, allBackground = null, outcomeOf = null, now, everyMs = () => LIVENESS_EVERY_MS, backgroundEveryMs = () => LIVENESS_BACKGROUND_EVERY_MS, stopped = () => false, labelOf = (b) => b, ask = null, report = null, note = () => {} }) {
  const turns = new Set();     // { out, being, ev, chat, auto, since, last, status }
  const bg = new Map();        // chatId → { being, ev, chat, auto, reply, last, posted, seen, done, quiet, asks }; `being` posts it
  const chatNames = new Map(); // chatId → the chat's name, for the logging-group line
  const names = (tasks) => tasks.map((t) => t.description).join('; ');
  const age = (tasks, t) => t - Math.min(...tasks.map((x) => x.since ?? t));
  const open = (e, label) => sender.open(e.chat, { being: e.being, status: label, auto: e.auto, origin: e.ev.chatId });
  const end = (out, text = null) => Promise.resolve(out?.end?.(text)).catch((err) => note(`liveness: could not settle a status — ${err?.message ?? err}`));
  // A task, across pulses: the session's own id where it has one.
  const keyOf = (x) => `${x.being}\0${x.taskId ?? x.description}\0${x.since}`;
  // The work a status lists: not the CLI's ambient tasks — its doc: "hosts should exclude them from activity indicators".
  const working = () => (allBackground?.() ?? []).filter((x) => !x.ambient);
  // Said once, whole, as the chat's status being, a reply to its turn's message.
  const say = (s, text) => Promise.resolve()
    .then(() => sender.post(s.chat, text, { being: s.being, auto: s.auto, ...s.reply }))
    .catch((err) => note(`liveness: could not post a status — ${err?.message ?? err}`));
  // …and after a finished one, what the CLI said of its failure, or that it was stopped.
  const why = (o) => (o?.status === 'failed' && o.message ? ` — ${o.message}` : o?.status === 'stopped' ? ' — stopped' : '');
  // The chat's status: its running tasks •, those finished since the last post marked as each ended (ENDED),
  // each with its elapsed time, one per line (operator 2026-10-30: "una por línea, con su bullet"), each under
  // the listed agent that launched it, └ (An #2971). The count is every running task, nested ones included.
  // The last says "done" only if all of it completed (An #2944).
  function post(s, running, t) {
    const listed = [...running, ...s.done];
    const what = workOf(listed, s.being, labelOf);
    const parentOf = (x) => (x.parentTaskId ? listed.find((p) => p.being === x.being && p.taskId === x.parentTaskId) : undefined);
    const line = (x, depth) => {
      const i = listed.indexOf(x);
      const mark = i < running.length ? (depth ? '' : '• ') : `${ENDED[x.outcome?.status] ?? '◦'} `;
      const under = listed.filter((c) => parentOf(c) === x).map((c) => line(c, depth + 1)).join('');
      return `\n${depth ? `${'  '.repeat(depth)}└ ` : ''}${mark}${what[i]} · ${elapsed((x.ended ?? t) - x.since)}${why(x.outcome)}${under}`;
    };
    const lines = listed.filter((x) => !parentOf(x)).map((x) => line(x, 0));
    const ok = s.done.every((x) => x.outcome?.status === 'completed'), failed = s.done.some((x) => x.outcome?.status === 'failed');
    const head = running.length ? `⚙️ background work (${running.length}):` : ok ? '✓ background work done:' : `${failed ? '⚠️ ' : ''}background work ended:`;
    s.posted = t;
    s.done = [];
    return say(s, `${head}${lines.join('')}`);
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
      all ??= working();
      const tasks = all.filter((x) => x.chatId === chatId);
      const live = new Set(tasks.map(keyOf));
      let changed = false;
      // gone from the list: how it ended is read now — the CLI said it before it dropped the task
      for (const [k, x] of s.seen) if (!live.has(k)) { s.seen.delete(k); s.done.push({ ...x, ended: t, outcome: outcomeOf?.({ being: x.being, chatId, taskId: x.taskId }) ?? null }); changed = true; }
      for (const x of tasks) if (!s.seen.has(keyOf(x))) { s.seen.set(keyOf(x), { being: x.being, taskId: x.taskId, parentTaskId: x.parentTaskId, description: x.description, since: x.since ?? t }); changed = true; }
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
      const tasks = working().filter((task) => task.chatId === chatId);
      if (!tasks.length) return;
      const reply = { replyTo: x.out?.confirmedId ?? null, replyIn: x.out?.confirmedIn ?? null };   // the turn's own message, where it was said
      const s = { being: x.being, ev: x.ev, chat: x.chat, auto: x.auto, reply, last: t, posted: t, seen: new Map(), done: [], quiet: false, asks: new Map() };
      for (const task of tasks) s.seen.set(keyOf(task), { being: task.being, taskId: task.taskId, parentTaskId: task.parentTaskId, description: task.description, since: task.since ?? t });
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
