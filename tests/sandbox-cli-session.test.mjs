// Locks sandbox-cli-session.mjs: a THIN wrapper over warm-cli-session.mjs's
// resident CLI primitive (Unit 4) that, instead of spawning claude.exe
// directly, spawns powershell.exe running setup/sandbox-logon-launcher.ps1
// (the OS-level isolation for `sandboxed: true`). Same injectable-fake-
// process style as tests/warm-cli-session.test.mjs's fakeClaude() — the fake
// here plays the launcher's role (it's the direct spawn target), speaking
// the identical stream-json protocol claude.exe would, since the launcher's
// whole job is to proxy that protocol through untouched.
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSandboxCliSession } from '../src/sandbox-cli-session.mjs';

function fakeLauncherSpawn({ failOn = null, hang = false, sessionId = 'sess-123' } = {}) {
  let turnNo = 0;
  const calls = [];   // { bin, args, opts }
  const spawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
    proc.killed = false;
    proc.kill = () => { proc.killed = true; };
    proc.stdin = {
      write: (line) => {
        const text = JSON.parse(line).message.content.map((c) => c.text).join('');
        turnNo++;
        if (hang) return;
        setImmediate(() => {
          if (turnNo === 1) proc.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n');
          if (failOn && text.includes(failOn)) {
            proc.stderr.emit('data', 'boom\n');
            proc.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'error_during_execution' }) + '\n');
            return;
          }
          const reply = `echo:${text}`;
          proc.stdout.emit('data', JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply.slice(0, 5) } } }) + '\n');
          proc.stdout.emit('data', JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply.slice(5) } } }) + '\n');
          proc.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', result: reply }) + '\n');
        });
      },
      end: () => {},
    };
    return proc;
  };
  return { spawn, calls, spawnCount: () => calls.length };
}

describe('sandbox-cli-session — wraps warm-cli-session with the OS-isolation launcher', () => {
  it('spawns powershell.exe running the launcher with TargetFolder/InnerBin, not claude.exe directly', async () => {
    const f = fakeLauncherSpawn();
    const cwd = process.cwd();   // must exist — warm-cli-session.mjs's spawnProc validates it
    const s = createSandboxCliSession({ spawn: f.spawn, cwd, platform: 'win32' });
    await s.turn('hi');

    expect(f.spawnCount()).toBe(1);
    const call = f.calls[0];
    expect(call.bin).toBe('powershell.exe');

    const fileIdx = call.args.indexOf('-File');
    expect(fileIdx).toBeGreaterThanOrEqual(0);
    expect(call.args[fileIdx + 1]).toMatch(/sandbox-logon-launcher\.ps1$/);

    const tfIdx = call.args.indexOf('-TargetFolder');
    expect(tfIdx).toBeGreaterThanOrEqual(0);
    expect(call.args[tfIdx + 1]).toBe(cwd);

    const ibIdx = call.args.indexOf('-InnerBin');
    expect(ibIdx).toBeGreaterThanOrEqual(0);
    expect(typeof call.args[ibIdx + 1]).toBe('string');
    expect(call.args[ibIdx + 1].length).toBeGreaterThan(0);

    // No literal -InnerArgs flag: PowerShell's ValueFromRemainingArguments
    // (verified empirically — a named [string[]] array param only ever
    // binds ONE following token) is what collects the trailing claude argv,
    // untouched, one element per array slot.
    expect(call.args).not.toContain('-InnerArgs');
    const innerArgs = call.args.slice(ibIdx + 2);
    expect(innerArgs.length).toBeGreaterThan(0);
    expect(innerArgs[0]).toBe('--input-format');
    expect(innerArgs[1]).toBe('stream-json');

    s.close();
  });

  it('still satisfies turn()/sessionId/streaming exactly like a plain warm-cli-session (thin wrapper)', async () => {
    const f = fakeLauncherSpawn();
    const s = createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'win32' });
    const updates = [];
    const r1 = await s.turn('ONE', (t) => updates.push(t));
    const r2 = await s.turn('TWO');
    expect(r1.text).toBe('echo:ONE');
    expect(r2.text).toBe('echo:TWO');
    expect(r1.sessionId).toBe('sess-123');
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(f.spawnCount()).toBe(1);   // ONE resident powershell/launcher/claude tree serves both turns
    s.close();
  });

  it('throws synchronously for an unsupported engine, without spawning anything', () => {
    const f = fakeLauncherSpawn();
    expect(() => createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), engine: 'llama', platform: 'win32' })).toThrow(/llama/);
    expect(f.spawnCount()).toBe(0);
  });

  // engine: 'codex' — createCodexCliSession's own spawn seam (codex-cli-session.mjs line 62:
  // `const _spawn = options.spawn || nodeSpawn;`) receives sandboxSpawn exactly like
  // createWarmCliSession's does, unmodified. codexCliSession spawns `codex app-server --stdio`,
  // NOT the stream-json protocol the fakeLauncherSpawn() stdin-driven fake above speaks — so
  // this test only asserts on the launcher argv shape, not a full turn.
  it("engine: 'codex' — the launcher wraps codex's `app-server --stdio` argv under powershell.exe", () => {
    const calls = [];
    const spawn = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
      proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
      proc.stdin = { write: () => {}, end: () => {} };
      proc.kill = () => {};
      return proc;
    };
    const cwd = process.cwd();
    const s = createSandboxCliSession({ spawn, cwd, engine: 'codex', platform: 'win32' });
    s.turn('hi').catch(() => {});   // fire the spawn; the app-server never replies here, so the turn itself is left pending/uninspected

    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call.bin).toBe('powershell.exe');
    const ibIdx = call.args.indexOf('-InnerBin');
    expect(ibIdx).toBeGreaterThanOrEqual(0);
    const innerArgs = call.args.slice(ibIdx + 2);
    expect(innerArgs).toContain('app-server');
    expect(innerArgs).toContain('--stdio');

    s.close();
  });

  // engine: 'pi' — createPiCliSession's own spawn seam (pi-cli-session.mjs line 30) likewise
  // receives sandboxSpawn unmodified. pi-cli-session speaks the same LF-delimited JSONL protocol
  // the fakeLauncherSpawn() fixture above was built for stream-json, not pi's — so this fake
  // just replies to the FIRST write with an immediate agent_settled, matching pi-cli-session's
  // own onStdout/handleEvent contract closely enough to resolve turn().
  it("engine: 'pi' — the launcher wraps pi's `--mode rpc --offline` argv, and turn() resolves through it", async () => {
    const calls = [];
    const spawn = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
      proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
      proc.stdin = {
        write: () => {
          setImmediate(() => {
            proc.stdout.emit('data', JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } }) + '\n');
            proc.stdout.emit('data', JSON.stringify({ type: 'agent_settled' }) + '\n');
          });
        },
        end: () => {},
      };
      proc.kill = () => {};
      return proc;
    };
    const cwd = process.cwd();
    const s = createSandboxCliSession({ spawn, cwd, engine: 'pi', platform: 'win32' });
    const r = await s.turn('hi');
    expect(r.text).toBe('hi');

    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call.bin).toBe('powershell.exe');
    const ibIdx = call.args.indexOf('-InnerBin');
    expect(ibIdx).toBeGreaterThanOrEqual(0);
    const innerArgs = call.args.slice(ibIdx + 2);
    expect(innerArgs).toContain('--mode');
    expect(innerArgs).toContain('rpc');
    expect(innerArgs).toContain('--offline');

    s.close();
  });

  // ── PLATFORM GUARD (operator 2026-09-04). Every test above pins `platform: 'win32'`: they lock
  //    the WINDOWS path, which must stay byte-identical, and pinning it is what lets them keep
  //    doing that on a POSIX runner. The seam still DEFAULTS to the real process.platform (last
  //    test below).
  //
  //    A DEFAULT may be platform-aware — brainpool.mjs's `sandboxed` fallback is (unset at both
  //    tiers = true on win32, false elsewhere). AN EXPLICIT REQUEST MAY NOT BE: reaching this
  //    factory at all means some tier said `sandboxed: true`, so on a non-Windows node it must
  //    fail LOUDLY and BEFORE the spawn — never run the being unsandboxed behind a config key
  //    that claims otherwise, and never leak the bare ENOENT naming a shell binary that an
  //    unguarded spawn used to produce. ──
  for (const platform of ['linux', 'darwin']) {
    it(`REPRODUCE-FIRST: an explicit sandboxed:true on ${platform} throws, naming the feature and the fix, WITHOUT spawning`, () => {
      const f = fakeLauncherSpawn();
      let err = null;
      try { createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform }); } catch (e) { err = e; }
      expect(err, `a sandboxed session was created on ${platform}, which has no launcher to run`).toBeTruthy();
      expect(err.message).toContain('sandboxed: true');    // the feature, named by its config key
      expect(err.message).toContain(platform);             // ...and why it cannot run here
      expect(err.message).toContain('Windows-only');
      expect(err.message).toContain('sandboxed: false');   // THE FIX, named in the message itself
      expect(f.spawnCount()).toBe(0);                      // and no ENOENT is possible: nothing was spawned
    });
  }

  it('the platform seam DEFAULTS to the real process.platform (injection is for tests, not a requirement)', () => {
    const f = fakeLauncherSpawn();
    const make = () => createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd() });
    if (process.platform === 'win32') {
      const s = make();                 // the operator's own node: created exactly as before...
      expect(f.spawnCount()).toBe(0);   // ...and still lazy — the launcher spawns on the first turn()
      s.close();
    } else {
      expect(make).toThrow(/Windows-only/);
      expect(f.spawnCount()).toBe(0);
    }
  });
});
