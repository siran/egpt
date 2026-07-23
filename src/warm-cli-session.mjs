// warm-cli-session.mjs — a resident, WARM Claude Code CLI session (Unit 4).
//
// ONE long-lived `claude --print --input-format stream-json --output-format
// stream-json [--resume <id>]` process that answers each streamed user message
// as a turn. Verified 2026-06-13: turn 2 is ~2× faster than the cold turn 1 —
// the process + model context stay warm between turns. This is the CLI analog of
// the retired in-process SDK warm session: the engine stays the CLI (I11), only
// the process is kept RESIDENT instead of re-spawned per turn.
//
// Interface = what `src/warm-sessions.mjs` (createWarmPool) expects of a session:
//   turn(message, onUpdate) -> { text, sessionId }   ·   close()
// The pool owns lazy-warm, idle-evict (the residency/reap policy), LRU, and
// per-key serialization, so this primitive only manages ONE process running ONE
// turn at a time. No `inject` is exported — the pool then serializes follow-ups
// (stream-json treats each user message as a separate query, not a mid-turn weave).
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildClaudeArgs } from './claude-args.mjs';

// MSYS2/Cygwin "/c/Users/.." → "C:/Users/.." for Node spawn cwd on Windows.
function normalizeCwd(p) {
  if (!p) return p;
  const m = p.match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p;
}

// Resolve the claude binary to a FULL path. A Windows SERVICE inherits a minimal
// PATH (not the login PATH), and — verified the hard way (operator 2026-06-14:
// DOLLY's Don ENOENT survived an `egpt-spine.mjs` PATH prepend) — mutating
// `process.env.PATH` at runtime does NOT reliably reach libuv's spawn path-search
// on Windows. So don't rely on PATH: prefer an explicit override
// (config `bin` / `EGPT_CLAUDE_BIN`), else the known per-user install
// (`~/.local/bin/claude[.exe]`, where the installer puts it), else fall back to
// bare `claude` (PATH) for setups that do have it.
function resolveClaudeBin(explicit) {
  const override = explicit || process.env.EGPT_CLAUDE_BIN;
  if (override) return override;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const local = join(homedir(), '.local', 'bin', exe);
  try { if (existsSync(local)) return local; } catch { /* fall through to PATH */ }
  return 'claude';
}

export function createWarmCliSession(options = {}) {
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const _spawn = options.spawn || nodeSpawn;   // injectable for tests
  let proc = null;
  let stdoutBuf = '';
  let stderrBuf = '';
  let sessionId = options.sessionId ?? null;
  let pending = null;   // { resolve, reject, onUpdate, acc, settled }
  let closed = false;

  function spawnProc() {
    // Reuse the tested confinement/model/effort/--resume arg-builder, then add
    // the streaming INPUT format so one process answers many turns. buildClaudeArgs
    // already supplies BASE_ARGS (--print --output-format stream-json --verbose
    // --include-partial-messages), the sandbox flags, --model/--effort, and
    // --resume <sessionId> when set.
    const args = ['--input-format', 'stream-json', ...buildClaudeArgs(options)];
    const cwd = normalizeCwd(options.cwd);
    // A non-existent cwd makes Node's spawn fail with a MISLEADING `spawn <bin>
    // ENOENT` — it names the binary, not the missing dir (operator 2026-06-14:
    // DOLLY's Don had a YAML-mangled cwd `C:Usersansrcegpt` and it cost hours of
    // chasing PATH/binary ghosts). Check it up front and fail with the real reason.
    // (The '!!' prefix is added by the caller's catch, so this routes through the
    // bridge failure-notice path rather than leaking as the sibling's reply.)
    if (cwd && !existsSync(cwd)) {
      throw new Error(`warm-cli: cwd does not exist: ${cwd} — check the being's config 'cwd' (a double-quoted backslash YAML path gets mangled; use forward slashes)`);
    }
    const bin = resolveClaudeBin(options.bin);
    onLog(`warm-cli: spawn ${bin} ${args.join(' ')}`);
    proc = _spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(cwd ? { cwd } : {}) });
    proc.stdout?.setEncoding?.('utf8');
    proc.stdout?.on('data', onStdout);
    proc.stderr?.setEncoding?.('utf8');
    proc.stderr?.on('data', (d) => { stderrBuf = (stderrBuf + d).slice(-2000); });
    proc.on('close', onClose);
    proc.on('error', (err) => failPending(err));
  }

  function onStdout(chunk) {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let ev;
      try { ev = JSON.parse(t); } catch { continue; }
      // Capture the (possibly freshly-minted) session id, first-wins.
      if (typeof ev.session_id === 'string' && !sessionId) sessionId = ev.session_id;
      if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') {
        const d = ev.event.delta;
        if (d?.type === 'text_delta' && typeof d.text === 'string' && pending) {
          pending.acc += d.text;
          try { pending.onUpdate?.(pending.acc); } catch { /* caller's onUpdate */ }
        }
      } else if (ev.type === 'assistant' && ev.message?.content && pending && !pending.acc) {
        const text = ev.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
        if (text) { pending.acc = text; try { pending.onUpdate?.(pending.acc); } catch { /* */ } }
      } else if (ev.type === 'result') {
        if (ev.subtype === 'success') {
          resolvePending(typeof ev.result === 'string' ? ev.result : (pending?.acc ?? ''));
        } else {
          const detail = stderrBuf.trim() ? ` — ${stderrBuf.trim().slice(-300)}` : '';
          failPending(new Error(`claude: ${ev.subtype}${detail}`));
        }
      }
    }
  }

  function resolvePending(text) {
    if (!pending || pending.settled) return;
    pending.settled = true;
    const p = pending; pending = null;
    p.resolve({ text, sessionId });
  }
  function failPending(err) {
    if (pending && !pending.settled) {
      pending.settled = true;
      const p = pending; pending = null;
      p.reject(err);
    }
  }
  function onClose(code) {
    proc = null;
    if (pending && !pending.settled) {
      const detail = stderrBuf.trim() ? `: ${stderrBuf.trim().slice(-300)}` : '';
      failPending(new Error(`claude exited ${code} mid-turn${detail}`));
    }
  }

  return {
    async turn(message, onUpdate = () => {}) {
      if (closed) throw new Error('warm-cli: session closed');
      if (pending) throw new Error('warm-cli: a turn is already in flight (the pool must serialize per key)');
      if (!proc) spawnProc();
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, onUpdate, acc: '', settled: false };
        const userMsg = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: String(message ?? '') }] } }) + '\n';
        try { proc.stdin.write(userMsg); } catch (e) { failPending(e); }
      });
    },
    close() {
      closed = true;
      try { proc?.stdin?.end(); } catch { /* already closing */ }
      try { proc?.kill?.(); } catch { /* */ }
      proc = null;
    },
    get sessionId() { return sessionId; },
  };
}
