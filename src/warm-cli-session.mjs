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
import { buildClaudeArgs } from './claude-args.mjs';

// MSYS2/Cygwin "/c/Users/.." → "C:/Users/.." for Node spawn cwd on Windows.
function normalizeCwd(p) {
  if (!p) return p;
  const m = p.match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p;
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
    // The claude binary. Defaults to bare 'claude' (on PATH), but a spine whose
    // SERVICE PATH lacks it (operator 2026-06-14: DOLLY's Don → "spawn claude
    // ENOENT") can point at the full path via config (brains.warm.bin) or the
    // EGPT_CLAUDE_BIN env var, no code change. NSSM service PATH ≠ interactive PATH.
    const bin = options.bin || process.env.EGPT_CLAUDE_BIN || 'claude';
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
