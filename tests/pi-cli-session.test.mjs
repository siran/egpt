import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createPiCliSession, imagesFromMessage } from '../src/pi-cli-session.mjs';

// A fake `pi --mode rpc` process: JSONL commands in on stdin, JSONL events out.
function fakePi() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.sent = [];
  proc.stdin = { write: (s) => { proc.sent.push(s); return true; }, end() {} };
  proc.kill = vi.fn();
  proc.emitEvent = (o) => proc.stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n'));
  proc.textDelta = (delta) => proc.emitEvent({
    type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
  });
  return proc;
}
const spawnFake = (proc) => vi.fn(() => proc);

describe('pi cli session (rpc mode)', () => {
  it('satisfies the pool contract', () => {
    const s = createPiCliSession({ spawn: spawnFake(fakePi()) });
    expect(s).toHaveProperty('turn');
    expect(s).toHaveProperty('close');
    expect(s).toHaveProperty('sessionId');
  });

  it('sends a prompt command as one JSONL line', async () => {
    const proc = fakePi();
    const s = createPiCliSession({ spawn: spawnFake(proc) });
    const p = s.turn('hola');
    const line = proc.sent.join('');
    expect(line.endsWith('\n')).toBe(true);
    const cmd = JSON.parse(line.trim());
    expect(cmd.type).toBe('prompt');
    expect(cmd.message).toBe('hola');
    proc.textDelta('hi'); proc.emitEvent({ type: 'agent_settled' });
    await p;
  });

  it('accumulates text_delta and resolves on agent_settled', async () => {
    const proc = fakePi();
    const s = createPiCliSession({ spawn: spawnFake(proc) });
    const p = s.turn('go');
    proc.textDelta('Hello '); proc.textDelta('world');
    proc.emitEvent({ type: 'agent_end' });        // NOT terminal — retry/compaction may follow
    proc.emitEvent({ type: 'agent_settled' });
    expect(await p).toEqual({ text: 'Hello world', sessionId: expect.any(String) });
  });

  // dj-son overflow (2026-08-28). Pi mints its own session and, unpinned, never told
  // us which — so `turn()` reported sessionId:null, brainpool's recordThread never
  // fired, and its next turn resolved sessionId:null again and re-sent the identity
  // kickoff into the same warm process (32 copies of the feed in one session, 25k
  // tokens against a 16k window). The other two engines already report theirs
  // (warm-cli learns session_id off the stream, codex off thread/start).
  it('pins a session id and REPORTS it, so the caller can record the thread', async () => {
    const proc = fakePi();
    const spawn = spawnFake(proc);
    const s = createPiCliSession({ spawn });
    const p = s.turn('go');
    proc.textDelta('ok'); proc.emitEvent({ type: 'agent_settled' });
    const { sessionId } = await p;
    expect(sessionId).toBeTruthy();
    expect(s.sessionId).toBe(sessionId);                     // the pool's re-pin guard reads this
    const args = spawn.mock.calls[0][1];
    expect(args[args.indexOf('--session-id') + 1]).toBe(sessionId);   // and pi runs under it
  });

  it('honours a session id the caller pinned (resume) instead of minting one', async () => {
    const proc = fakePi();
    const spawn = spawnFake(proc);
    const s = createPiCliSession({ spawn, sessionId: 'sid-pinned' });
    const p = s.turn('go');
    proc.emitEvent({ type: 'agent_settled' });
    expect((await p).sessionId).toBe('sid-pinned');
    expect(spawn.mock.calls[0][1]).toContain('sid-pinned');
  });

  it('does not resolve on agent_end alone', async () => {
    const proc = fakePi();
    const s = createPiCliSession({ spawn: spawnFake(proc) });
    let done = false;
    const p = s.turn('go').then((r) => { done = true; return r; });
    proc.textDelta('partial');
    proc.emitEvent({ type: 'agent_end' });
    await new Promise((r) => setImmediate(r));
    expect(done).toBe(false);                      // still waiting — agent_end is not settled
    proc.textDelta(' more');
    proc.emitEvent({ type: 'agent_settled' });
    expect((await p).text).toBe('partial more');
  });

  it('streams partials to onUpdate cumulatively', async () => {
    const proc = fakePi();
    const s = createPiCliSession({ spawn: spawnFake(proc) });
    const seen = [];
    const p = s.turn('go', (t) => seen.push(t));
    proc.textDelta('a'); proc.textDelta('b');
    proc.emitEvent({ type: 'agent_settled' });
    await p;
    expect(seen).toEqual(['a', 'ab']);
  });

  it('splits records on LF ONLY — U+2028 inside a JSON string is not a delimiter', async () => {
    const proc = fakePi();
    const s = createPiCliSession({ spawn: spawnFake(proc) });
    const p = s.turn('go');
    // Node readline would split this line at U+2028 and corrupt the record.
    proc.textDelta('line break');
    proc.emitEvent({ type: 'agent_settled' });
    expect((await p).text).toBe('line break');
  });

  it('tolerates CRLF and split/coalesced chunks', async () => {
    const proc = fakePi();
    const s = createPiCliSession({ spawn: spawnFake(proc) });
    const p = s.turn('go');
    const ev = JSON.stringify({ type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'chunked' } });
    proc.stdout.emit('data', Buffer.from(ev.slice(0, 20)));         // partial record
    proc.stdout.emit('data', Buffer.from(ev.slice(20) + '\r\n'));   // rest, CRLF terminated
    proc.emitEvent({ type: 'agent_settled' });
    expect((await p).text).toBe('chunked');
  });

  it('refuses a concurrent turn and a turn after close', async () => {
    const proc = fakePi();
    const s = createPiCliSession({ spawn: spawnFake(proc) });
    const p = s.turn('one');
    await expect(s.turn('two')).rejects.toThrow(/already in flight/);
    proc.emitEvent({ type: 'agent_settled' });
    await p;
    s.close();
    expect(proc.kill).toHaveBeenCalled();
    await expect(s.turn('three')).rejects.toThrow(/closed/);
  });

  it('rejects the in-flight turn when pi dies', async () => {
    const proc = fakePi();
    const s = createPiCliSession({ spawn: spawnFake(proc) });
    const p = s.turn('go');
    proc.stderr.emit('data', Buffer.from('boom'));
    proc.emit('exit', 1);
    await expect(p).rejects.toThrow(/pi-cli/);
  });

  it('is WARM: one resident process serves many turns', async () => {
    const proc = fakePi();
    const spawn = spawnFake(proc);
    const s = createPiCliSession({ spawn });

    const t1 = s.turn('first');
    proc.textDelta('one'); proc.emitEvent({ type: 'agent_settled' });
    expect((await t1).text).toBe('one');

    const t2 = s.turn('second');
    proc.textDelta('two'); proc.emitEvent({ type: 'agent_settled' });
    expect((await t2).text).toBe('two');

    // ONE spawn for both turns — the process, and with it pi's conversation
    // state and llama-server's prompt prefix, stay warm between turns.
    expect(spawn).toHaveBeenCalledTimes(1);
    // Both prompts went down the same stdin, with distinct correlation ids.
    const cmds = proc.sent.map((l) => JSON.parse(l.trim()));
    expect(cmds.map((c) => c.message)).toEqual(['first', 'second']);
    expect(new Set(cmds.map((c) => c.id)).size).toBe(2);
  });

  it('accumulator resets between turns — no bleed from the previous reply', async () => {
    const proc = fakePi();
    const s = createPiCliSession({ spawn: spawnFake(proc) });
    const t1 = s.turn('a');
    proc.textDelta('AAA'); proc.emitEvent({ type: 'agent_settled' });
    await t1;
    const t2 = s.turn('b');
    proc.textDelta('BBB'); proc.emitEvent({ type: 'agent_settled' });
    expect((await t2).text).toBe('BBB');
  });

  // The Windows npm launcher is pi.cmd — a SHIM, not a PE image. The sandbox
  // launcher hands InnerBin to CreateProcessWithLogonW as lpApplicationName,
  // which neither searches PATH nor can start a .cmd. So resolve to node.exe +
  // the package's dist/cli.js, exactly as codex-cli-session.mjs does.
  it('resolves an ABSOLUTE node.exe + cli.js, never a bare "pi"', () => {
    const proc = fakePi();
    const spawn = spawnFake(proc);
    createPiCliSession({ spawn }).turn('x');
    const [bin, args] = spawn.mock.calls[0];
    expect(bin).not.toBe('pi');
    expect(bin.toLowerCase()).toContain('node');
    // node flags must precede the script path, and BOTH are required: the CJS
    // entry needs -main, the ESM resolver needs the broader flag.
    expect(args[0]).toBe('--preserve-symlinks');
    expect(args[1]).toBe('--preserve-symlinks-main');
    expect(args[2]).toMatch(/cli\.js$/i);
    expect(args.slice(3)).toEqual(expect.arrayContaining(['--mode', 'rpc']));
  });

  it('writes sessions into the conversation folder, not pi config', () => {
    // The pool has Modify on the conversation dir and ReadAndExecute on
    // ~/.pi/agent -- pi's default session dir is inside the latter.
    const proc = fakePi();
    const spawn = spawnFake(proc);
    createPiCliSession({ spawn, cwd: 'C:/conv/here' }).turn('x');
    const [, args] = spawn.mock.calls[0];
    const i = args.indexOf('--session-dir');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toMatch(/conv/);
  });

  it('forwards eGPT persona + action vocabulary as the system prompt', () => {
    // Without it pi has no idea it is in a chat: it invented an upload_image
    // API rather than using identity.d's /media action.
    const proc = fakePi();
    const spawn = spawnFake(proc);
    createPiCliSession({ spawn, appendSystemPrompt: 'I am eGPT. /media <path> sends a file.' }).turn('x');
    const [, args] = spawn.mock.calls[0];
    const i = args.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toContain('/media');
  });

  it('honours allowed_tools when it names PI tools', () => {
    const proc = fakePi();
    const spawn = spawnFake(proc);
    createPiCliSession({ spawn, allowedTools: ['read', 'bash'] }).turn('x');
    const [, args] = spawn.mock.calls[0];
    expect(args[args.indexOf('--tools') + 1]).toBe('read,bash');
  });

  it("ignores CLAUDE tool names — passing them would leave @p with nothing enabled", () => {
    const proc = fakePi();
    const spawn = spawnFake(proc);
    createPiCliSession({ spawn, allowedTools: ['Read', 'Glob', 'Task'] }).turn('x');
    const [, args] = spawn.mock.calls[0];
    expect(args).not.toContain('--tools');   // pi's own defaults stay on: all seven
  });

  it('an explicit bin still wins, with no prefix', () => {
    const proc = fakePi();
    const spawn = spawnFake(proc);
    createPiCliSession({ spawn, bin: 'C:/custom/pi.exe' }).turn('x');
    const [bin, args] = spawn.mock.calls[0];
    expect(bin).toBe('C:/custom/pi.exe');
    expect(args[0]).toBe('--mode');
  });

  it('passes provider and model through to the spawn', () => {
    const proc = fakePi();
    const spawn = spawnFake(proc);
    createPiCliSession({ spawn, provider: 'reve', model: 'local', bin: 'pi-test' }).turn('x');
    const [bin, args] = spawn.mock.calls[0];
    expect(bin).toBe('pi-test');
    expect(args).toEqual(expect.arrayContaining(['--mode', 'rpc', '--provider', 'reve', '--model', 'local']));
  });

  // Pi BLOCKS on a dialog until the client answers (docs/rpc.md). Ignoring one
  // hangs the turn forever with no output — which is exactly what @p did.
  it('ANSWERS a blocking confirm dialog instead of hanging', async () => {
    const proc = fakePi();
    const s2 = createPiCliSession({ spawn: spawnFake(proc) });
    const p = s2.turn('do a thing');
    proc.emitEvent({ type: 'extension_ui_request', id: 'u1', method: 'confirm', title: 'Run bash?' });
    const reply = JSON.parse(proc.sent.at(-1).trim());
    expect(reply).toEqual({ type: 'extension_ui_response', id: 'u1', confirmed: true });
    proc.textDelta('done'); proc.emitEvent({ type: 'agent_settled' });
    expect((await p).text).toBe('done');
  });

  it('autoApprove:false answers the confirm with a NO — still answers, never hangs', async () => {
    const proc = fakePi();
    const s2 = createPiCliSession({ spawn: spawnFake(proc), autoApprove: false });
    const p = s2.turn('x');
    proc.emitEvent({ type: 'extension_ui_request', id: 'u2', method: 'confirm' });
    expect(JSON.parse(proc.sent.at(-1).trim()).confirmed).toBe(false);
    proc.emitEvent({ type: 'agent_settled' });
    await p;
  });

  it('cancels dialogs that need a human answer (select/input/editor)', async () => {
    const proc = fakePi();
    const s2 = createPiCliSession({ spawn: spawnFake(proc) });
    const p = s2.turn('x');
    proc.emitEvent({ type: 'extension_ui_request', id: 'u3', method: 'select', options: ['a', 'b'] });
    expect(JSON.parse(proc.sent.at(-1).trim())).toEqual({ type: 'extension_ui_response', id: 'u3', cancelled: true });
    proc.emitEvent({ type: 'agent_settled' });
    await p;
  });

  it('forwards images on the prompt command when given', async () => {
    const proc = fakePi();
    const img = { type: 'image', data: 'aGk=', mimeType: 'image/png' };
    const s2 = createPiCliSession({ spawn: spawnFake(proc), images: [img] });
    s2.turn('what is this?');
    const cmd = JSON.parse(proc.sent[0].trim());
    expect(cmd.images).toEqual([img]);
    expect(cmd.message).toBe('what is this?');
  });

  it('omits images entirely when there are none', async () => {
    const proc = fakePi();
    createPiCliSession({ spawn: spawnFake(proc) }).turn('hi');
    expect(JSON.parse(proc.sent[0].trim())).not.toHaveProperty('images');
  });

});

// The bridge writes a saved attachment into the body as
//   (image foo.png) [saved: media/...png]
// and cwd IS the conversation folder, so a turn picks its own images up.
describe('pi cli session — images from the chat', () => {
  const fakeRead = (bytes = 4) => () => Buffer.alloc(bytes, 1);

  it('reads a saved image and base64s it', () => {
    const out = imagesFromMessage('look (image a.png) [saved: media/a.png]', 'C:/conv', { read: fakeRead(3) });
    expect(out).toEqual([{ type: 'image', data: Buffer.alloc(3, 1).toString('base64'), mimeType: 'image/png' }]);
  });

  it('ignores non-image attachments — video/audio never reach the vision head', () => {
    expect(imagesFromMessage('(video v.mp4) [saved: media/v.mp4]', 'C:/conv', { read: fakeRead() })).toEqual([]);
    expect(imagesFromMessage('(document d.pdf) [saved: media/d.pdf]', 'C:/conv', { read: fakeRead() })).toEqual([]);
  });

  it('caps at three — a turn is a message, not an album', () => {
    const body = ['a', 'b', 'c', 'd'].map((n) => `[saved: media/${n}.jpg]`).join(' ');
    expect(imagesFromMessage(body, 'C:/conv', { read: fakeRead() })).toHaveLength(3);
  });

  it('skips an oversized image rather than blowing the context', () => {
    const logs = [];
    const out = imagesFromMessage('[saved: media/huge.png]', 'C:/conv',
      { read: () => Buffer.alloc(7_000_000), log: (m) => logs.push(m) });
    expect(out).toEqual([]);
    expect(logs.join()).toMatch(/too large/);
  });

  it('skips an unreadable file without failing the turn', () => {
    const out = imagesFromMessage('[saved: media/gone.png]', 'C:/conv',
      { read: () => { throw new Error('ENOENT'); } });
    expect(out).toEqual([]);
  });

  it('no cwd, no images — nothing to resolve against', () => {
    expect(imagesFromMessage('[saved: media/a.png]', null, { read: fakeRead() })).toEqual([]);
  });
});
