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
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The Windows npm launcher for pi is pi.cmd — a SHIM, not a PE image. Two
// independent reasons a bare 'pi' cannot work under the sandbox: the launcher
// hands InnerBin to CreateProcessWithLogonW as lpApplicationName, which does
// NOT search PATH, and cannot start a .cmd even given an absolute path. A
// Windows SERVICE also inherits a minimal PATH, so bare names are unreliable
// even unsandboxed. Resolve to node.exe + the package's own dist/cli.js, the
// same shape codex-cli-session.mjs's resolveCodexCommand() uses.
// The bridge writes a saved attachment into the message body as
//   (image foo.png) [saved: media/20260821-...-foo.png]
// (beeper.mjs ~L1357). The path is relative to the conversation folder, which is
// this session's cwd — so a turn can pick its own images up without any new
// plumbing through the spine.
const SAVED_MEDIA = /\[saved:\s*([^\]]+)\]/g;
const IMAGE_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
// Pi's built-ins (docs/usage.md). Deliberately NOT Claude's names: an agent
// type written for @e lists Read/Write/Glob/Task, which mean nothing here, and
// passing them to --tools would leave @p with NOTHING enabled. So allowed_tools
// is honoured only when it actually names pi tools; anything else leaves pi's
// own defaults, which is all seven.
const PI_TOOLS = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
const MAX_IMAGES = 3;             // a turn is a chat message, not an album
const MAX_IMAGE_BYTES = 6_000_000;

export function imagesFromMessage(message, cwd, { read = readFileSync, log = () => {} } = {}) {
  if (!cwd) return [];
  const out = [];
  for (const m of String(message ?? '').matchAll(SAVED_MEDIA)) {
    if (out.length >= MAX_IMAGES) break;
    const rel = m[1].trim();
    const dot = rel.lastIndexOf('.');
    const mimeType = dot < 0 ? null : IMAGE_EXT[rel.slice(dot).toLowerCase()];
    if (!mimeType) continue;                                  // video/audio/docs: not for the vision head
    try {
      const buf = read(join(cwd, rel));
      if (buf.length > MAX_IMAGE_BYTES) { log(`pi-cli: image too large, skipped: ${rel}`); continue; }
      out.push({ type: 'image', data: buf.toString('base64'), mimeType });
    } catch (e) { log(`pi-cli: image unreadable, skipped: ${rel} — ${e?.message ?? e}`); }
  }
  return out;
}

const PI_PKG = ['@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'];
// Node realpath()s what it resolves, and realpathSync lstat()s EVERY ancestor
// directory. Under the sandbox the leased account holds rights on the granted
// leaves only, so resolution died with:
//   EPERM: operation not permitted, lstat 'C:\Users\an\AppData'
// --preserve-symlinks-main covers the CJS entry; the ESM resolver
// (finalizeResolution) needs the broader --preserve-symlinks. BOTH are required
// -- with only -main the failure simply moved from resolveMainPath into the ESM
// loader. Verified through sandbox-logon-launcher.ps1 on reve.
const NODE_FLAGS = ['--preserve-symlinks', '--preserve-symlinks-main'];
function resolvePiCommand(explicit) {
  if (explicit) return { bin: explicit, prefix: [] };
  if (process.env.EGPT_PI_BIN) return { bin: process.env.EGPT_PI_BIN, prefix: [] };
  if (process.platform === 'win32' && process.env.APPDATA) {
    const js = join(process.env.APPDATA, 'npm', 'node_modules', ...PI_PKG);
    try { if (existsSync(js)) return { bin: process.execPath, prefix: [...NODE_FLAGS, js] }; } catch { /* PATH fallback */ }
  }
  const unixJs = join(homedir(), '.npm-global', 'lib', 'node_modules', ...PI_PKG);
  try { if (existsSync(unixJs)) return { bin: process.execPath, prefix: [...NODE_FLAGS, unixJs] }; } catch { /* PATH fallback */ }
  return { bin: 'pi', prefix: [] };
}

export function createPiCliSession(options = {}) {
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const _spawn = options.spawn || nodeSpawn;   // injectable for tests
  const { bin, prefix } = resolvePiCommand(options.bin);

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

  // Pi BLOCKS on a dialog until the client answers: docs/rpc.md — "emit an
  // extension_ui_request on stdout and block until the client sends back an
  // extension_ui_response on stdin with the matching id". Ignoring these is
  // why a tool-using turn could hang forever with no output at all.
  //
  // We answer AUTOMATICALLY. The gate for @p is not a dialog nobody can see: it
  // is the OS sandbox (sandbox-logon-launcher confines the turn to its own
  // conversation folder under a throwaway account) plus access_level /
  // allowed_users. A confirm reaching here has no human behind it, so leaving
  // it unanswered only produces a silent hang.
  function answerDialog(ev) {
    const id = ev?.id;
    if (id == null) return;
    const reply = ev.method === 'confirm'
      ? { type: 'extension_ui_response', id, confirmed: options.autoApprove !== false }
      : { type: 'extension_ui_response', id, cancelled: true };   // select/input/editor: no human to ask
    onLog(`pi-cli: dialog ${ev.method} -> ${JSON.stringify(reply)}`);
    try { proc?.stdin?.write(JSON.stringify(reply) + '\n'); } catch (e) { onLog(`pi-cli: dialog reply failed: ${e?.message ?? e}`); }
  }

  function handleEvent(ev) {
    if (ev.type === 'extension_ui_request') { answerDialog(ev); return; }
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
    // Sessions must land somewhere the SANDBOX can write. pi defaults to its
    // config dir (~/.pi/agent/sessions), which the pool has ReadAndExecute on by
    // design -- a sandboxed turn must not write into the operator's config. The
    // conversation folder is the one place it holds Modify, so point pi there.
    // Without this: EPERM mkdir on .../agent/sessions/... and pi exits 1.
    // -nc: no AGENTS.md / CLAUDE.md discovery. A being's brief is its identity.d
    // layers, delivered below via --append-system-prompt; letting pi also scoop up
    // whatever AGENTS.md happens to sit in the conversation folder or above it
    // just spends prefill on someone else's instructions (operator 2026-08-27).
    const args = [...prefix, '--mode', 'rpc', '--offline', '-nc'];
    const sessionDir = options.sessionDir || (options.cwd ? join(options.cwd, 'pi-sessions') : null);
    if (sessionDir) args.push('--session-dir', sessionDir);
    if (options.provider) args.push('--provider', options.provider);
    if (options.model) args.push('--model', options.model);
    if (options.sessionId) args.push('--session-id', String(options.sessionId));
    if (options.thinking) args.push('--thinking', String(options.thinking));
    // ALL-OR-NOTHING on purpose. A Claude list like [Read, Glob, Task] lowercases
    // to a set where only `read` matches, and honouring that partial overlap would
    // silently leave @p read-only — strictly worse than ignoring the list. So the
    // list is used only when EVERY entry names a pi tool.
    const asked = (options.allowedTools ?? []).map((t) => String(t).toLowerCase());
    if (asked.length && asked.every((t) => PI_TOOLS.has(t))) args.push('--tools', asked.join(','));
    else if (asked.length) {
      onLog(`pi-cli: allowed_tools is not a pi tool list (${options.allowedTools.join(',')}) — leaving pi's defaults enabled`);
    }
    // eGPT's persona + node identity + the ACTION vocabulary from identity.d
    // (/media, /react, /reply ...). Without this pi runs on its stock coding
    // prompt with no idea it is in a chat at all -- asked to send an image it
    // INVENTED an `upload_image` API and narrated calling it, because nothing
    // had told it /media exists (observed live 2026-08-22).
    // Passed as TEXT, like codex-cli-session's developer_instructions: verified
    // that --append-system-prompt does NOT read a path as file contents.
    if (options.appendSystemPrompt) {
      args.push('--append-system-prompt', String(options.appendSystemPrompt));
    }
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
          // images: [{ type:'image', data:<base64>, mimeType }] ride alongside the
          // text on the same prompt command (docs/rpc.md).
          const cmd = { id: nextId++, type: 'prompt', message: String(message ?? '') };
          const imgs = Array.isArray(options.images) && options.images.length
            ? options.images
            : imagesFromMessage(message, options.cwd, { log: onLog });
          if (imgs.length) cmd.images = imgs;
          proc.stdin.write(JSON.stringify(cmd) + String.fromCharCode(10));
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
