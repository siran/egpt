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
//   allowedTools 'all'|'*'          → --dangerously-skip-permissions +
//                                     --permission-mode bypassPermissions (trusted)
//   allowedTools list               → --allowedTools "<list>"
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
    const at = options.allowedTools;
    if (at === 'all' || at === '*') {
      // Trusted (engineers / system-e): full access, belt + suspenders.
      // --setting-sources '' so egpt's beings DON'T inherit the operator's
      // personal ~/.claude.json — esp. its MCP servers (Gmail/Google/etc.),
      // whose ~30 tool schemas bloat every turn's prompt and slow inference
      // (operator 2026-06-23: system-E went 4-6s → 14s after MCP servers were
      // added). A being's tools come from egpt's own args, not the operator's
      // dev config. (The confined path already does this.)
      args.push('--setting-sources', '');
      args.push('--dangerously-skip-permissions');
      args.push('--permission-mode', 'bypassPermissions');
    } else {
      const list = Array.isArray(at) ? at : String(at).trim().split(/\s+/).filter(Boolean);
      if (confined) {
        // Sandbox: do NOT inherit ~/.claude bypass; engine enforces; file tools
        // stay path-confined to --add-dir (NOT pre-approved — an allow-list entry
        // bypasses the path check, exactly how Read once leaked); pre-approve
        // only the non-file tools.
        args.push('--setting-sources', '');
        args.push('--permission-mode', 'default');
        const preApprove = list.filter((t) => !FILE_TOOLS.has(t.toLowerCase()));
        if (preApprove.length) args.push('--allowedTools', preApprove.join(' '));
      } else if (list.length) {
        args.push('--allowedTools', list.join(' '));
      }
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
