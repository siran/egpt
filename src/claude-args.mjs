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
//   allowedTools 'all'|'*'          → REJECTED (operator 2026-07-03): coerced to
//                                     DEFAULT_ALLOWED_TOOLS and routed through the
//                                     list path — NO bypass tier, no bare Bash/Agent.
//   allowedTools list               → --allowedTools "<list>" (confined path when
//                                     confineToDirs is set)
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
  const confined = confineRoots.length > 0;

  // ── tool permission + confinement (mirror buildSdkOptions) ──
  if (options.allowedTools) {
    // 'all'/'*' is REJECTED (operator 2026-07-03: "better to reject 'all'"). It
    // never buys full/bypass access — it is coerced to the explicit default tool
    // list and routed through the normal path. egpt never WRITES 'all'; a
    // hand-written type file that does gets the safe list, nothing more. There is
    // no --dangerously-skip-permissions / bypassPermissions path anymore, and bare
    // Bash/Agent are never implicit (they are simply not in the list). A scoped
    // Bash(<bin>:*) is grantable only by listing it explicitly.
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
      args.push('--setting-sources', '');
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
  const dirs = [];
  const seen = new Set();
  for (const d of [..._cleanList(options.addDirs), ...confineRoots, ...readOnlyDirs]) {
    if (!seen.has(d)) { seen.add(d); dirs.push(d); }
  }
  for (const d of dirs) args.push('--add-dir', d);

  // Read-only grants — NATIVE deny rules (operator 2026-06-12: use Claude's CLI
  // options, NOT a hand-rolled hook). `permissions.deny` blocks the write-class
  // tools under each RO dir; passed via --settings, which loads even with
  // --setting-sources '' (explicit additional settings), so the grant holds
  // inside the sandbox — equivalent to the SDK's programmatic PreToolUse hook.
  if (readOnlyDirs.length) {
    args.push('--settings', JSON.stringify({ permissions: { deny: readOnlyDenyRules(readOnlyDirs) } }));
  }

  if (options.sessionId) args.push('--resume', String(options.sessionId));

  return args;
}
