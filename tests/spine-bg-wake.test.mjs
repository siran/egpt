// A BACKGROUND TASK'S RESULT WAKES THE BEING (operator 2026-10-15: "the result of the bg agent
// must wake up E rather than being dropped by the spine. it is an opportunity to prompt or steer
// the model").
//
// Live failure: E handed a long job to a background agent and ended its turn. When the agent
// finished, the CLI started a turn of its own about it — with no turn in flight the warm session
// was not listening, and the result never reached the chat. Now the session lets that turn run
// (stopping it killed the being's other background agents — ED, live 2026-10-30) and reports the
// completion up with its answer (warm-sessions onBackgroundDone); the spine wakes the being with a
// turn like any other: STOP, the loop guard and the gate first, then the conversation's FIFO and
// THE reply path (placeholder, transcript, delivery).
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSpine } from '../src/spine/spine.mjs';
import { createStopGuard } from '../src/stop-guard.mjs';
import { createWarmPool } from '../src/warm-sessions.mjs';
import { createWarmCliSession } from '../src/warm-cli-session.mjs';

const CHAT = 'chat-A@g.us';
const DONE = { being: 'egpt', surface: 'whatsapp', chatId: CHAT, summaries: ['Run the audit — completed'] };

function recordingSender() {
  const placeholders = [];
  return {
    placeholders,
    open(chatId, opts = {}) {
      const ph = { chatId, opts, updates: [], finished: null, failed: null };
      placeholders.push(ph);
      return {
        activate() {},
        update(p) { ph.updates.push(p); },
        async finish(reply, { surface = true } = {}) { ph.finished = { text: typeof reply === 'string' ? reply : reply?.text, surface }; },
        async fail(e) { ph.failed = e?.message ?? String(e); },
        confirmedId: Promise.resolve(null),
      };
    },
  };
}

function build({ brain, mode = 'mention', mayReply = null, guard = null, stopPresent = false } = {}) {
  const sender = recordingSender();
  const logged = [];
  const notes = [];
  const said = [];
  const decided = [];
  const gating = {
    async decide(being, ev, mention) {
      decided.push({ being, mention });
      const ok = mayReply ?? (mode !== 'off' && (mode !== 'mention' || !!(mention?.atEAnywhere || mention?.replyToBot)));
      return { mode, receives: mode !== 'off', mayReply: ok, sendToEgpt: 'mode' };
    },
    surfaces: (d) => d.mayReply,
  };
  const spine = createSpine({
    bridge: { onMessage() {}, send() {}, stop() {} },
    brain,
    identity: { build: (m) => m, spineEvent: async (surface, chatId) => ({ surface, chatId }) },
    router: { resolve: () => ({ being: 'egpt' }) },
    gating,
    sender,
    transcript: { async log(ev, reply) { logged.push({ chatId: ev.chatId, reply: reply ? (reply.text ?? '') : null }); } },
    heartbeats: { runDue() {} },
    guard,
    stopSwitch: { present: () => stopPresent, pull: async () => {} },
    say: async (o) => { said.push(o); return true; },
    clock: { now: () => 1000 },
    log: { line: (s) => notes.push(s) },
  });
  return { spine, sender, logged, notes, said, decided };
}

function stubBrain() {
  const calls = [];
  return { calls, async turn(being, ev) { calls.push({ being, ev }); return { text: `report-${calls.length}`, sessionId: 's1' }; } };
}

// The real warm session over a fake `claude` that behaves as measured on 2.1.301.
function backgroundClaude() {
  const ORIGIN = { kind: 'task-notification', producer: 'session-task', runId: 'r1' };
  let proc = null, inSelf = false;
  const queued = [];
  const lines = [];
  const out = (o) => proc.stdout.emit('data', JSON.stringify(o) + '\n');
  const answer = (text) => {
    out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    out({ type: 'user', isReplay: true, message: { role: 'user', content: [{ type: 'text', text }] } });
    if (text === 'go') out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_agent', description: 'Run the audit' }] });
    const reply = text === 'go' ? 'started' : `checked: ${text.slice(0, 40)}`;
    out({ type: 'result', subtype: 'success', result: reply, session_id: 'sess-1' });
  };
  const spawn = () => {
    proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
    proc.kill = () => {};
    proc.stdin = {
      write: (line) => {
        const o = JSON.parse(line);
        lines.push(o);
        if (o.type === 'control_request') {
          setImmediate(() => {
            if (!inSelf) return;
            inSelf = false;
            out({ type: 'result', subtype: 'error_during_execution', is_error: true, origin: ORIGIN, session_id: 'sess-1' });
            for (const t of queued.splice(0)) answer(t);
          });
          return;
        }
        const text = o.message.content.map((c) => c.text).join('');
        if (inSelf) queued.push(text); else setImmediate(() => answer(text));
      },
      end: () => {},
    };
    return proc;
  };
  const finishBg = () => {
    out({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', summary: 'audit done' });
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    inSelf = true;
    out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    setImmediate(() => {
      if (!inSelf) return;
      inSelf = false;
      out({ type: 'result', subtype: 'success', result: 'the audit found 3 issues', origin: ORIGIN, session_id: 'sess-1' });
    });
  };
  return { spawn, finishBg, lines };
}

describe('spine — a background task\'s result wakes the being', () => {
  it('THE LIVE FAILURE: the CLI reports a finished background agent with no turn in flight → a wake turn reaches the chat through the reply path', async () => {
    const cli = backgroundClaude();
    const KEY = 'egpt:ccode:whatsapp:fam';
    let spine = null;
    const pool = createWarmPool({
      makeSession: (opts) => createWarmCliSession({ ...opts, spawn: cli.spawn }),
      onBackgroundDone: (key, info) => spine.wakeOnBackground({ being: 'egpt', surface: 'whatsapp', chatId: CHAT, ...info }),
    });
    const brain = { async turn(being, ev, onPartial) { return pool.run(KEY, ev.line ?? ev.body, onPartial); } };
    const b = build({ brain });
    spine = b.spine;

    expect((await brain.turn('egpt', { line: 'go' })).text).toBe('started');
    cli.finishBg();
    await vi.waitFor(() => expect(b.sender.placeholders[0]?.finished).toBeTruthy());

    expect(b.sender.placeholders).toHaveLength(1);
    const ph = b.sender.placeholders[0];
    expect(ph.chatId).toBe(CHAT);
    expect(ph.finished.text).toMatch(/^checked: /);
    expect(ph.finished.text).not.toContain('the audit found');   // the chat gets the wake turn's reply
    expect(b.logged).toEqual([{ chatId: CHAT, reply: ph.finished.text }]);
    // The CLI's own turn ran to its end — never interrupted — and its answer is what the being sends.
    expect(cli.lines.some((o) => o.type === 'control_request')).toBe(false);
    const wake = cli.lines.at(-1).message.content[0].text;
    expect(wake).toContain('Run the audit — completed');
    expect(wake).toContain('the audit found 3 issues');
  });

  it('the wake prompt names the finished task and asks for a verified report; the gate sees an addressed turn', async () => {
    const brain = stubBrain();
    const b = build({ brain, mode: 'mention' });
    await b.spine.wakeOnBackground(DONE);
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].being).toBe('egpt');
    expect(brain.calls[0].ev.chatId).toBe(CHAT);
    expect(brain.calls[0].ev.line).toContain('Run the audit — completed');
    expect(brain.calls[0].ev.line).toMatch(/verify/i);
    expect(brain.calls[0].ev.cause).toBe('background');   // agent stats: the system bucket it is counted in
    expect(b.sender.placeholders[0].finished).toEqual({ text: 'report-1', surface: true });
  });

  it('with the CLI\'s own answer on it (ED, live 2026-10-30): the being is handed that answer to send — the task named, no restart claimed', async () => {
    const brain = stubBrain();
    const b = build({ brain, mode: 'mention' });
    await b.spine.wakeOnBackground({ ...DONE, reply: 'The audit passed: 0 issues.' });
    expect(brain.calls).toHaveLength(1);
    const line = brain.calls[0].ev.line;
    expect(line).toContain('Run the audit — completed');
    expect(line).toContain('The audit passed: 0 issues.');
    expect(line).toMatch(/never reached the chat/);
    expect(line).toMatch(/Send it to the chat now/);
    expect(line).not.toMatch(/restart/);
    expect(b.sender.placeholders[0].finished).toEqual({ text: 'report-1', surface: true });
  });

  it('the CLI\'s own answer is a bare polite silence (live 2026-10-30, 3×): the being is NOT woken — answered, nothing to send', async () => {
    for (const reply of ['…', '...', '  … \n']) {
      const brain = stubBrain();
      const b = build({ brain, mode: 'mention' });
      expect(await b.spine.wakeOnBackground({ ...DONE, reply })).toBe(true);
      expect(brain.calls).toHaveLength(0);
      expect(b.sender.placeholders).toHaveLength(0);
      expect(b.notes.some((n) => /answered it with silence — not woken/.test(n))).toBe(true);
    }
  });

  it('an adopted turn\'s reply (no task named) keeps its restart wording', async () => {
    const brain = stubBrain();
    const b = build({ brain, mode: 'mention' });
    await b.spine.wakeOnBackground({ being: 'egpt', surface: 'whatsapp', chatId: CHAT, reply: 'hecho' });
    expect(brain.calls[0].ev.line).toMatch(/written while the bridge restarted/);
    expect(brain.calls[0].ev.line).toContain('hecho');
  });

  it('a turn cut off across a restart (its process died first) wakes the being with that message, through the reply path', async () => {
    const brain = stubBrain();
    const b = build({ brain, mode: 'mention' });
    await b.spine.wakeOnBackground({ being: 'egpt', surface: 'whatsapp', chatId: CHAT, lost: 'revisa el sitio', why: 'claude exited 1 mid-turn' });
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].ev.line).toContain('revisa el sitio');
    expect(brain.calls[0].ev.line).toContain('claude exited 1 mid-turn');
    expect(brain.calls[0].ev.line).toMatch(/Answer it now/);
    expect(b.sender.placeholders[0].finished).toEqual({ text: 'report-1', surface: true });
  });

  it('the STOP file suppresses the wake: no placeholder, no turn', async () => {
    const brain = stubBrain();
    const b = build({ brain, stopPresent: true });
    expect(await b.spine.wakeOnBackground(DONE)).toBe(false);
    expect(brain.calls).toHaveLength(0);
    expect(b.sender.placeholders).toHaveLength(0);
    expect(b.notes.some((n) => /STOP/.test(n))).toBe(true);
  });

  // contract 6.1
  it('a chat whose gate says no reply (off) is not woken', async () => {
    const brain = stubBrain();
    const b = build({ brain, mode: 'off' });
    expect(await b.spine.wakeOnBackground(DONE)).toBe(false);
    expect(brain.calls).toHaveLength(0);
    expect(b.sender.placeholders).toHaveLength(0);
  });

  it('wakes COUNT in the loop guard like any non-human turn: the cap auto-STOPs the chat and the next wake is suppressed', async () => {
    const brain = stubBrain();
    const guard = createStopGuard({ turns: 2, window: 10 });
    const b = build({ brain, guard });
    await b.spine.wakeOnBackground({ ...DONE, summaries: ['job A — completed'] });
    await b.spine.wakeOnBackground({ ...DONE, summaries: ['job B — completed'] });
    expect(guard.blocked(`whatsapp:${CHAT}`)).toBe(true);
    expect(b.said.some((s) => /paused this chat/.test(s.text))).toBe(true);
    expect(await b.spine.wakeOnBackground({ ...DONE, summaries: ['job C — completed'] })).toBe(false);
    expect(brain.calls).toHaveLength(2);
  });
});
