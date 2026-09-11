// REPRODUCE-FIRST for the SANDBOXED-MEMORY DEFECT (live since 2026-09-05, commit 856a2fb).
//
// THE DEFECT, established by measurement before this file was written:
// setup/sandbox-logon-launcher.ps1 step (f) calls Clear-SandboxProfileContents on EVERY lease
// acquire, which recursively empties C:\Users\egpt-sbx-NN\. That directory is where the leased
// account's `claude` keeps .claude\projects\<slug>\<session>.jsonl -- the CLI's OWN session
// store. So every cold start of a sandboxed being deletes the transcript it is about to
// `--resume`, the resume is refused, the pool evicts, and brainpool retries FRESH with a new
// thread. Counted on this node: pool profiles hold 0-1 session files each, the operator's own
// store holds 568 (the CLI does not garbage-collect -- this is deletion). Before 856a2fb: 116
// resume spawns, 0 dead. After: every sandboxed resume dies. `wren`, the one being with
// `sandboxed: false`, is 5 resumes / 0 dead in the same window.
//
// THE SCRUB IS CORRECT AND STAYS TOTAL (operator ruling, recorded in the launcher's own header:
// "the account profile is SCRATCH, the conversation folder is the only durable storage"). Pool
// accounts are reused across DIFFERENT conversations, so anything left behind leaks to whoever
// leases that account next. There is no exemption to add. The fix is to stop keeping durable
// state there at all.
//
// THE FIX THESE TESTS LOCK (operator 2026-09-11): the CLI's store moves OUT of the pool profile
// and OUT of the conversation folder, to ~/.egpt-jsonl/<thread>/, pointed at by
// CLAUDE_CONFIG_DIR -- which relocates projects/, sessions/ and .claude.json wholesale
// (re-measured 2026-09-11 against claude.exe 2.1.265). It is one more entry in the -SetEnv JSON
// array sandbox-cli-session.mjs already builds, and one more -SharePath entry so the leased
// account gets a per-turn ACE on THAT THREAD'S directory and nothing else.
//
// NOT the conversation folder: `/agents reset` archives the whole conversation folder and would
// take the store with it. Keyed by THREAD the lifecycle is exactly right -- `rethread` mints a
// new id and naturally gets a fresh store, `reset` orphans the old one, ordinary turns reuse it.
//
// STATUS AT THE TIME OF WRITING: these tests FAIL. The first turn of a new thread has no id yet
// (the CLI mints it), and the approved staging-dir + rename-on-session_id scheme was MEASURED
// UNSAFE on this box: the rename SUCCEEDS, and the running CLI then RE-CREATES the staging path
// and splits the store across two directories (12466b in the renamed dir, 4127b in the
// recreated one, same session, one process). That is the STOP condition; the remaining question
// is with the operator. This file is the contract the fix has to satisfy either way.
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandboxCliSession } from '../src/sandbox-cli-session.mjs';
import { createWarmCliSession } from '../src/warm-cli-session.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'sk-ant-oat01-FAKE-TEST-TOKEN-NOT-REAL';

// The same stream-json fake the rest of the sandbox suite uses: it plays the LAUNCHER, which is
// the direct spawn target, since the launcher's whole job is to proxy claude's protocol through
// untouched.
//
// IT REPORTS BACK THE ID IT WAS GIVEN, and that is the measured behaviour of the real thing, not
// a convenience: run against claude.exe 2.1.265 on 2026-09-11, `--session-id <uuid>` came back
// as `session_id: <that same uuid>` in the init event, and `--resume <uuid>` likewise. A fake
// that invented its own id instead would hide the whole point of minting one.
function fakeLauncherSpawn({ sessionId = 'sess-123' } = {}) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    let turnNo = 0;
    const inner = JSON.parse(args[args.indexOf('-InnerArgs') + 1]);
    const pinned = ['--session-id', '--resume']
      .map((f) => (inner.indexOf(f) >= 0 ? inner[inner.indexOf(f) + 1] : null))
      .find((v) => typeof v === 'string' && v);
    const reported = pinned || sessionId;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
    proc.kill = () => {};
    proc.stdin = {
      write: (line) => {
        const text = JSON.parse(line).message.content.map((c) => c.text).join('');
        turnNo++;
        setImmediate(() => {
          if (turnNo === 1) proc.stdout.emit('data', `${JSON.stringify({ type: 'system', subtype: 'init', session_id: reported })}\n`);
          proc.stdout.emit('data', `${JSON.stringify({ type: 'result', subtype: 'success', session_id: reported, result: `echo:${text}` })}\n`);
        });
      },
      end: () => {},
    };
    // `proc` is recorded too, so a test can kill this spawn's process and watch the session
    // re-spawn (see the mid-life respawn lock).
    calls.push({ bin, args, opts, proc });
    return proc;
  };
  return { spawn, calls };
}

function jsonArgOf(args, flag) {
  const i = args.indexOf(flag);
  expect(i, `${flag} is not in the launcher argv`).toBeGreaterThanOrEqual(0);
  expect(args.filter((a) => a === flag), `${flag} appears more than once`).toHaveLength(1);
  return JSON.parse(args[i + 1]);
}
const setEnvOf = (args) => jsonArgOf(args, '-SetEnv');
const sharePathsOf = (args) => (args.includes('-SharePath') ? jsonArgOf(args, '-SharePath') : []);
const innerArgvOf = (args) => jsonArgOf(args, '-InnerArgs');
const configDirOf = (args) => {
  const hit = setEnvOf(args).find((e) => e.startsWith('CLAUDE_CONFIG_DIR='));
  return hit ? hit.slice('CLAUDE_CONFIG_DIR='.length) : null;
};

// ONE COLD START: a brand-new session object (a cold start IS a new process, and a new process
// is a new session object -- brainpool builds one per key and the pool discards it on evict).
async function coldStart(storeRoot, { sessionId = null, minted = 'sess-123', ...extra } = {}) {
  const f = fakeLauncherSpawn({ sessionId: minted });
  const s = createSandboxCliSession({
    spawn: f.spawn, cwd: process.cwd(), platform: 'win32',
    sandboxOauthToken: TOKEN, jsonlStoreRoot: storeRoot, sessionId, ...extra,
  });
  const r = await s.turn('hi');
  s.close();
  expect(f.calls.length).toBe(1);
  return { args: f.calls[0].args, sessionId: r.sessionId };
}

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'egpt-jsonl-'));
  try { return await fn(root); } finally { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } }
}

describe('sandboxed CLI memory — the jsonl store lives at ~/.egpt-jsonl/<thread>, not in the scrubbed pool profile', () => {
  it('REPRODUCE-FIRST: a sandboxed ccode turn points CLAUDE_CONFIG_DIR at <store root>/<thread> — today it names no config dir at all, so the CLI writes into the profile step (f) empties', async () => {
    await withRoot(async (root) => {
      const { args } = await coldStart(root, { sessionId: 'thread-A' });
      const dir = configDirOf(args);
      expect(dir, 'the launcher argv carries no CLAUDE_CONFIG_DIR — the CLI falls back to %USERPROFILE%\\.claude inside the leased pool account, which Clear-SandboxProfileContents empties on every lease acquire').not.toBeNull();
      expect(dir).toBe(join(root, 'thread-A'));
      // ...and the directory is REAL by the time the launcher is spawned: step (d2) skips a
      // -SharePath that does not exist ("share path does not exist - skipping, no ACE granted"),
      // so a store the CLI created later would be a store with no ACE on it.
      expect(existsSync(dir), 'the store directory must exist BEFORE the launcher runs, or step (d2) grants it no ACE').toBe(true);
    });
  });

  it('REPRODUCE-FIRST: two COLD starts on the SAME thread resolve to the SAME store, and the second resumes instead of minting a new thread', async () => {
    await withRoot(async (root) => {
      // TURN 1 OF A FRESH THREAD. The id is OURS, so the store exists before the CLI's first
      // byte: `--session-id` CREATES the session under it, and there is nothing to `--resume`.
      const first = await coldStart(root, { sessionId: null });
      const thread = first.sessionId;
      expect(thread, 'the session must report the id we minted, or brainpool persists nothing to resume').toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
      expect(innerArgvOf(first.args)).toEqual(expect.arrayContaining(['--session-id', thread]));
      expect(innerArgvOf(first.args), 'a fresh thread has nothing to resume — and the CLI refuses both flags together').not.toContain('--resume');
      expect(configDirOf(first.args)).toBe(join(root, thread));

      // THE COLD START AFTER AN EVICT: brainpool hands back the thread id it persisted.
      const second = await coldStart(root, { sessionId: thread });
      expect(configDirOf(second.args), 'turn 1 of a fresh thread and the cold resume of that same thread must land in ONE store, or the resume has nothing to read').toBe(configDirOf(first.args));
      expect(innerArgvOf(second.args)).toEqual(expect.arrayContaining(['--resume', thread]));
      expect(innerArgvOf(second.args), '`--session-id` on an id that already exists is refused outright ("Session ID <id> is already in use.")').not.toContain('--session-id');
    });
  });

  it('a MID-LIFE RESPAWN resumes the live thread instead of minting a fresh one (the CLI died between turns, the session object did not)', async () => {
    await withRoot(async (root) => {
      const f = fakeLauncherSpawn();
      const s = createSandboxCliSession({
        spawn: f.spawn, cwd: process.cwd(), platform: 'win32',
        sandboxOauthToken: TOKEN, jsonlStoreRoot: root, sessionId: null,
      });
      const r1 = await s.turn('one');
      const thread = r1.sessionId;
      // The CLI process dies between turns — warm-cli-session's onClose drops `proc` and the
      // next turn re-spawns. Before 2026-09-11 that rebuilt the argv from the ORIGINAL options,
      // so it re-spawned with no --resume and silently began a SECOND thread.
      f.calls[0].proc.emit('close', 1);
      const r2 = await s.turn('two');
      s.close();

      expect(f.calls.length, 'the dead process must be re-spawned, not reused').toBe(2);
      expect(r2.sessionId).toBe(thread);
      expect(innerArgvOf(f.calls[1].args)).toEqual(expect.arrayContaining(['--resume', thread]));
      expect(innerArgvOf(f.calls[1].args)).not.toContain('--session-id');
      // ...and the re-spawn stays in the SAME store: a second directory here would be a second
      // thread's worth of memory that nothing ever reads again.
      expect(configDirOf(f.calls[1].args)).toBe(configDirOf(f.calls[0].args));
    });
  });

  it('the store is OUTSIDE the pool profile and OUTSIDE the conversation folder (both are wiped — one by the scrub, one by /agents reset)', async () => {
    await withRoot(async (root) => {
      const { args } = await coldStart(root, { sessionId: 'thread-C' });
      const dir = configDirOf(args);
      expect(dir.toLowerCase()).not.toContain(`${sep}egpt-sbx-`.toLowerCase());
      expect(dir.startsWith(process.cwd()), 'the store must not live under the conversation folder — /agents reset archives that whole folder').toBe(false);
      expect(dir.startsWith(root)).toBe(true);
    });
  });

  it("PER-THREAD ACE: the leased account is granted exactly this thread's directory — never the store ROOT, and never another thread's", async () => {
    await withRoot(async (root) => {
      const a = await coldStart(root, { sessionId: 'thread-A' });
      const b = await coldStart(root, { sessionId: 'thread-B' });
      const sharesA = sharePathsOf(a.args).map((p) => p.toLowerCase());
      expect(sharesA).toContain(join(root, 'thread-A').toLowerCase());
      expect(sharesA, "granting the ROOT would hand every lease every thread's transcripts").not.toContain(root.toLowerCase());
      expect(sharesA).not.toContain(join(root, 'thread-B').toLowerCase());
      // ...and the whole argv, not only the share list: thread B must be unnameable from A's turn.
      expect(JSON.stringify(a.args)).not.toContain('thread-B');
      expect(JSON.stringify(b.args)).not.toContain('thread-A');
    });
  });

  it('LOUD FAILURE: a store root that cannot be created refuses the session — it never silently falls back to the scratch profile', () => {
    // A FILE where the root directory must be: mkdir -p cannot succeed, and the fallback that
    // would "work" (leave CLAUDE_CONFIG_DIR unset) is precisely today's bug, invisibly restored.
    const tmp = mkdtempSync(join(tmpdir(), 'egpt-jsonl-'));
    const asFile = join(tmp, 'not-a-dir');
    writeFileSync(asFile, 'x');
    try {
      const fake = fakeLauncherSpawn();
      expect(() => createSandboxCliSession({
        spawn: fake.spawn, cwd: process.cwd(), platform: 'win32',
        sandboxOauthToken: TOKEN, jsonlStoreRoot: asFile, sessionId: 'thread-D',
      })).toThrow(/store|CLAUDE_CONFIG_DIR|jsonl/i);
      expect(fake.calls.length, 'nothing may be spawned once the store is known-unreachable').toBe(0);
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});

describe('sandboxed CLI memory — the locks this fix must not break', () => {
  it('LOCK: the scrub stays TOTAL — step (f) still runs on every lease acquire and still deletes every child of the pool profile', () => {
    const ps1 = readFileSync(join(REPO, 'setup', 'sandbox-logon-launcher.ps1'), 'utf8');
    // Called unconditionally, in the acquire path, before InnerBin.
    expect(ps1).toMatch(/^\s*Clear-SandboxProfileContents -AccountName \$leasedName/m);
    // ...and it still empties EVERYTHING: Get-ChildItem -Force piped straight into Remove-Item,
    // with no -Exclude and no per-path exemption. An exemption here is the one fix that was
    // explicitly ruled out — pool accounts are reused across conversations, so anything spared
    // leaks to whoever leases that account next.
    expect(ps1).toMatch(/Get-ChildItem -LiteralPath `\$r -Force -ErrorAction SilentlyContinue \| Remove-Item -Recurse -Force/);
    expect(ps1).not.toMatch(/-Exclude/);
  });

  it("LOCK: an UNSANDBOXED being is untouched — a plain warm-cli session names no config dir and keeps the operator's own ~/.claude", async () => {
    const calls = [];
    const spawn = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
      proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
      proc.kill = () => {};
      proc.stdin = {
        write: () => setImmediate(() => proc.stdout.emit('data', `${JSON.stringify({ type: 'result', subtype: 'success', session_id: 'wren-1', result: 'ok' })}\n`)),
        end: () => {},
      };
      return proc;
    };
    const s = createWarmCliSession({ spawn, cwd: process.cwd(), sessionId: 'wren-1' });
    await s.turn('hi');
    s.close();
    expect(calls.length).toBe(1);
    expect(JSON.stringify(calls[0].args)).not.toContain('CLAUDE_CONFIG_DIR');
    expect(JSON.stringify(calls[0].args)).not.toContain('.egpt-jsonl');
    // ...and nothing was injected into its environment either: warm-cli-session passes the
    // spawn options through as-is, so `wren` inherits the operator's env and ~/.claude.
    expect(calls[0].opts?.env).toBeUndefined();
  });
});
