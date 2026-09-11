// Locks sandbox-cli-session.mjs: a THIN wrapper over warm-cli-session.mjs's
// resident CLI primitive (Unit 4) that, instead of spawning claude.exe
// directly, spawns powershell.exe running setup/sandbox-logon-launcher.ps1
// (the OS-level isolation for `sandboxed: true`). Same injectable-fake-
// process style as tests/warm-cli-session.test.mjs's fakeClaude() — the fake
// here plays the launcher's role (it's the direct spawn target), speaking
// the identical stream-json protocol claude.exe would, since the launcher's
// whole job is to proxy that protocol through untouched.
import { describe, it, expect, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxCliSession } from '../src/sandbox-cli-session.mjs';

// Hoisted to module scope 2026-09-06: a sandboxed CCODE session now REFUSES to be created
// without the operator's subscription credential (see the last describe in this file), so every
// ccode fixture here has to carry one. codex/pi are deliberately not guarded and still build
// with no token at all.
const TOKEN = 'sk-ant-oat01-FAKE-TEST-TOKEN-NOT-REAL';

// ...and since 2026-09-11 a ccode fixture also has to carry a STORE ROOT, for the same reason:
// creating the session now CREATES ~/.egpt-jsonl/<threadId> before anything is spawned (see
// sandbox-cli-session.mjs's CONFIG_DIR_ENV). Without an override every run of this file would
// litter the operator's real store with a directory per test. Every ccode fixture below passes
// this; codex/pi build no store at all and are unaffected.
const STORE = mkdtempSync(join(tmpdir(), 'egpt-jsonl-fixture-'));
// A PINNED thread for the argv helpers. Left unpinned, each build mints its own uuid and the
// store path — which is now part of the argv — would differ between two builds the byte-equality
// tests below are comparing.
const THREAD = 'thread-fixed';
const THREAD_STORE = join(STORE, THREAD);
afterAll(() => { try { rmSync(STORE, { recursive: true, force: true }); } catch { /* best effort */ } });

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
    const s = createSandboxCliSession({ spawn: f.spawn, cwd, platform: 'win32', sandboxOauthToken: TOKEN, jsonlStoreRoot: STORE });
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
    const s = createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'win32', sandboxOauthToken: TOKEN, jsonlStoreRoot: STORE });
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
    const make = () => createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), sandboxOauthToken: TOKEN, jsonlStoreRoot: STORE });
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
//    THE INVARIANT THESE LOCK is not "a -SetEnv appears" — it is that adding the token moves
//    NOTHING ELSE in the launcher argv. So the with-token argv is asserted AGAINST the no-token
//    argv (a real array comparison), never against a hand-copied literal that could drift with
//    the caller.
//
//    THE NO-TOKEN BASELINE MOVED TO `pi` ON 2026-09-06. A ccode session can no longer be built
//    without a token at all — it throws, actionably (last describe in this file) — but -SetEnv
//    is inserted by sandboxSpawn, which is engine-independent, so a pi session exercises the
//    IDENTICAL argv build and still yields a real no-token baseline to diff against. ──
describe('sandbox-cli-session — -SetEnv CLAUDE_CODE_OAUTH_TOKEN (config sandbox_oauth_token)', () => {
  // One turn through the fake launcher; returns the psArgs it was spawned with.
  async function argvFor(extra = {}) {
    const f = fakeLauncherSpawn();
    const s = createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'win32', sandboxOauthToken: TOKEN, jsonlStoreRoot: STORE, sessionId: THREAD, ...extra });
    await s.turn('hi');
    s.close();
    expect(f.spawnCount()).toBe(1);
    return f.calls[0].args;
  }

  // The unguarded engine, so the no-token half of the diff is buildable. pi does not speak the
  // stream-json fake above, so the spawn is read SYNCHRONOUSLY — same technique as the codex/pi
  // tests further up: warm/codex/pi all spawn inside turn() before returning the promise.
  function piArgvFor(extra = {}) {
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
    // sessionId PINNED: pi mints a random UUID into its own `--session-id` when the caller
    // leaves it null (pi-cli-session.mjs line 110), which would make two argv builds differ by
    // that one element and break the byte comparison this helper exists for.
    const s = createSandboxCliSession({ spawn, cwd: process.cwd(), platform: 'win32', engine: 'pi', sessionId: 'sess-pinned', ...extra });
    s.turn('hi').catch(() => {});
    s.close();
    expect(calls.length).toBe(1);
    return calls[0].args;
  }

  it('with NO token there is no -SetEnv at all, and -TargetFolder is still followed straight by -InnerBin', () => {
    const args = piArgvFor();
    expect(args).not.toContain('-SetEnv');
    const tfIdx = args.indexOf('-TargetFolder');
    expect(args[tfIdx + 2]).toBe('-InnerBin');   // nothing inserted between them
  });

  it('a token inserts EXACTLY [-SetEnv, ["CLAUDE_CODE_OAUTH_TOKEN=<value>"]] before -InnerBin — and changes nothing else', () => {
    const plain = piArgvFor();
    const withTok = piArgvFor({ sandboxOauthToken: TOKEN });

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
  });

  it('the ccode argv carries ONE -SetEnv element — the token AND this thread\'s store — and its inner argv is still the stream-json one', async () => {
    const args = await argvFor();
    // TWO entries since 2026-09-11, still ONE argv element: a ccode turn is handed its
    // credential and the CLAUDE_CONFIG_DIR of its own jsonl store (see sandbox-cli-session.mjs).
    // A second -SetEnv FLAG would be the bug; a second entry inside the one JSON array is not.
    expect(jsonArgOf(args, '-SetEnv')).toEqual([
      `CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`,
      `CLAUDE_CONFIG_DIR=${THREAD_STORE}`,
    ]);
    expect(args[args.indexOf('-SetEnv') + 2]).toBe('-InnerBin');
    expect(innerArgvOf(args)[0]).toBe('--input-format');
  });

  it('a blank, whitespace-only or non-string token is NOT a credential on the unguarded engines either', () => {
    const plain = piArgvFor();
    for (const junk of ['', '   ', null, undefined, 0, false, {}, ['x']]) {
      expect(piArgvFor({ sandboxOauthToken: junk }), `sandboxOauthToken=${JSON.stringify(junk)} changed the argv`).toEqual(plain);
    }
  });

  it('THE VALUE IS NEVER LOGGED: nothing the session emits through onLog contains the token', async () => {
    const f = fakeLauncherSpawn();
    const logs = [];
    const s = createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'win32', sandboxOauthToken: TOKEN, jsonlStoreRoot: STORE, onLog: (l) => logs.push(String(l)) });
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
      const s = createSandboxCliSession({ spawn, cwd: process.cwd(), engine, platform: 'win32', sandboxOauthToken: TOKEN, jsonlStoreRoot: STORE });
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
  // sandboxOauthToken is a FIXTURE here, not the subject: a ccode session cannot be built
  // without one since 2026-09-06. It is constant across every argv this helper returns, so the
  // "changed the argv" comparisons below still isolate the thing each test is about.
  async function argvFor(extra = {}) {
    const f = fakeLauncherSpawn();
    const s = createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'win32', sandboxOauthToken: TOKEN, jsonlStoreRoot: STORE, sessionId: THREAD, ...extra });
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
    // The thread's own store is a THIRD entry in the same one element, appended after the
    // being's own paths (2026-09-11) — it needs the identical per-path ACE, so it rides the
    // identical list rather than growing a second mechanism.
    expect(jsonArgOf(args, '-SharePath')).toEqual(['C:\\shared\\one', 'C:\\shared\\two', THREAD_STORE]);
    const inner = innerArgvOf(args);
    expect(inner).not.toContain('C:\\shared\\two');   // the old shape dropped it exactly here
    expect(inner[0]).toBe('--input-format');
    // one flag, one value, then the next flag — nothing loose between them. (The next flag is
    // -SetEnv rather than -InnerBin since 2026-09-06: the helper always supplies a token now,
    // because a ccode session without one is refused.)
    const spIdx = args.indexOf('-SharePath');
    expect(args[spIdx + 2]).toBe('-SetEnv');
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

  it('REPRODUCE-FIRST: with no share paths of its own a ccode turn shares ONLY its thread store, and junk is not a share path either', async () => {
    // WAS "no -SharePath at all" until 2026-09-11. A ccode turn now always has exactly one
    // shared path — the jsonl store its own memory lives in — so the invariant this test exists
    // for moved rather than went away: junk in `sandboxSharePaths` still contributes NOTHING,
    // and the argv is byte-identical whichever flavour of junk is passed.
    const plain = await argvFor();
    expect(jsonArgOf(plain, '-SharePath')).toEqual([THREAD_STORE]);
    for (const junk of [undefined, [], ['', '   '], 'C:\\not-an-array', null, [null, 42, {}]]) {
      expect(await argvFor({ sandboxSharePaths: junk }), `sandboxSharePaths=${JSON.stringify(junk)} changed the argv`).toEqual(plain);
    }
  });

  it("the store ROOT is never shared — only this thread's own directory under it", async () => {
    // Granting ~/.egpt-jsonl itself would hand every lease every OTHER thread's transcripts,
    // which is the one thing the per-thread ACE exists to prevent. VERIFIED against the real
    // launcher on 2026-09-11: a pool account granted one thread's directory read it, and got
    // "Access is denied" on a sibling thread and "File Not Found" listing the root.
    const shares = jsonArgOf(await argvFor(), '-SharePath');
    expect(shares).toEqual([THREAD_STORE]);
    expect(shares).not.toContain(STORE);
  });

  it('share paths are trimmed and de-duplicated, in declaration order (one ACE per path, never two on the same one)', async () => {
    const args = await argvFor({ sandboxSharePaths: ['  C:\\a  ', 'C:\\b', 'C:\\a', '', 42] });
    expect(jsonArgOf(args, '-SharePath')).toEqual(['C:\\a', 'C:\\b', THREAD_STORE]);
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

// ── THE CREDENTIAL IS GONE (operator 2026-09-06). `sandbox_oauth_token` is the ONLY credential
//    a sandboxed turn has, and it is STATIC: unlike the operator's own ~/.claude login (refresh
//    token, rotates every ~12h) it cannot renew itself, so when it lapses EVERY sandboxed being
//    on the node dies at the same moment — 38 conversations across 16 pool accounts the day
//    before this was written — and the operator's only clue was whatever the CLI happened to
//    say. These lock the two failures and, above all, that the REMEDY travels inside the error
//    itself: mint it as `an`, subscription not API key, into each node's own config.yaml, then
//    setup\upgrade.ps1 once per node.
//
//    NEITHER MESSAGE MAY EVER CARRY THE TOKEN VALUE (brainpool.mjs: "NEVER LOGGED") — presence
//    and LENGTH only. Asserted at the bottom of this block. ──
describe('sandbox-cli-session — a missing or rejected sandbox_oauth_token tells the operator how to mint a new one', () => {
  // Every clause the operator needs at 2am, checked one by one, so a reworded message that
  // silently drops the mint command, the node paths or the redeploy line fails HERE.
  function expectRemedy(text) {
    expect(text, 'the mint command is not in the message').toContain('claude setup-token');
    expect(text, 'nothing says WHICH account to mint it on').toContain('`an`');
    expect(text, 'nothing warns that a pool account is the wrong place').toContain('egpt-sbx-NN');
    expect(text, 'nothing says it is a subscription token, not an API key').toContain('sk-ant-api');
    expect(text, 'the config key is not named').toContain('sandbox_oauth_token');
    expect(text, "node 1's config path is missing").toContain('~/.egpt/config/config.yaml');
    expect(text, "node 2's config path is missing").toContain('~/.egpt-secondary/config/config.yaml');
    expect(text, 'the redeploy command is missing').toContain('powershell -ExecutionPolicy Bypass -File setup\\upgrade.ps1');
    expect(text, "the second node's redeploy is missing").toContain('-EgptHome "$env:USERPROFILE\\.egpt-secondary"');
    expect(text, 'nothing explains WHY it happened (a static credential that cannot refresh)').toMatch(/STATIC and cannot refresh/);
  }

  // ── CASE A: absent or blank ──
  it('REPRODUCE-FIRST: a sandboxed ccode session with NO token throws the actionable error, WITHOUT spawning anything', () => {
    const f = fakeLauncherSpawn();
    let err = null;
    try { createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'win32' }); } catch (e) { err = e; }
    expect(err, 'a sandboxed ccode session was created with no credential at all').toBeTruthy();
    expect(err.message).toContain('sandbox_oauth_token');
    expectRemedy(err.message);
    expect(f.spawnCount(), 'the turn was spawned anyway — the whole point is to fail BEFORE the launcher').toBe(0);
  });

  it('blank, whitespace-only and non-string tokens are all "no credential", and all throw the same way', () => {
    for (const junk of [undefined, '', '   ', '\t\n', null, 0, false, {}, ['x']]) {
      const f = fakeLauncherSpawn();
      let err = null;
      try { createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'win32', sandboxOauthToken: junk }); } catch (e) { err = e; }
      expect(err, `sandboxOauthToken=${JSON.stringify(junk)} was accepted as a credential`).toBeTruthy();
      expectRemedy(err.message);
      expect(f.spawnCount()).toBe(0);
    }
  });

  it('the guard runs AFTER the engine and platform guards, so those keep their own diagnosis', () => {
    const f = fakeLauncherSpawn();
    expect(() => createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'win32', engine: 'llama' })).toThrow(/engine=llama/);
    expect(() => createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'linux' })).toThrow(/Windows-only/);
    expect(f.spawnCount()).toBe(0);
  });

  it('codex and pi are NOT refused: CLAUDE_CODE_OAUTH_TOKEN is not their credential, so they behave exactly as before', () => {
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
      const s = createSandboxCliSession({ spawn, cwd: process.cwd(), platform: 'win32', engine });
      s.turn('hi').catch(() => {});
      expect(calls.length, `engine ${engine} was refused for want of a ccode credential`).toBe(1);
      expect(calls[0].args, `engine ${engine} gained a -SetEnv out of nowhere`).not.toContain('-SetEnv');
      s.close();
    }
  });

  // ── CASE B: present, and the API refused it ──
  //
  //    THE FIXTURE IS MEASURED OUTPUT, not a guess. claude.exe 2.1.263, fresh profile, a
  //    deliberately invalid CLAUDE_CODE_OAUTH_TOKEN, the same argv warm-cli-session.mjs sends:
  //    stderr was EMPTY (0 bytes) and the failure arrived on stdout as the FINAL result event,
  //    subtype "success" with is_error/api_error_status alongside — so the turn RESOLVES, and
  //    its text is what the being posts into the chat. That resolved text is the only place the
  //    remedy can be attached.
  const REJECTED = 'Failed to authenticate. API Error: 401 OAuth access token is invalid.';

  function fakeApiResult(resultEvent) {
    const calls = [];
    const spawn = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
      proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
      proc.stdin = {
        write: () => { setImmediate(() => proc.stdout.emit('data', JSON.stringify(resultEvent) + '\n')); },
        end: () => {},
      };
      proc.kill = () => {};
      return proc;
    };
    return { spawn, calls };
  }

  const rejectedEvent = {
    type: 'result', subtype: 'success', is_error: true, api_error_status: 401,
    session_id: 'sess-401', terminal_reason: 'api_error', result: REJECTED,
  };

  it("REPRODUCE-FIRST: a 401-rejected sandboxed turn comes back with the remedy stapled to the CLI's own sentence", async () => {
    const f = fakeApiResult(rejectedEvent);
    const s = createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'win32', sandboxOauthToken: TOKEN, jsonlStoreRoot: STORE });
    const r = await s.turn('hi');
    expect(r.text.startsWith(REJECTED), 'the vendor sentence was replaced instead of appended to').toBe(true);
    expectRemedy(r.text);
    expect(r.text).toContain('REJECTED');
    expect(r.text, 'the LENGTH is what distinguishes "set but wrong" from "blank"').toContain(`(${TOKEN.length} characters)`);
    expect(r.sessionId, 'wrapping turn() must not break the sessionId getter').toBe('sess-401');
    s.close();
  });

  it('an ordinary reply is returned untouched — the matcher needs BOTH a 401 and the OAuth wording', async () => {
    for (const result of [
      'Sure, here is the answer.',
      'The server replied 401 Unauthorized for that URL.',   // a 401 the MODEL is talking about
      'OAuth is a delegated authorization framework.',       // OAuth, no 401
    ]) {
      const f = fakeApiResult({ type: 'result', subtype: 'success', session_id: 's', result });
      const s = createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'win32', sandboxOauthToken: TOKEN, jsonlStoreRoot: STORE });
      expect((await s.turn('hi')).text, `a remedy was appended to an innocent reply: ${result}`).toBe(result);
      s.close();
    }
  });

  it('NEITHER message ever contains the token VALUE — only its length', async () => {
    let caseA = '';
    try { createSandboxCliSession({ spawn: fakeLauncherSpawn().spawn, cwd: process.cwd(), platform: 'win32', jsonlStoreRoot: STORE }); } catch (e) { caseA = e.message; }
    const f = fakeApiResult(rejectedEvent);
    const s = createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'win32', sandboxOauthToken: TOKEN, jsonlStoreRoot: STORE });
    const caseB = (await s.turn('hi')).text;
    s.close();
    for (const [name, text] of [['case A', caseA], ['case B', caseB]]) {
      expect(text.length, `${name} produced no message`).toBeGreaterThan(0);
      expect(text, `${name} leaked the token value`).not.toContain(TOKEN);
      expect(text, `${name} leaked a slice of the token value`).not.toContain(TOKEN.slice(0, 16));
    }
  });
});
