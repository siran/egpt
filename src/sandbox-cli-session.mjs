// sandbox-cli-session.mjs — OS-level process isolation for a `sandboxed: true`
// conversation, layered ON TOP of the existing warm-cli-session.mjs primitive
// (Unit 4) via its `spawn` injection seam (warm-cli-session.mjs line 48:
// `const _spawn = options.spawn || nodeSpawn;`) — NOT a fork of it.
//
// access_level:'all' already grants unconfined Bash / no path confinement at
// the CLI-FLAG level (dangerouslySkipPermissions, see claude-args.mjs). This
// module adds a SEPARATE, OS-level confinement layer underneath that: instead
// of spawning `claude.exe` directly, warm-cli-session.mjs's spawnProc() ends
// up spawning `powershell.exe -File setup/sandbox-logon-launcher.ps1 ...`,
// which LogonUsers the ONE shared unprivileged `egpt-sandbox` account (a
// fresh, unique logon session — and logon SID — every call), grants that
// session's SID a read/write ACE on exactly this conversation's own folder,
// and launches the real claude.exe under that token with stdio proxied
// straight through. See setup/sandbox-logon-launcher.ps1's header for the
// full mechanism + the two verified deviations from the original spec
// (CreateProcessWithTokenW over CreateProcessAsUser; InnerArgs as
// ValueFromRemainingArguments, not a named flag).
//
// warm-cli-session.mjs's spawnProc() already resolves `bin` (full claude.exe
// path) and `args` (the full stream-json argv, via buildClaudeArgs) itself,
// and calls `_spawn(bin, args, spawnOpts)` where spawnOpts is the
// `{ stdio: ['pipe','pipe','pipe'], windowsHide: true, ...(cwd ? { cwd } : {}) }`
// object it builds. sandboxSpawn below receives that fully-formed call
// ready-made — it does NOT recompute bin/args — and just wraps it in the
// powershell.exe/launcher invocation, forwarding spawnOpts UNCHANGED (so the
// launcher's own stdio is exactly what warm-cli-session.mjs expects claude's
// stdio to be, and it runs from the same cwd).
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createWarmCliSession } from './warm-cli-session.mjs';
import { createCodexCliSession } from './codex-cli-session.mjs';
import { createPiCliSession } from './pi-cli-session.mjs';

const LAUNCHER_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'setup', 'sandbox-logon-launcher.ps1');

// THE ONE variable a sandboxed turn is ever handed, and the only reason the launcher's
// -SetEnv flag is ever passed: the operator's Claude SUBSCRIPTION credential — a long-lived
// OAuth token from `claude setup-token`, NOT an API key. config.yaml carries it as
// `sandbox_oauth_token` and brainpool.mjs resolves it FOR A SANDBOXED SESSION ONLY (a
// non-sandboxed turn runs as the operator's own account and reads ~/.claude directly, so it
// needs nothing from here).
//
// It cannot come from the sandboxed account's own profile: the turn runs as a leased pool
// account (egpt-sbx-NN) whose profile is empty and which is denied the operator's
// ~/.claude/.credentials.json by the very ACLs that make the sandbox a sandbox. -SetEnv puts
// the value in THAT child's environment block and nowhere else — not in the pool account's
// profile, where the NEXT lease of that account would inherit it, and not in a machine-wide
// variable, where every process on the box would see it.
const OAUTH_ENV_NAME = 'CLAUDE_CODE_OAUTH_TOKEN';

export function createSandboxCliSession(options = {}) {
  // sandboxed:true wraps whichever CLI engine's own session primitive spawns a
  // process — ccode (claude.exe), codex (app-server), or pi (--mode rpc) — all
  // three go through the identical `options.spawn || nodeSpawn` DI seam
  // (warm-cli-session.mjs, codex-cli-session.mjs, pi-cli-session.mjs), so
  // sandboxSpawn below wraps any of them unmodified. Mirrors brain-session.mjs's
  // engine dispatch exactly. Any OTHER engine throws here, before the inner
  // session is ever created, so a misconfigured being fails loudly instead of
  // silently running unsandboxed.
  const engine = options.engine ?? 'ccode';
  if (engine !== 'ccode' && engine !== 'claude-code' && engine !== 'codex' && engine !== 'pi') {
    throw new Error(`sandboxed: true does not support engine=${engine} (supported: ccode/claude-code, codex, pi)`);
  }

  // ...and the SAME loud-failure rule for the PLATFORM (operator 2026-09-04). The launcher this
  // module wraps is Windows machinery (LogonUser + CreateProcessWithTokenW + a per-folder ACE),
  // so off win32 there is simply nothing to run: before this guard we spawned it anyway and the
  // caller got a bare ENOENT naming a shell binary rather than the feature that failed.
  //
  // Note the ASYMMETRY with brainpool.mjs's `sandboxed` resolution, which IS platform-aware
  // (unset at both tiers => true on win32, false elsewhere). A DEFAULT may be platform-aware
  // because nobody asked for it. AN EXPLICIT REQUEST MAY NOT BE SILENTLY DOWNGRADED: reaching
  // this factory at all means some tier said `sandboxed: true`, so we refuse rather than quietly
  // run the being unsandboxed behind a config key that claims otherwise. Thrown BEFORE the inner
  // session exists — and therefore before any spawn — exactly like the engine check above.
  const platform = options.platform ?? process.platform;   // injectable for tests, same DI convention as `spawn` below
  if (platform !== 'win32') {
    throw new Error(`sandboxed: true does not support platform=${platform} — OS-level sandboxing is Windows-only on this build (set \`sandboxed: false\` for this agent, or run this node on Windows)`);
  }

  const _spawn = options.spawn || nodeSpawn;   // injectable for tests, same DI convention as warm-cli-session.mjs

  // Normalised ONCE, here, so sandboxSpawn stays a pure argv build: a non-string, an empty
  // string and an all-whitespace string all collapse to '' = "no credential", and the psArgs
  // spread below then contributes ZERO elements. Read from options like every other field —
  // brainpool.mjs only puts it there when the being actually resolved `sandboxed: true`.
  const oauthToken = typeof options.sandboxOauthToken === 'string' ? options.sandboxOauthToken.trim() : '';

  function sandboxSpawn(bin, args, spawnOpts) {
    // spawnOpts.cwd is already normalizeCwd()'d by warm-cli-session.mjs's
    // spawnProc() by the time we're called; fall back to the raw
    // options.cwd only for the (untested-in-practice) case spawnProc ran
    // with no cwd at all.
    const targetFolder = spawnOpts?.cwd ?? options.cwd;
    const psArgs = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', LAUNCHER_PATH,
      '-TargetFolder', targetFolder,
      // EVERY OPTIONAL NAMED FLAG GOES HERE — BEFORE -InnerBin, never after it. The launcher
      // binds by NAME only (PositionalBinding = $false) and sweeps everything it does not bind
      // into InnerArgs (ValueFromRemainingArguments), so a flag placed after -InnerBin's value
      // would still BIND correctly — but it would sit inside what every reader, and every test,
      // treats as "the inner argv is the contiguous tail after -InnerBin <bin>". Keeping the
      // optional flags ahead of -InnerBin keeps that tail exactly the claude/codex/pi argv.
      //
      // WITH NO TOKEN THE SPREAD IS EMPTY and psArgs is byte-identical to what it was before
      // this existed. That is the common case and it must stay unchanged.
      ...(oauthToken ? ['-SetEnv', `${OAUTH_ENV_NAME}=${oauthToken}`] : []),
      '-InnerBin', bin,
      ...args,   // collected by the launcher's InnerArgs (ValueFromRemainingArguments) — verbatim array elements, never joined/re-parsed
    ];
    return _spawn('powershell.exe', psArgs, spawnOpts);
  }

  if (engine === 'codex') return createCodexCliSession({ ...options, spawn: sandboxSpawn });
  if (engine === 'pi') return createPiCliSession({ ...options, spawn: sandboxSpawn });
  return createWarmCliSession({ ...options, spawn: sandboxSpawn });
}
