// claude-args.mjs — build the `claude` CLI argv for a confined, headless,
// streaming turn. This is the CLI MIRROR of config/brains/claude-sdk.mjs
// `buildSdkOptions`: the engine moves SDK→CLI (operator 2026-06-12, CLI is more
// robust + has working --effort + native thinking stream), and EVERY hard-earned
// confinement feature must survive the move — proven by tests/claude-args.test.mjs.
//
// Mapping (SDK option → CLI flag), 1:1 with buildSdkOptions:
//   addDirs (additionalDirectories) → --add-dir (repeatable)
//   confineToDirs (sandbox)         → --setting-sources "" (no ~/.claude bypass
//                                     inheritance — the Read-leak fix) +
//                                     --permission-mode default (engine enforces) +
//                                     --add-dir <roots>; file tools are NOT
//                                     pre-approved (so they stay path-confined),
//                                     only non-file tools are allow-listed.
//   osConfined (the OS box IS the   → NO CLI CONFINEMENT AT ALL (operator ruling
//     boundary)                       2026-09-23): the same
//                                     --dangerously-skip-permissions +
//                                     --permission-mode bypassPermissions pair the
//                                     unconfined tier gets, the full --allowedTools
//                                     list, NO --add-dir (not the cwd, not an
//                                     allowed_paths root), no --setting-sources ""
//                                     and no readOnlyDirs deny rules. The leased
//                                     pool account's ACEs are the boundary and are
//                                     checked by the kernel on every open; a CLI
//                                     gate on top was a weaker second opinion that
//                                     bare Bash walked past anyway. `allowed_paths`
//                                     still produces a real per-lease ACE — that is
//                                     the OS half and it is untouched.
//                                     THE GUARD IS THIS FLAG ONLY: a being with no
//                                     OS box (access_level regular, or a non-win32
//                                     node) takes the confineToDirs tier above,
//                                     unchanged.
//   allowedTools 'all'|'*'          → REJECTED (operator 2026-07-03): coerced to
//                                     DEFAULT_ALLOWED_TOOLS and routed through the
//                                     list path — NO bypass tier, no bare Bash/Agent.
//   allowedTools list               → --allowedTools "<list>" (confined path when
//                                     confineToDirs is set)
//   dangerouslySkipPermissions: true → --dangerously-skip-permissions +
//                                     --permission-mode bypassPermissions, IN ADDITION
//                                     to the --allowedTools push above (operator
//                                     2026-08-17: "make access_level: all finally mean
//                                     what it says"). Mirrors the flag pair
//                                     src/tools/butler.mjs already uses for its own
//                                     full-access mode. Safe because the ONLY caller,
//                                     brainpool.mjs's turn(), sets `dangerouslySkipPermissions`
//                                     from a def that is either a trusted base-layer type-file
//                                     grant (conv-local layers can never set/clear it —
//                                     see brains.mjs resolve()) or the access-level
//                                     override (config/permissions/all.md), which is
//                                     itself only reachable once a turn has already
//                                     passed brainpool's STRUCTURAL SAFETY GATES
//                                     (access_level structurally set + allowed_users
//                                     non-empty + sender matched upstream in
//                                     router.mjs/mesh.mjs). `dangerouslySkipPermissions`
//                                     absent/false is the ordinary path — no bypass, unchanged.
//   readOnlyDirs (write-deny)       → NATIVE permission deny rules via --settings:
//                                     permissions.deny ["Edit(<dir>/**)","Write(...)",
//                                     "MultiEdit(...)","NotebookEdit(...)"] — Claude's
//                                     own engine, NOT a hand-rolled hook. The dir is
//                                     also --add-dir'd so READS still work.
//   model   → --model ;  effort → --effort ;  sessionId → --resume ;
//   appendSystemPrompt → --append-system-prompt
//
// Pure: argv from options, no spawn, no I/O. The ccode brain spawns `claude`
// with these args (cwd handled by spawn, not argv).

export const FILE_TOOLS = new Set(['read', 'write', 'edit', 'multiedit', 'notebookedit', 'glob', 'grep']);

// The explicit default tool list egpt grants when an agent type omits allowed_tools
// (operator 2026-07-03: "list tools explicitly" + "better to reject 'all'"). One
// source of truth — conversations-state re-exports this; nothing hard-codes 'all'.
// Scoped Bash(<bin>:*) is added per type; bare Bash/Agent are never here.
export const DEFAULT_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task'];

// The `/e` wizard's tools-step "read-only" menu option (operator 2026-07-03): no
// write-class tools, read + web only. Same one-source-of-truth convention as
// DEFAULT_ALLOWED_TOOLS above.
export const READONLY_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

// Write-class tools denied under a read-only dir (the CLI mirror of the SDK's
// PreToolUse write-deny hook). Read/Grep/Glob stay allowed (the dir is readable).
export const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

// Native Claude permission rules that make each read-only dir write-protected:
// `Tool(path/**)` deny rules (the documented settings syntax). Paths normalized to
// forward slashes for glob matching; trailing slash stripped.
export function readOnlyDenyRules(readOnlyDirs) {
  const out = [];
  for (const d of (Array.isArray(readOnlyDirs) ? readOnlyDirs : [])) {
    if (!d || typeof d !== 'string') continue;
    const root = d.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    for (const t of WRITE_TOOLS) out.push(`${t}(${root}/**)`);
  }
  return out;
}

// Base flags for every headless streaming turn (the thinking stream rides here).
export const BASE_ARGS = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

function _cleanList(v) {
  return (Array.isArray(v) ? v : []).filter((d) => d && typeof d === 'string');
}

export function buildClaudeArgs(options = {}) {
  const args = [...BASE_ARGS];

  const readOnlyDirs = _cleanList(options.readOnlyDirs);
  const confineRoots = _cleanList(options.confineToDirs);
  // CONFINED IN THE PERMISSION SENSE, WITH NO ROOT TO NAME (operator ruling 2026-09-23). An
  // OS-sandboxed turn runs as a leased pool account whose cwd is a per-lease junction the spine
  // cannot know, so brainpool's confinementFor sends `osConfined: true` INSTEAD of
  // `confineToDirs: [cwd]` - naming that cwd is what leaked the operator's username and a third
  // party's conversation name into group chats. An EXPLICIT field, not the absence of roots, for
  // the same reason `dangerouslySkipPermissions` is one: this decides the permission tier, and a
  // tier must not be inferred from a missing value. The unconfined tier never sets it
  // (confinementFor returns {} for dangerously_skip_permissions), so a bypass turn is untouched.
  const osConfined = options.osConfined === true;
  // ── AN OS-SANDBOXED TURN IS NOT CLI-CONFINED AT ALL (operator ruling 2026-09-23: "and so
  // --permission-mode [should] be none at all. free roam inside the sandbox", and, asked whether
  // the coherent end state is that a sandboxed being also gets bypassPermissions, "yes").
  // `osConfined` used to make `confined` true and take the middle tier — --permission-mode
  // default, file tools withheld from --allowedTools, every root spelled into --add-dir. It now
  // takes the SAME tier as dangerouslySkipPermissions, and `confined` is about CLI roots only.
  //
  // WHY THIS IS NOT A WIDENING, which is the question a reader finds alarming:
  // --dangerously-skip-permissions on a SANDBOXED being. THE ACCOUNT IS THE BOUNDARY. The turn
  // runs as a leased pool account that holds an ACE on its Room, on its thread store and on the
  // read-only mounts, and on nothing else; every open is checked by the kernel. The 2026-07-03
  // defect this middle tier was built around — "an allow-list entry bypasses the path check,
  // which is exactly how Read once leaked" — has no consequence here, because a Read that
  // escapes its root escapes into a directory the account has no ACE on and fails at the
  // syscall.
  //
  // AND THE MIDDLE TIER WAS NEVER ACTUALLY A BOUNDARY FOR THESE BEINGS. They hold bare Bash,
  // which was never path-gated: the being could always `cat` a file it was not allowed to
  // `Read`. Keeping --permission-mode default was a second, weaker opinion on a question the
  // kernel already answers, and its only reliable effect was to make the being ask permission
  // for things it was entitled to do.
  //
  // THE GUARD IS `osConfined`, NOTHING ELSE. A being at access_level `regular` (codex, llama)
  // is NOT sandboxed, has NO OS box, and CLI confinement is the only boundary it has — it keeps
  // `confineToDirs` and the middle tier below, byte for byte. Same for any node where
  // resolveSandboxed answers false, which is every non-win32 one. See brainpool's confinementFor:
  // it is what decides which of the two a being gets, and it keys on `sandboxed` alone.
  const confined = confineRoots.length > 0;

  // dangerouslySkipPermissions:true (see the header mapping above) — the actual bypass, IN
  // ADDITION to whatever --allowedTools push happens below. Only ever set true by
  // brainpool.mjs's turn(), after its own structural gates have already run — see the
  // header comment. `osConfined` joins it here, and ONLY here: see the block above.
  if (options.dangerouslySkipPermissions === true || osConfined) {
    args.push('--dangerously-skip-permissions');
    args.push('--permission-mode', 'bypassPermissions');
  }

  // ── tool permission + confinement (mirror buildSdkOptions) ──
  if (options.allowedTools) {
    // 'all'/'*' is REJECTED (operator 2026-07-03: "better to reject 'all'"). It
    // never buys full/bypass access on its OWN — it is coerced to the explicit
    // default tool list and routed through the normal path. egpt never WRITES
    // 'all'; a hand-written type file that does gets the safe list, nothing more.
    // Bare Bash/Agent are never implicit (they are simply not in the list). A
    // scoped Bash(<bin>:*) is grantable only by listing it explicitly. The ONLY
    // bypass path is the explicit `dangerouslySkipPermissions: true` flag above, gated
    // well upstream of this function (see the header comment) — 'all'/'*' alone never
    // reaches it.
    const at = (options.allowedTools === 'all' || options.allowedTools === '*')
      ? DEFAULT_ALLOWED_TOOLS
      : options.allowedTools;
    const list = Array.isArray(at) ? at : String(at).trim().split(/\s+/).filter(Boolean);
    if (confined) {
      // Sandbox: do NOT inherit ~/.claude bypass; engine enforces; file tools stay
      // path-confined to --add-dir (NOT pre-approved — an allow-list entry bypasses
      // the path check, exactly how Read once leaked); pre-approve only non-file
      // tools. --setting-sources '' so beings don't inherit the operator's personal
      // ~/.claude (esp. its MCP servers, whose schemas bloat every turn).
      //
      // A SANDBOXED TURN NEVER REACHES THIS BRANCH ANY MORE (see the osConfined block at the
      // top): it is the unconfined tier's now. Everything here is for a being whose ONLY
      // boundary is this argv — `access_level: regular`, or any non-win32 node — and it is
      // byte-identical to what it has always been.
      args.push('--setting-sources', '');
      // BOTH HALVES OF THE 2026-07-03 READ-LEAK FIX STAY for a being with no OS box:
      // --permission-mode default (the engine enforces rather than auto-approving) and file
      // tools NOT pre-approved below (an allow-list entry bypasses the path check, which is
      // exactly how Read once leaked). Here they really are the boundary.
      args.push('--permission-mode', 'default');
      const preApprove = list.filter((t) => !FILE_TOOLS.has(t.toLowerCase()));
      if (preApprove.length) args.push('--allowedTools', preApprove.join(' '));
    } else if (list.length) {
      args.push('--allowedTools', list.join(' '));
    }
  }

  if (typeof options.appendSystemPrompt === 'string' && options.appendSystemPrompt.trim()) {
    args.push('--append-system-prompt', options.appendSystemPrompt.trim());
  }
  if (typeof options.model === 'string' && options.model.trim()) {
    args.push('--model', options.model.trim());
  }
  // Reasoning depth — the lever the Agent SDK can't set (issues #168/#180/#182).
  if (typeof options.effort === 'string' && options.effort.trim()) {
    args.push('--effort', options.effort.trim());
  }

  // Allowed dirs = explicit addDirs ∪ confineRoots ∪ readOnlyDirs (RO dirs must be
  // READABLE — their WRITES are denied below). Deduped, order-stable.
  //
  // AN OS-SANDBOXED TURN GETS NONE OF THEM, and that is the whole of the argv change the
  // 2026-09-23 ruling asked for. `--add-dir` grants nothing there — the pool account's ACEs
  // decide what opens — and every root it could name is a REAL path under the operator's
  // profile, which is what put `C:/Users/an/src/egpt` into every sandboxed being's argv and
  // from there into whatever the being quoted in a group chat. The mounts it would have named
  // (`egpt`, `src`) live at C:\Users\egpt-sbx-NN, which the spine cannot know: the account is
  // leased after the argv is built.
  //
  // THE OS HALF STILL RUNS. `allowed_paths` still produces a real per-lease ACE through
  // brainpool's sandboxSharePathsFor and the launcher's -SharePath/-SharePathReadOnly. This is
  // NOT migration 0015 in reverse: 0015's defect was the OS permitting a path the CLI then
  // refused, and here the CLI refuses nothing at all.
  if (!osConfined) {
    const dirs = [];
    const seen = new Set();
    for (const d of [..._cleanList(options.addDirs), ...confineRoots, ...readOnlyDirs]) {
      if (!seen.has(d)) { seen.add(d); dirs.push(d); }
    }
    for (const d of dirs) args.push('--add-dir', d);
  }

  // Read-only grants — NATIVE deny rules (operator 2026-06-12: use Claude's CLI
  // options, NOT a hand-rolled hook). `permissions.deny` blocks the write-class
  // tools under each RO dir; passed via --settings, which loads even with
  // --setting-sources '' (explicit additional settings), so the grant holds
  // inside the sandbox — equivalent to the SDK's programmatic PreToolUse hook.
  // ...and they go with the roots for an OS-sandboxed turn, for the same reason and in the same
  // ruling: a deny rule is a CLI gate, and that tier has none. It also subtracts nothing there —
  // a read-only `allowed_paths` entry is granted ReadAndExecute at the kernel, so the write the
  // rule would have refused fails at the syscall whether Claude Code asks about it or not.
  if (readOnlyDirs.length && !osConfined) {
    args.push('--settings', JSON.stringify({ permissions: { deny: readOnlyDenyRules(readOnlyDirs) } }));
  }

  if (options.sessionId) args.push('--resume', String(options.sessionId));
  // ...ELSE THE THREAD ID THE CALLER MINTED ITSELF (operator ruling 2026-09-11). `--resume`
  // REUSES a session; `--session-id` CREATES one under an id we chose — MEASURED against
  // claude.exe 2.1.265: the CLI adopts the uuid verbatim (its stream-json `session_id` comes
  // back equal to it) and writes the transcript to <config>/projects/<slug>/<uuid>.jsonl, and
  // a later COLD process resuming that uuid reads it back. Passing one that already exists is
  // refused ("Session ID <id> is already in use.", exit 1), which is why the two are an
  // either/or and never both.
  //
  // WHY A CALLER WOULD WANT IT: a sandboxed turn's store now lives at ~/.egpt-jsonl/<threadId>
  // (see sandbox-cli-session.mjs), and that directory has to exist, and be ACL'd to the leased
  // pool account, BEFORE the CLI writes its first byte. Letting the CLI mint the id leaves
  // turn 1 of a fresh thread with nowhere to put its transcript. The alternative — a staging
  // directory renamed once the id is known — was measured on 2026-09-11 and SILENTLY SPLITS
  // the store: the rename succeeds, the running CLI re-creates the staging path, and one
  // session ends with two transcript files in two directories and no error anywhere.
  //
  // pi-cli-session.mjs:110 already does exactly this for the `pi` engine, and for the same
  // reason (a client that never learns its own thread id re-seeds identity on every turn).
  //
  // UNSET IS THE COMMON CASE and contributes NOTHING: with neither field set the argv is
  // byte-identical to what it was before this branch existed, so a non-sandboxed being — and
  // every other caller of buildClaudeArgs — is untouched.
  else if (options.newSessionId) args.push('--session-id', String(options.newSessionId));

  return args;
}
