// command-transcript.test.mjs — the LIVE DEFECT (operator, verbatim): "transcript.md is not
// being updated with the command and error back messages from it." conversations/shell/lobby/
// transcript.md recorded three /members lines the operator typed and NOT ONE reply — two of
// those were typos that got usage/error text back, so the record can't reconstruct what
// happened, which is the whole point of a transcript.
//
// WHY: commands.mjs replies via `send?.(ev.chatId, text)` straight to whatever bridge/shellPort
// boot injected — the being-turn path (spine.mjs) is the only caller of transcript.log(ev, reply).
// The FIX (src/spine/boot.mjs, wrapCommandsForTranscript) wraps the ONE `send` function boot
// hands to createCommands, so every command reply is recorded by construction — no per-handler
// change in commands.mjs. `run` is wrapped too, PURELY so `send` can recover the InboundEvent a
// handler never passes it (a handler only ever has chatId, not ev.surface/ev.chatName).
//
// (A) is a direct unit test of wrapCommandsForTranscript itself (boot.mjs) — the generic
// mechanism, multiple-replies-per-run, and the mesh-captured exclusion. (B) wires it exactly as
// boot does, over the REAL createCommands + a REAL createTranscript (fake io/contacts only), to
// prove the full path renders the correct transcript line for a genuine command dispatch.
import { describe, it, expect } from 'vitest';
import { wrapCommandsForTranscript } from '../src/spine/boot.mjs';
import { createCommands } from '../src/spine/commands.mjs';
import { createTranscript } from '../src/spine/transcript.mjs';

// ── (A) the mechanism itself ────────────────────────────────────────────────────────────────
describe('wrapCommandsForTranscript — the mechanism (boot.mjs)', () => {
  function harness() {
    const sent = [];
    const logged = [];
    const rawSend = async (chatId, text) => { sent.push({ chatId, text }); return { ok: true }; };
    const transcript = { log: async (ev, reply) => { logged.push({ ev, reply }); return true; } };
    const { send, wrapRun } = wrapCommandsForTranscript({ send: rawSend, transcript });
    return { sent, logged, send, wrapRun };
  }

  // REPRODUCE-FIRST (documents today's bug at the commands.mjs boundary): a command reply sent
  // through the RAW, unwrapped send never reaches any transcript — there is no second call
  // anywhere. This is the defect the wrap exists to close.
  it('REPRODUCE-FIRST: an unwrapped send leaves no transcript trace of a reply', async () => {
    const sent = [];
    const rawSend = async (chatId, text) => { sent.push({ chatId, text }); };
    await rawSend('c1', 'usage: /foo bar');
    expect(sent).toHaveLength(1);   // the reply WAS sent…
    // …and nothing anywhere recorded it — there is no transcript call to assert on at all,
    // which is exactly the live symptom: the operator's typo replies left zero trace.
  });

  it('a reply sent during a wrapped run() is recorded against that run\'s ev, under the same text', async () => {
    const { sent, logged, send, wrapRun } = harness();
    const ev = { chatId: 'c1', surface: 'whatsapp', chatName: 'fam' };
    const run = wrapRun(async (e) => { await send(e.chatId, 'usage: /foo bar'); });
    await run(ev);
    expect(sent).toEqual([{ chatId: 'c1', text: 'usage: /foo bar' }]);   // still actually sent
    expect(logged).toHaveLength(1);
    expect(logged[0].ev).toBe(ev);
    expect(logged[0].reply).toEqual({ text: 'usage: /foo bar', being: 'system' });
  });

  // THE OPERATOR'S ACTUAL COMPLAINT: an error/usage reply (his typos) is recorded exactly like
  // any other command reply — there is no separate "error" code path in the wrap.
  it('an error/usage reply is recorded — no special-casing by content', async () => {
    const { logged, send, wrapRun } = harness();
    const ev = { chatId: 'c1', surface: 'whatsapp' };
    const run = wrapRun(async (e) => { await send(e.chatId, '/members: unknown mode "all typo" — use disable|mention|all'); });
    await run(ev);
    expect(logged[0].reply.text).toMatch(/unknown mode/);
  });

  // A command that replies MULTIPLE times (e.g. a multi-step wizard) records EACH one, in
  // order — the wrap has no dedupe/collapse, matching the operator's "record everything" ruling.
  it('a command that replies multiple times in one run records each, in order', async () => {
    const { logged, send, wrapRun } = harness();
    const ev = { chatId: 'c1', surface: 'whatsapp' };
    const run = wrapRun(async (e) => {
      await send(e.chatId, 'step 1 of 2');
      await send(e.chatId, 'step 2 of 2');
    });
    await run(ev);
    expect(logged.map((l) => l.reply.text)).toEqual(['step 1 of 2', 'step 2 of 2']);
    expect(logged.every((l) => l.ev === ev)).toBe(true);
  });

  // Two DIFFERENT chats' commands running concurrently must not cross streams — each send is
  // attributed to its OWN run's ev, keyed by chatId (mirrors commands.mjs's own sink Map, which
  // relies on the identical one-in-flight-per-chat assumption).
  it('concurrent runs for different chats never cross', async () => {
    const { logged, send, wrapRun } = harness();
    const evA = { chatId: 'a', surface: 'whatsapp' };
    const evB = { chatId: 'b', surface: 'whatsapp' };
    const runA = wrapRun(async (e) => { await new Promise((r) => setTimeout(r, 10)); await send(e.chatId, 'reply-A'); });
    const runB = wrapRun(async (e) => { await send(e.chatId, 'reply-B'); });
    await Promise.all([runA(evA), runB(evB)]);
    const byChat = Object.fromEntries(logged.map((l) => [l.ev.chatId, l.reply.text]));
    expect(byChat).toEqual({ a: 'reply-A', b: 'reply-B' });
  });

  // A MESH-CAPTURED command reply must NOT be recorded: it is captured into an envelope for a
  // peer node to relay, never posted into this room — outside "everything typed or received in
  // a room" (operator ruling). Modeled directly: send() is never called at all when a sink
  // intercepts first (exactly commands.mjs's own chokepoint shape), so nothing reaches the wrap.
  it('a reply diverted to a capture sink (never reaching send) is never recorded', async () => {
    const { logged, wrapRun } = harness();
    const ev = { chatId: 'c1', surface: 'whatsapp' };
    const capturedLines = [];
    const sink = (t) => capturedLines.push(t);
    // The captured run never calls the wrapped `send` at all — it calls the sink directly,
    // exactly like commands.mjs's `send = (chatId, text) => sink ? sink(t) : rawSend(...)`.
    const run = wrapRun(async () => { sink('captured reply — never posted'); });
    await run(ev);
    expect(capturedLines).toEqual(['captured reply — never posted']);
    expect(logged).toHaveLength(0);
  });
});

// ── (B) wired exactly as boot does, over the real createCommands + a real createTranscript ──
describe('command replies land in transcript.md (real createCommands + real createTranscript)', () => {
  const fakeContacts = { resolve: async () => 'lobby' };
  function mkIo(files) {
    return {
      appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); },
      mkdir: async () => {},
      existsSync: (p) => files.has(p),
    };
  }
  const transcriptText = (files) => [...files.entries()].find(([p]) => p.endsWith('transcript.md'))?.[1] ?? '';

  function buildWiredCommands({ node_name = 'kg' } = {}) {
    const files = new Map();
    const transcript = createTranscript({ contacts: fakeContacts, io: mkIo(files), node_name });
    const sent = [];
    const commandTranscript = wrapCommandsForTranscript({
      send: async (chatId, text) => { sent.push({ chatId, text }); },
      transcript,
    });
    const commands = createCommands({
      getConfig: () => ({ whatsapp: { chat_id: '!self' } }),
      send: commandTranscript.send,
      exit: () => {},
    });
    commands.run = commandTranscript.wrapRun(commands.run);
    return { commands, files, sent };
  }

  const ev = { body: '/foo', chatId: '!self', surface: 'whatsapp', chatName: 'self' };

  it('an unrecognized command\'s catch-all reply is recorded under [@system.<node> …]', async () => {
    const { commands, files, sent } = buildWiredCommands();
    await commands.run(ev);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/recognized/);
    const text = transcriptText(files);
    expect(text).toContain('[@system.kg ');
    expect(text).toContain(sent[0].text);
  });

  it('no node_name → the bare "system" label (back-compat with the reply-line shape)', async () => {
    const { commands, files } = buildWiredCommands({ node_name: null });
    await commands.run(ev);
    const text = transcriptText(files);
    expect(text).toContain('[@system (');
    expect(text).not.toContain('system.');
  });

  // A being's reply (spine.mjs's own transcript.log(ev, {...}) call — nothing to do with
  // commands.mjs) is unaffected and never double-recorded: the two paths never share a call.
  it('a being reply recorded independently is unchanged and not duplicated by a command reply', async () => {
    const { commands, files } = buildWiredCommands();
    // A SECOND transcript service instance over the SAME files map — mirrors production, where
    // spine.mjs's own transcript.log(ev, {...}) call and boot's command-reply wrap are two
    // independent callers of the transcript service, never the same call.
    const beingTranscript = createTranscript({ contacts: fakeContacts, io: mkIo(files), node_name: 'kg' });
    await beingTranscript.log(ev, { text: 'a being reply', being: 'egpt' });
    await commands.run(ev);
    const text = transcriptText(files);
    expect(text.match(/\[@egpt\.kg /g)).toHaveLength(1);     // the being line appears exactly once
    expect(text.match(/\[@system\.kg /g)).toHaveLength(1);   // the command line appears exactly once
  });

  it('inbound recording (transcript.log(ev) with no reply) is untouched by the command wrap', async () => {
    const { files } = buildWiredCommands();
    const transcript = createTranscript({ contacts: fakeContacts, io: mkIo(files), node_name: 'kg' });
    await transcript.log({ ...ev, line: 'An@[self].wa (18:06): /foo', body: '/foo' });
    const text = transcriptText(files);
    expect(text).toContain('/foo');
    expect(text).not.toContain('[@system');   // inbound line only — no reply line synthesized
  });
});
