// tools/butler.mjs — ephemeral haiku sub-agent for delegated tasks.
//
// Conversation-e (or operator) hands butler-e a prompt; butler spawns
// a fresh `claude --print --model haiku` subprocess with NO session
// memory (no --resume), executes the prompt with full tool access by
// default, captures stdout, and dies. The output flows back to the
// caller — either printed to the shell (operator-direct invocation)
// or dispatched as a system turn into a contact's thread (when
// butler was invoked via outbox by conversation-e).
//
// Operator (2026-05-19): butler-e uses default-all-tools for now.
// Sandboxed modes (r, cr, crd, ...) deferred to a later iteration.
//
// Token win: butler carries no context across calls. Each invocation
// pays only for the prompt + tool use; nothing accumulates. Cheaper
// than burning conversation-e's per-contact context on file lookups
// and grep-style work.

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_CWD = homedir();
const DEFAULT_MODEL = 'haiku';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;  // 5 min — long enough for grep/summarize, short enough to bound runaway

/**
 * Run an ephemeral butler turn.
 *
 *   prompt        — the task (markdown string)
 *   cwd?          — working directory (default: ~)
 *   model?        — claude model alias (default: 'haiku')
 *   allowedTools? — claude --allowedTools value (default: 'all')
 *   timeoutMs?    — kill the subprocess after N ms (default: 5 min)
 *   onLog?        — optional progress callback (called with each stdout chunk)
 *
 * Returns { text, exitCode, durationMs, error? }.
 */
export function runButler({
  prompt,
  cwd = DEFAULT_CWD,
  model = DEFAULT_MODEL,
  allowedTools = 'all',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onLog = () => {},
} = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const args = [
      '--print',
      '--output-format', 'text',
      '--model', model,
    ];
    if (allowedTools === 'all' || allowedTools === '*') {
      args.push('--dangerously-skip-permissions');
      args.push('--permission-mode', 'bypassPermissions');
    } else if (allowedTools) {
      const list = Array.isArray(allowedTools) ? allowedTools.join(' ') : String(allowedTools);
      if (list.trim()) args.push('--allowedTools', list.trim());
    }

    let proc;
    try {
      proc = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ text: '', exitCode: -1, durationMs: 0, error: `spawn failed: ${e.message}` });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c) => { stdout += c; try { onLog(c); } catch {} });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c) => { stderr += c; });

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
      settle({
        text: stdout.trim(),
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        error: `butler timed out after ${timeoutMs}ms (stderr: ${stderr.trim().slice(0, 200)})`,
      });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      if (code === 0) {
        settle({ text: stdout.trim(), exitCode: 0, durationMs });
      } else {
        settle({
          text: stdout.trim(),
          exitCode: code ?? -1,
          durationMs,
          error: `butler exit ${code}: ${stderr.trim() || '(no stderr)'}`,
        });
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      settle({ text: stdout.trim(), exitCode: -1, durationMs: Date.now() - startedAt, error: `butler error: ${err.message}` });
    });

    try { proc.stdin.write(prompt ?? ''); proc.stdin.end(); }
    catch (e) { /* if stdin write fails, claude usually still produces some output before exit */ }
  });
}
