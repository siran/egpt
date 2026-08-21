// pi-cli-session.mjs — a resident Pi session (@l's FULL harness).
//
// The llama engine (llama-http-session.mjs) talks to llama-server directly, so
// @l can chat but not act: eGPT's own tool loop is four read-only tools, which
// is a lookup service, not a harness. This engine instead spawns Pi — a real
// coding harness with read/bash/edit/write — and lets it drive the SAME local
// model. Same shape as @e on `claude` and @c on `codex`.
//
// PROTOCOL: `pi --mode rpc` speaks JSONL over stdio (docs/rpc.md).
//   out: {"id":N,"type":"prompt","message":"..."}
//   in : {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"..."}}
//        {"type":"agent_settled"}
//
// TWO TRAPS the docs call out, both honoured here:
//  1. Terminal event is `agent_settled`, NOT `agent_end` — agent_end "may still
//     be followed by retry, compaction, or queued continuations", so resolving
//     there returns a truncated turn.
//  2. Framing is LF-ONLY. Node's `readline` is explicitly NOT protocol-compliant
//     because it also splits on U+2028/U+2029, which are legal inside JSON
//     strings — so this parses the buffer by hand and splits on '\n' alone.
//
// Interface = what src/warm-sessions.mjs (createWarmPool) expects:
//   turn(message, onUpdate) -> { text, sessionId }   ·   close()
// Pi owns its own session persistence (--session-id), so sessionId here is null
// unless the caller pins one.
import { spawn as nodeSpawn } from 'node:child_process';

export function createPiCliSession(options = {}) {
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const _spawn = options.spawn || nodeSpawn;   // injectable for tests
  const bin = options.bin || process.env.EGPT_PI_BIN || 'pi';

  let proc = null;
  let stdoutBuf = '';
  let stderrBuf = '';
  let pending = null;   // { resolve, reject, onUpdate, acc }
  let closed = false;
  let nextId = 1;

  function failPending(err) {
    if (!pending) return;
    const { reject } = pending;
    pending = null;
    reject(err);
  }

  function handleEvent(ev) {
    if (!pending) return;
    if (ev.type === 'message_update') {
      const d = ev.assistantMessageEvent;
      if (d && d.type === 'text_delta' && typeof d.delta === 'string') {
        pending.acc += d.delta;
        try { pending.onUpdate(pending.acc); } catch (e) { onLog(`pi-cli: onUpdate threw: ${e?.message ?? e}`); }
      }
      return;
    }
    // NOT agent_end — see trap 1 above.
    if (ev.type === 'agent_settled') {
      const { resolve, acc } = pending;
      pending = null;
      resolve({ text: acc, sessionId: options.sessionId ?? null });
    }
  }

  function onStdout(chunk) {
    stdoutBuf += chunk.toString('utf8');
    let i;
    // LF only. Do NOT use readline (trap 2).
    while ((i = stdoutBuf.indexOf('\n')) >= 0) {
      let line = stdoutBuf.slice(0, i);
      stdoutBuf = stdoutBuf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);   // tolerate CRLF
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { onLog(`pi-cli: unparsable line: ${line.slice(0, 120)}`); continue; }
      handleEvent(ev);
    }
  }

  function spawnProc() {
    const args = ['--mode', 'rpc', '--offline'];
    if (options.provider) args.push('--provider', options.provider);
    if (options.model) args.push('--model', options.model);
    if (options.sessionId) args.push('--session-id', String(options.sessionId));
    if (options.thinking) args.push('--thinking', String(options.thinking));
    onLog(`pi-cli: spawn ${bin} ${args.join(' ')}`);
    const p = _spawn(bin, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdout?.on('data', onStdout);
    p.stderr?.on('data', (c) => { stderrBuf = (stderrBuf + c.toString('utf8')).slice(-4000); });
    p.on('exit', (code) => {
      proc = null;
      failPending(new Error(`pi-cli: process exited (${code})${stderrBuf ? ` — ${stderrBuf.slice(-300)}` : ''}`));
    });
    p.on('error', (e) => { proc = null; failPending(new Error(`pi-cli: ${e?.message ?? e}`)); });
    return p;
  }

  return {
    turn(message, onUpdate = () => {}) {
      if (closed) return Promise.reject(new Error('pi-cli: session closed'));
      if (pending) return Promise.reject(new Error('pi-cli: a turn is already in flight (the pool must serialize per key)'));
      if (!proc) proc = spawnProc();
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, onUpdate, acc: '' };
        try {
          proc.stdin.write(JSON.stringify({ id: nextId++, type: 'prompt', message: String(message ?? '') }) + '\n');
        } catch (e) {
          failPending(new Error(`pi-cli: write failed: ${e?.message ?? e}`));
        }
      });
    },
    close() {
      closed = true;
      failPending(new Error('pi-cli: session closed'));
      try { proc?.stdin?.end(); } catch { /* already closing */ }
      try { proc?.kill?.(); } catch { /* already closing */ }
      proc = null;
    },
    get sessionId() { return options.sessionId ?? null; },
  };
}
