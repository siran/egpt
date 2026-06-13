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
//   readOnlyDirs (PreToolUse deny)  → NOT YET — THROWS. The CLI expresses this as a
//                                     command hook via --settings, whose payload
//                                     protocol must be verified before we trust it
//                                     (unit 2). Throwing guarantees a read-only
//                                     grant can never be SILENTLY dropped here.
//   model   → --model ;  effort → --effort ;  sessionId → --resume ;
//   appendSystemPrompt → --append-system-prompt
//
// Pure: argv from options, no spawn, no I/O. The ccode brain spawns `claude`
// with these args (cwd handled by spawn, not argv).

export const FILE_TOOLS = new Set(['read', 'write', 'edit', 'multiedit', 'notebookedit', 'glob', 'grep']);

// Base flags for every headless streaming turn (the thinking stream rides here).
export const BASE_ARGS = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

function _cleanList(v) {
  return (Array.isArray(v) ? v : []).filter((d) => d && typeof d === 'string');
}

export function buildClaudeArgs(options = {}) {
  const args = [...BASE_ARGS];

  // ── read-only grants: refuse to silently drop them ──
  const readOnlyDirs = _cleanList(options.readOnlyDirs);
  if (readOnlyDirs.length) {
    throw new Error(
      'buildClaudeArgs: readOnlyDirs (write-deny grant) is not yet wired for the claude-code path '
      + '— the CLI PreToolUse command-hook protocol must be verified first. Refusing to drop a '
      + 'read-only grant silently (would be a confinement regression).',
    );
  }

  const confineRoots = _cleanList(options.confineToDirs);
  const confined = confineRoots.length > 0;

  // ── tool permission + confinement (mirror buildSdkOptions) ──
  if (options.allowedTools) {
    const at = options.allowedTools;
    if (at === 'all' || at === '*') {
      // Trusted (engineers / system-e): full access, belt + suspenders.
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

  // Allowed dirs = explicit addDirs ∪ confineRoots (deduped, order-stable).
  const dirs = [];
  const seen = new Set();
  for (const d of [..._cleanList(options.addDirs), ...confineRoots]) {
    if (!seen.has(d)) { seen.add(d); dirs.push(d); }
  }
  for (const d of dirs) args.push('--add-dir', d);

  if (options.sessionId) args.push('--resume', String(options.sessionId));

  return args;
}
