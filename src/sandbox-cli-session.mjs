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
// full mechanism + the verified deviations from the original spec
// (CreateProcessWithLogonW over CreateProcessAsUser; and the ARGUMENT CONTRACT —
// -InnerArgs, -SharePath and -SetEnv are each exactly ONE argv element holding a
// JSON array, so PowerShell's parameter binder never tokenizes caller data).
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
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
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

// THE SECOND, AND LAST, VARIABLE A SANDBOXED TURN IS HANDED (operator ruling 2026-09-11) — and
// the fix for a defect that had every sandboxed being losing its CLI memory on every cold start
// from 2026-09-05 (856a2fb) onward.
//
// THE DEFECT: the launcher's step (f) scrubs the leased account's whole scratch profile on every
// lease acquire, and with CLAUDE_CONFIG_DIR unset the CLI keeps its OWN session store under that
// profile (%USERPROFILE%\.claude\projects\<slug>\<session>.jsonl). So every cold start deleted
// the transcript it was about to `--resume`, the resume was refused, the pool evicted, and
// brainpool retried FRESH on a new thread. Measured on this node: 0 .jsonl files across all 16
// pool profiles, against 570 in the operator's own store — deletion, not the CLI's own
// housekeeping. `wren`, the one being with `sandboxed: false`, was unaffected throughout.
//
// THE SCRUB IS NOT THE BUG AND MUST STAY TOTAL. Its own header carries the ruling — "the account
// profile is SCRATCH, the conversation folder is the only durable storage" — because pool
// accounts are REUSED across different conversations and anything spared leaks to whoever leases
// that account next. There is no exemption to add here; the fix is to stop keeping durable state
// in a scratch profile at all.
//
// WHERE IT GOES INSTEAD: ~/.egpt-jsonl/<threadId>/, under the OPERATOR's profile, which nothing
// scrubs. CLAUDE_CONFIG_DIR relocates the CLI's whole config root — projects/, sessions/ and
// .claude.json — wholesale (re-measured 2026-09-11 against claude.exe 2.1.265).
//
// NOT THE CONVERSATION FOLDER, deliberately: `/agents reset` archives the whole conversation
// folder and would take the store with it. Keyed by THREAD the lifecycle is exactly right —
// `rethread` mints a new id and so gets a fresh store, `reset` orphans the old one, and ordinary
// turns reuse it.
const CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

// ~/.egpt-jsonl. Under the OPERATOR's home (this process runs as the operator; only the CHILD is
// a pool account), so it survives both the scrub and `/agents reset`. Injectable purely for
// tests, the same DI convention as `spawn` and `platform` — nothing in production overrides it,
// and a blank/non-string override falls back rather than resolving to a bare relative path.
function jsonlStoreRootOf(options) {
  const override = typeof options.jsonlStoreRoot === 'string' ? options.jsonlStoreRoot.trim() : '';
  return override || join(homedir(), '.egpt-jsonl');
}

// THE REMEDY, WORD FOR WORD, IN BOTH FAILURES BELOW (operator 2026-09-06). This is the one
// credential on a sandboxed node that a human must mint by hand, and it is STATIC — so when it
// lapses, every sandboxed being on the node dies at the same moment (38 conversations across 16
// pool accounts on 2026-09-05) with nothing in the failure that says what to do. The operator
// reads this at 2am, in a chat reply or a log line, so it carries the commands themselves rather
// than pointing at a doc. NEVER the token VALUE: presence and LENGTH only (see brainpool.mjs's
// "NEVER LOGGED" note on the same value).
const OAUTH_REMEDY = [
  'It is STATIC and cannot refresh itself — your own ~/.claude login rotates every ~12h, this one never does —',
  'so it takes every sandboxed being on the node down at once. To replace it:',
  '  1. Mint one AS THE OPERATOR: the `an` Windows account, the one holding the Claude subscription login.',
  '     NEVER as a pool account (egpt-sbx-NN) — those profiles are empty and have no login, by design.',
  '       claude setup-token',
  '     That is a SUBSCRIPTION token. An `sk-ant-api...` API key will NOT work here.',
  '  2. Paste it as the TOP-LEVEL `sandbox_oauth_token:` key of EACH node\'s own config. The two nodes on this',
  '     machine keep separate profiles: ~/.egpt/config/config.yaml (kg) and ~/.egpt2/config/config.yaml (kg2).',
  '  3. Make it take effect, once per node, from the repo. setup/upgrade.ps1 drops an /upgrade the running',
  '     spine consumes; the daemon then pulls, rebuilds and respawns it, and the new config is read on the way up:',
  '       powershell -ExecutionPolicy Bypass -File setup\\upgrade.ps1',
  '       powershell -ExecutionPolicy Bypass -File setup\\upgrade.ps1 -EgptHome "$env:USERPROFILE\\.egpt2"',
].join('\n');

// CASE B — THE CREDENTIAL IS THERE AND THE API REFUSED IT. MEASURED on 2026-09-06 against
// claude.exe 2.1.263 with a deliberately invalid token and a fresh profile, NOT assumed:
// stderr stayed EMPTY (0 bytes) and the whole failure arrived on stdout as the turn's final
// stream-json event — `{"type":"result","subtype":"success","is_error":true,
// "api_error_status":401,"result":"Failed to authenticate. API Error: 401 OAuth access token is
// invalid."}`. subtype **success**, so warm-cli-session.mjs RESOLVES the turn and the being
// replies that sentence into the chat. The resolved TEXT is therefore where a sandboxed auth
// failure actually surfaces, and the only place the remedy can be attached.
//
// NARROW BY DESIGN: the 401 AND the OAuth wording, never the vendor's whole sentence, which is
// theirs to reword. A miss costs the operator the remedy (exactly today's behaviour); a false
// positive would staple it onto an innocent reply, which requiring the 401 makes implausible.
const oauthRejected = (text) => /\b401\b/.test(text) && /oauth/i.test(text);

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

  // CASE A — THE CREDENTIAL IS SIMPLY NOT THERE (operator 2026-09-06). Third guard, same loud
  // shape and same position as the engine and platform checks above: thrown before the inner
  // session exists, therefore before any spawn. Without it the turn spawned with NOTHING (the
  // -SetEnv spread above contributes zero elements), reached the API with no credential, and
  // died deep inside the CLI in a message that named neither the config key nor the fix.
  //
  // ccode ONLY, deliberately. CLAUDE_CODE_OAUTH_TOKEN is a Claude Code credential and the
  // remedy below is `claude setup-token`; a sandboxed codex/pi being authenticates some other
  // way entirely, so refusing it with THIS text would be a confident wrong diagnosis. Those two
  // keep exactly today's behaviour — no token, no -SetEnv, spawn unchanged.
  if ((engine === 'ccode' || engine === 'claude-code') && !oauthToken) {
    throw new Error(
      'sandboxed: true has NO credential: config.yaml\'s `sandbox_oauth_token` is unset or blank, and it is the '
      + 'ONLY credential a sandboxed turn ever gets — the leased pool account it runs as has an empty profile and '
      + 'is denied your ~/.claude by the very ACLs that make the sandbox a sandbox.\n' + OAUTH_REMEDY,
    );
  }

  // THIS THREAD'S OWN CLI STORE — see CONFIG_DIR_ENV above for what it is and why it moved.
  // Resolved HERE, once, next to the other guards and before the inner session exists, because
  // three things downstream need the same answer and must never disagree: the -SetEnv entry that
  // points the CLI at it, the -SharePath entry that gets the leased account an ACE on it, and
  // the `--session-id` the CLI is told to open it under.
  //
  // ccode ONLY. CLAUDE_CONFIG_DIR is a Claude Code variable; a sandboxed codex/pi turn keeps its
  // argv byte-identical to what it was — no store, no extra -SetEnv entry, no extra share path.
  //
  // THE THREAD ID IS OURS TO MINT when the caller has none (a fresh thread), and claude-args.mjs
  // turns it into `--session-id`. That is the whole reason the store can exist BEFORE the first
  // byte: letting the CLI mint the id would leave turn 1 with nowhere to write. Same shape
  // pi-cli-session.mjs:110 already uses. `options.sessionId` — a thread we are RESUMING — always
  // wins, and then it is `--resume` that runs, not `--session-id`.
  const isCcode = engine === 'ccode' || engine === 'claude-code';
  const threadId = !isCcode ? null
    : ((typeof options.sessionId === 'string' && options.sessionId.trim()) ? options.sessionId.trim() : randomUUID());
  const jsonlStoreDir = threadId ? join(jsonlStoreRootOf(options), threadId) : null;
  if (jsonlStoreDir) {
    // LOUD, AND BEFORE ANY SPAWN — same discipline as the three guards above. The tempting
    // alternative (log it and carry on with CLAUDE_CONFIG_DIR unset) is not a fallback, it is
    // THIS EXACT BUG restored invisibly: the CLI would silently go back to writing into the
    // scratch profile that step (f) empties, and the being would go back to losing its memory on
    // every cold start with nothing anywhere saying so.
    try {
      mkdirSync(jsonlStoreDir, { recursive: true });
    } catch (err) {
      throw new Error(
        `sandboxed: true could not create this thread's CLI store at ${jsonlStoreDir} — ${err?.message ?? err}. `
        + 'That directory IS the sandboxed being\'s memory: it holds the transcript the next cold turn resumes from, '
        + 'and it must live outside the leased pool account\'s profile because setup/sandbox-logon-launcher.ps1 empties '
        + 'that profile on every lease acquire. Refusing the turn rather than running it without a store, which would '
        + 'silently lose the thread on the next cold start.',
      );
    }
  }

  // THE OS-LAYER HALF OF A BEING'S `allowed_paths` (brainpool.mjs's sandboxSharePathsFor,
  // handed here as options.sandboxSharePaths). Same normalisation discipline as the token
  // above, and for the same reason — sandboxSpawn must stay a pure argv build: anything that
  // is not a non-blank string is dropped, duplicates are dropped, and an empty result
  // contributes ZERO argv elements so the no-share argv is byte-identical to what it was.
  //
  // WHY IT EXISTS: `allowed_paths` produced an `--add-dir` at the CLI layer and NOTHING at the
  // OS layer, so under the sandbox the folder was permitted by Claude Code and denied by the
  // kernel — the being was told it may use a directory that then refused it. Under the
  // `all`/`sandbox` tiers there is no CLI layer at all (confinementFor returns {} for
  // dangerously_skip_permissions), so the launcher's ACE is the ONLY way a shared folder is
  // reachable at all.
  //
  // ...AND THIS THREAD'S STORE RIDES THE SAME LIST (operator 2026-09-11). It is a per-path ACE
  // on exactly one directory, granted and revoked with the lease, which is precisely what step
  // (d2) already does — so there is no second mechanism, only one more entry. LAST, after the
  // being's own paths, so the caller's declaration order is unchanged. THE THREAD'S OWN
  // DIRECTORY, never ~/.egpt-jsonl itself: granting the root would hand every lease every
  // thread's transcripts, which is the one thing this must not do.
  const sharePaths = [...new Set(
    [
      ...(Array.isArray(options.sandboxSharePaths) ? options.sandboxSharePaths : []),
      ...(jsonlStoreDir ? [jsonlStoreDir] : []),
    ]
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => p.trim()),
  )];

  // The -SetEnv payload, built ONCE beside the share list rather than inside sandboxSpawn, for
  // the same reason everything else here is: sandboxSpawn stays a pure argv build.
  const setEnv = [
    ...(oauthToken ? [`${OAUTH_ENV_NAME}=${oauthToken}`] : []),
    ...(jsonlStoreDir ? [`${CONFIG_DIR_ENV}=${jsonlStoreDir}`] : []),
  ];

  function sandboxSpawn(bin, args, spawnOpts) {
    // spawnOpts.cwd is already normalizeCwd()'d by warm-cli-session.mjs's
    // spawnProc() by the time we're called; fall back to the raw
    // options.cwd only for the (untested-in-practice) case spawnProc ran
    // with no cwd at all.
    const targetFolder = spawnOpts?.cwd ?? options.cwd;
    // ONE ARGV ELEMENT PER LAUNCHER PARAMETER, AND EVERY LIST IS A JSON ARRAY. This is THE one
    // place psArgs is built and the contract is the launcher's own PARAMS header. The three
    // JSON.stringify()s below are LOAD-BEARING, not tidiness — passed as bare tokens instead,
    // PowerShell's parameter binder:
    //   * ATE the inner argv's `--verbose`, prefix-matching [CmdletBinding()]'s common
    //     -Verbose switch, which made `--print --output-format stream-json` illegal and killed
    //     every sandboxed ccode turn before the model ("requires --verbose");
    //   * bound only the FIRST value of a multi-value flag and spilled the rest into the inner
    //     argv, silently (`-SharePath A B` -> SharePath=[A], InnerArgs=[B, ...]);
    //   * rejected the empty `--setting-sources ''` element outright.
    // Inside a JSON string none of the three is a token the binder can see.
    //
    // ORDER: the optional flags stay BEFORE -InnerBin and -InnerArgs comes last. Nothing binds
    // by position any more, so this is purely for readers — the argv reads in the same order
    // the launcher's param block declares.
    const psArgs = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', LAUNCHER_PATH,
      '-TargetFolder', targetFolder,
      // WITH NO SHARE PATHS AND NO TOKEN both spreads are EMPTY and the launcher's own
      // defaults ('' = "no entries") apply. That is the common case and it must stay unchanged.
      ...(sharePaths.length ? ['-SharePath', JSON.stringify(sharePaths)] : []),
      // ONE -SetEnv element carrying every NAME=VALUE this turn needs, exactly as before — the
      // store's CLAUDE_CONFIG_DIR is a second ENTRY in that one JSON array, not a second flag.
      // (The launcher's Set-EnvBlockEntry re-sorts the block itself, so the order here is only
      // for readers.) A codex/pi turn has no store, so with a token alone this is byte-identical
      // to what it was, and with neither it still contributes ZERO argv elements.
      ...(setEnv.length ? ['-SetEnv', JSON.stringify(setEnv)] : []),
      '-InnerBin', bin,
      // The WHOLE inner argv as ONE element. Empty elements, `--flags` and repeated flags all
      // ride INSIDE the JSON, verbatim, and the launcher's ConvertFrom-JsonArgv hands them to
      // CreateProcessWithLogonW one array slot each.
      '-InnerArgs', JSON.stringify(Array.isArray(args) ? args : []),
    ];
    return _spawn('powershell.exe', psArgs, spawnOpts);
  }

  if (engine === 'codex') return createCodexCliSession({ ...options, spawn: sandboxSpawn });
  if (engine === 'pi') return createPiCliSession({ ...options, spawn: sandboxSpawn });
  // Case A above guarantees a non-empty token on this path, so the length below is always the
  // length of a real credential — never zero, and never the value itself.
  // `newSessionId` is what claude-args.mjs turns into `--session-id` — and ONLY when there is no
  // `options.sessionId` to `--resume`, so a resumed thread's argv is unchanged. Spread in only
  // when there is one (ccode), so the codex/pi options object is untouched.
  return withOauthRemedy(
    createWarmCliSession({ ...options, spawn: sandboxSpawn, ...(threadId ? { newSessionId: threadId } : {}) }),
    oauthToken.length,
  );
}

// Case B's other half: the resolved text of a turn the API refused gets the remedy stapled to
// it, so the sentence the being would otherwise post into the chat ("Failed to authenticate.
// API Error: 401 OAuth access token is invalid.") carries the fix with it. Only ever reached
// from the ccode branch above, which is only ever reached for `sandboxed: true` — a
// non-sandboxed turn never constructs this wrapper at all, so its path is untouched.
//
// MUTATES the one method instead of spreading into a new object: warm-cli-session.mjs returns
// `sessionId` as a GETTER, and a spread would freeze it to the value it had at creation (null)
// rather than tracking the live session id.
function withOauthRemedy(session, tokenLength) {
  const innerTurn = session.turn.bind(session);
  session.turn = async (message, onUpdate) => {
    const r = await innerTurn(message, onUpdate);
    if (typeof r?.text !== 'string' || !oauthRejected(r.text)) return r;
    return {
      ...r,
      text: `${r.text}\n\n[egpt] THE SANDBOX CREDENTIAL WAS REJECTED. config.yaml's \`sandbox_oauth_token\` is set `
        + `(${tokenLength} characters) but the API refused it — expired, revoked, or truncated on paste.\n${OAUTH_REMEDY}`,
    };
  };
  return session;
}
