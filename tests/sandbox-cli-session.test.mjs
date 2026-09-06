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

// THE ARGUMENT CONTRACT, in one helper (rewritten 2026-09-05). Every caller-supplied LIST is
// now exactly ONE argv element holding a JSON array — `-InnerArgs '["--print","--verbose"]'`,
// not a bare trailing tail — so the inner argv is READ BACK, never sliced. See
// setup/sandbox-logon-launcher.ps1's PARAMS header for the three binder defects that forced it.
function jsonArgOf(args, flag) {
  const i = args.indexOf(flag);
  expect(i, `${flag} is not in the launcher argv`).toBeGreaterThanOrEqual(0);
  expect(args.filter((a) => a === flag), `${flag} appears more than once`).toHaveLength(1);
  const raw = args[i + 1];
  expect(typeof raw, `${flag}'s value is not a single string element`).toBe('string');
  const parsed = JSON.parse(raw);   // throws (and fails the test) if it is not valid JSON
  expect(Array.isArray(parsed), `${flag} is not a JSON ARRAY: ${raw}`).toBe(true);
  return parsed;
}

const innerArgvOf = (args) => jsonArgOf(args, '-InnerArgs');

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

    // -InnerArgs IS a literal named flag now, carrying the WHOLE inner argv as ONE argv
    // element holding a JSON array. It replaced ValueFromRemainingArguments precisely because
    // a trailing tail is data the PowerShell binder gets to interpret — and it did: it ate the
    // argv's own `--verbose` into [CmdletBinding()]'s common -Verbose switch.
    expect(call.args).toContain('-InnerArgs');
    const innerArgs = innerArgvOf(call.args);
    expect(innerArgs.length).toBeGreaterThan(0);
    expect(innerArgs[0]).toBe('--input-format');
    expect(innerArgs[1]).toBe('stream-json');
    // ...and NOTHING of the inner argv is loose in the launcher argv any more: the element
    // right after -InnerBin <bin> is the -InnerArgs flag itself.
    expect(call.args[ibIdx + 2]).toBe('-InnerArgs');
    expect(call.args[call.args.indexOf('-InnerArgs') + 2]).toBeUndefined();   // -InnerArgs is last

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
    const innerArgs = innerArgvOf(call.args);
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
    const innerArgs = innerArgvOf(call.args);
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

// ── -SetEnv, THE OPERATOR'S SUBSCRIPTION CREDENTIAL (config sandbox_oauth_token, resolved by
//    brainpool.mjs for a SANDBOXED turn only and handed here as options.sandboxOauthToken).
//
//    THE INVARIANT THESE LOCK is not "a -SetEnv appears" — it is that the NO-TOKEN argv, which
//    is the common case and every sandboxed turn on this node today, did not move by one byte.
//    So the with-token argv is asserted AGAINST the no-token argv (a real array comparison),
//    never against a hand-copied literal that could drift with the caller. ──
describe('sandbox-cli-session — -SetEnv CLAUDE_CODE_OAUTH_TOKEN (config sandbox_oauth_token)', () => {
  const TOKEN = 'sk-ant-oat01-FAKE-TEST-TOKEN-NOT-REAL';

  // One turn through the fake launcher; returns the psArgs it was spawned with.
  async function argvFor(extra = {}) {
    const f = fakeLauncherSpawn();
    const s = createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'win32', ...extra });
    await s.turn('hi');
    s.close();
    expect(f.spawnCount()).toBe(1);
    return f.calls[0].args;
  }

  it('REPRODUCE-FIRST: with NO token there is no -SetEnv at all, and -TargetFolder is still followed straight by -InnerBin', async () => {
    const args = await argvFor();
    expect(args).not.toContain('-SetEnv');
    const tfIdx = args.indexOf('-TargetFolder');
    expect(args[tfIdx + 2]).toBe('-InnerBin');   // nothing inserted between them
  });

  it('a token inserts EXACTLY [-SetEnv, ["CLAUDE_CODE_OAUTH_TOKEN=<value>"]] before -InnerBin — and changes nothing else', async () => {
    const plain = await argvFor();
    const withTok = await argvFor({ sandboxOauthToken: TOKEN });

    const ibIdx = plain.indexOf('-InnerBin');
    const expected = [...plain];
    // ONE argv element, and it is a JSON ARRAY — not the bare `NAME=VALUE` token this used to
    // push. -SetEnv was always a [string[]] on the launcher side, so a second pair would have
    // spilled silently into the inner argv (`-SetEnv X=1 Y=2` -> SetEnv=[X=1], InnerArgs=[Y=2,
    // ...]); there is only one entry today, and the shape now makes a second one safe.
    expected.splice(ibIdx, 0, '-SetEnv', JSON.stringify([`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`]));
    expect(withTok).toEqual(expected);            // the WHOLE argv, not a probe for the flag

    expect(withTok.filter((a) => a === '-SetEnv')).toHaveLength(1);   // never twice
    expect(jsonArgOf(withTok, '-SetEnv')).toEqual([`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`]);
    // ...and the inner argv is untouched by the token's presence:
    expect(innerArgvOf(withTok)).toEqual(innerArgvOf(plain));
    expect(innerArgvOf(withTok)[0]).toBe('--input-format');
  });

  it('a blank, whitespace-only or non-string token is NOT a credential: argv stays byte-identical to the no-token argv', async () => {
    const plain = await argvFor();
    for (const junk of ['', '   ', null, undefined, 0, false, {}, ['x']]) {
      expect(await argvFor({ sandboxOauthToken: junk }), `sandboxOauthToken=${JSON.stringify(junk)} changed the argv`).toEqual(plain);
    }
  });

  it('THE VALUE IS NEVER LOGGED: nothing the session emits through onLog contains the token', async () => {
    const f = fakeLauncherSpawn();
    const logs = [];
    const s = createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'win32', sandboxOauthToken: TOKEN, onLog: (l) => logs.push(String(l)) });
    await s.turn('hi');
    s.close();
    expect(logs.length).toBeGreaterThan(0);                              // the spawn line really was emitted...
    expect(logs.some((l) => l.includes('warm-cli: spawn'))).toBe(true);
    for (const l of logs) expect(l, `a log line leaked the token: ${l}`).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');   // not even the name
  });

  it("engine: 'codex' and 'pi' route through the SAME sandboxSpawn, so both get the -SetEnv too", () => {
    for (const engine of ['codex', 'pi']) {
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
      const s = createSandboxCliSession({ spawn, cwd: process.cwd(), engine, platform: 'win32', sandboxOauthToken: TOKEN });
      s.turn('hi').catch(() => {});
      const seIdx = calls[0].args.indexOf('-SetEnv');
      expect(seIdx, `engine ${engine} lost the -SetEnv`).toBeGreaterThanOrEqual(0);
      expect(jsonArgOf(calls[0].args, '-SetEnv')).toEqual([`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`]);
      expect(calls[0].args[seIdx + 2]).toBe('-InnerBin');
      s.close();
    }
  });
});

// ── THE ARGUMENT CONTRACT (operator 2026-09-05). THREE DEFECTS, ONE ROOT CAUSE: caller-supplied
//    data was reaching PowerShell's PARAMETER BINDER, which then interpreted it. Every list the
//    caller supplies is now exactly ONE argv element holding a JSON array, so the binder sees a
//    flag name and one opaque string and nothing else.
//
//    (1) THE LIVE OUTAGE. `[CmdletBinding()]` enables PowerShell's COMMON parameters and
//        PowerShell prefix-matches them, so the inner argv's own `--verbose` bound the common
//        -Verbose SWITCH: 7 args sent, 6 arrived, and claude died with "When using --print,
//        --output-format=stream-json requires --verbose" BEFORE the model, on every sandboxed
//        ccode turn.
//    (2) MULTI-VALUE SPILL. `-SharePath A B` bound ['A'] and dropped 'B' into the inner argv;
//        `-SharePath A,B` bound the single literal string 'A,B'.
//    (3) THE EMPTY ELEMENT. `--setting-sources ''` — the empty string IS the value — was
//        rejected by the binder and papered over with [AllowEmptyString()].
//
//    These lock the CALLER's half. The launcher's half (ConvertFrom-JsonArgv, and the PS 5.1
//    ConvertFrom-Json array trap it exists for) is exercised by setup/test-sandbox-logon-launcher.ps1. ──
describe('sandbox-cli-session — the launcher argument contract (one argv element per parameter, each a JSON array)', () => {
  async function argvFor(extra = {}) {
    const f = fakeLauncherSpawn();
    const s = createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'win32', ...extra });
    await s.turn('hi');
    s.close();
    expect(f.spawnCount()).toBe(1);
    return f.calls[0].args;
  }

  it('REPRODUCE-FIRST (defect 1, the outage): --verbose reaches the launcher INSIDE -InnerArgs and NEVER as a bare argv token', async () => {
    const args = await argvFor();
    const inner = innerArgvOf(args);
    expect(inner).toContain('--print');
    expect(inner).toContain('--output-format');
    expect(inner).toContain('--verbose');   // claude REQUIRES it alongside --print --output-format stream-json
    // THE FIX, stated as the binder sees it: the binder can only interpret argv ELEMENTS, so no
    // element of the launcher argv may BE a `--flag`. Not one is.
    expect(args).not.toContain('--verbose');
    expect(args.filter((a) => typeof a === 'string' && a.startsWith('--')), 'a `--flag` is loose in the launcher argv where the binder can reach it').toEqual([]);
    // ...and every element of the inner argv really did survive the trip, none eaten:
    expect(inner.length).toBeGreaterThanOrEqual(7);
  });

  it('defect 2: TWO share paths ride in ONE -SharePath element, and neither spills into the inner argv', async () => {
    const args = await argvFor({ sandboxSharePaths: ['C:\\shared\\one', 'C:\\shared\\two'] });
    expect(jsonArgOf(args, '-SharePath')).toEqual(['C:\\shared\\one', 'C:\\shared\\two']);
    const inner = innerArgvOf(args);
    expect(inner).not.toContain('C:\\shared\\two');   // the old shape dropped it exactly here
    expect(inner[0]).toBe('--input-format');
    // one flag, one value, then the next flag — nothing loose between them:
    const spIdx = args.indexOf('-SharePath');
    expect(args[spIdx + 2]).toBe('-InnerBin');
  });

  it('defect 3: an EMPTY argv element survives as an empty ELEMENT of -InnerArgs, and no empty element is ever loose in the launcher argv', async () => {
    const cwd = process.cwd();
    const args = await argvFor({ cwd, confineToDirs: [cwd], allowedTools: ['Read'] });
    const inner = innerArgvOf(args);
    const i = inner.indexOf('--setting-sources');
    expect(i, 'the confined argv no longer carries --setting-sources at all').toBeGreaterThanOrEqual(0);
    expect(inner[i + 1]).toBe('');   // the EMPTY string IS the value — it is what stops a being inheriting the operator's ~/.claude
    expect(args.some((a) => a === ''), 'an empty argv element is loose where the binder can reject it').toBe(false);
  });

  it('every caller-supplied list is EXACTLY ONE argv element — a flag, one value, then the next flag', async () => {
    const args = await argvFor({ sandboxOauthToken: 'sk-ant-oat01-FAKE', sandboxSharePaths: ['C:\\a', 'C:\\b'] });
    expect(args.indexOf('-SharePath')).toBeLessThan(args.indexOf('-SetEnv'));
    expect(args.indexOf('-SetEnv')).toBeLessThan(args.indexOf('-InnerBin'));
    expect(args.indexOf('-InnerBin')).toBeLessThan(args.indexOf('-InnerArgs'));
    for (const flag of ['-SharePath', '-SetEnv', '-InnerArgs']) {
      const next = args[args.indexOf(flag) + 2];
      expect(next === undefined || next.startsWith('-'), `${flag} carries more than one argv value`).toBe(true);
      expect(() => jsonArgOf(args, flag)).not.toThrow();
    }
    expect(args[args.length - 2]).toBe('-InnerArgs');   // the inner argv is the LAST element, and it is one element
  });

  it('REPRODUCE-FIRST: with no share paths there is no -SharePath at all, and junk is not a share path either', async () => {
    const plain = await argvFor();
    expect(plain).not.toContain('-SharePath');
    for (const junk of [undefined, [], ['', '   '], 'C:\\not-an-array', null, [null, 42, {}]]) {
      expect(await argvFor({ sandboxSharePaths: junk }), `sandboxSharePaths=${JSON.stringify(junk)} changed the argv`).toEqual(plain);
    }
  });

  it('share paths are trimmed and de-duplicated, in declaration order (one ACE per path, never two on the same one)', async () => {
    const args = await argvFor({ sandboxSharePaths: ['  C:\\a  ', 'C:\\b', 'C:\\a', '', 42] });
    expect(jsonArgOf(args, '-SharePath')).toEqual(['C:\\a', 'C:\\b']);
  });

  it("engine: 'codex' and 'pi' route through the SAME sandboxSpawn, so both get -SharePath and -InnerArgs in the same shape", () => {
    for (const engine of ['codex', 'pi']) {
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
      const s = createSandboxCliSession({ spawn, cwd: process.cwd(), engine, platform: 'win32', sandboxSharePaths: ['C:\\a', 'C:\\b'] });
      s.turn('hi').catch(() => {});
      expect(jsonArgOf(calls[0].args, '-SharePath'), `engine ${engine} lost the -SharePath`).toEqual(['C:\\a', 'C:\\b']);
      expect(Array.isArray(innerArgvOf(calls[0].args)), `engine ${engine} lost the -InnerArgs JSON`).toBe(true);
      s.close();
    }
  });
});
