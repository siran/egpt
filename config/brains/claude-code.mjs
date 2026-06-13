// brains/claude-code.mjs — local `claude` CLI as subprocess.
// Two modes:
//   - stateless (default): each turn pipes the entire conversation file as
//                          one user message (a structured transcript). claude
//                          reads it as the full context and responds to the
//                          implied "what's next?" Anthropic's prompt cache
//                          catches the unchanging prefix between turns.
//   - resume:              when options.sessionId is set, runs `claude --resume`
//                          and pipes only the new user message; claude has the
//                          session history in its JSONL already.
//
// Note on `--input-format stream-json`: tested but unsuitable. It treats each
// user message in the stream as a separate query (claude responds to each in
// turn) rather than as pre-populated history. So we can't use it to inject
// prior assistant turns as context. The proper-turns optimization will require
// a --resume-with-delta-injection refactor in a future commit.
//
// `parseConversation()` is exported anyway because /summarize and similar
// future features need to walk the .md as structured turns.
import { spawn } from 'node:child_process';
import { buildClaudeArgs } from '../../src/claude-args.mjs';

export const name = 'ccode';
export const legacyNames = ['claude-code'];
export const description = 'Local `claude` CLI; optionally --resume to extend an existing session.';
export const requires = [];

// MSYS2/Cygwin paths like "/c/Users/an/src/foo" don't work as Node spawn cwd
// on Windows. Translate them to "C:/Users/an/src/foo".
function normalizeCwd(p) {
  if (!p) return p;
  const m = p.match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p;
}

// Parse a conversation.md file into role-tagged turns.
//   author === principal | brainName → assistant (claude's own past output)
//   author === "You"                 → user, no prefix
//   author === "system"              → user, "(system note) " prefix
//                                       (system-author lines from /rules etc.)
//   anything else (cgpt1, ...)       → user, "[author]: " prefix
// This preserves cross-brain visibility while letting claude read each turn
// as a real conversation participant rather than a single mega-blob.
export function parseConversation(text, principal, brainName = name) {
  const lines = text.split('\n');
  const turns = [];
  let author = null;
  let buf = [];

  const flush = () => {
    if (!author) return;
    const body = buf.join('\n').trim();
    if (!body) { author = null; buf = []; return; }
    let role, content;
    if (author === principal || author === brainName) {
      role = 'assistant'; content = body;
    } else if (author === 'You') {
      role = 'user'; content = body;
    } else if (author === 'system') {
      role = 'user'; content = `(system note) ${body}`;
    } else {
      role = 'user'; content = `[${author}]: ${body}`;
    }
    turns.push({ role, content });
    author = null; buf = [];
  };

  for (const line of lines) {
    const m = line.match(/^## (\S.*?) — (.+)$/);
    if (m) { flush(); author = m[2]; }
    else if (author) { buf.push(line); }
  }
  flush();
  return mergeAdjacentSameRole(turns);
}

// Anthropic's Messages API expects alternating user/assistant turns. When
// several non-claude authors speak in a row (multiple humans or a brain reply
// before claude weighs in), they all map to consecutive `user` turns. Merge
// them into one user turn whose body preserves both contributions, separated
// by a blank line. Same for any accidental consecutive-assistant case.
function mergeAdjacentSameRole(turns) {
  const merged = [];
  for (const t of turns) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === t.role) {
      prev.content = prev.content + '\n\n' + t.content;
    } else {
      merged.push({ ...t });
    }
  }
  return merged;
}


export function stream({ history, message }, onUpdate, options = {}) {
  return new Promise((resolve, reject) => {
    // argv from the tested confinement mapper (src/claude-args.mjs) — the CLI
    // mirror of claude-sdk.mjs buildSdkOptions. Maps allowedTools/bypass, the
    // confineToDirs sandbox (--setting-sources '' + permission-mode default +
    // path-confined file tools), --add-dir, model, --effort, --resume, and the
    // append-system nudge; THROWS on readOnlyDirs (never drop a write-deny grant
    // silently). Locked by tests/claude-args.test.mjs. This CLOSES a real gap:
    // the old inline build silently ignored confineToDirs/readOnlyDirs, so a
    // confined turn that landed on ccode ran UNCONFINED.
    const args = buildClaudeArgs(options);
    const isResume = !!options.sessionId;

    const spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'] };
    const cwd = normalizeCwd(options.cwd);
    if (cwd) spawnOpts.cwd = cwd;

    // Diagnostic: surface the actual claude args via onLog so the
    // user can confirm via /log that tool-permission flags were
    // passed. Cheap (one log line per turn) and saves a lot of
    // "why is the persona claiming no web access" debugging.
    if (typeof options.onLog === 'function') {
      try { options.onLog(`claude-code: spawn claude ${args.join(' ')}`); } catch (e) { console.error(`!! claude-code.mjs:[catch] ${e?.message ?? e}`); }
    }
    const proc = spawn('claude', args, spawnOpts);

    // Watchdog: kill the subprocess if it produces no output for
    // STALL_MS (likely hung) or runs longer than HARD_MS (runaway).
    // Real-world failure mode (2026-05-17): claude subprocess exits
    // but Node's 'close' event never fires (stdio pipe stays half-
    // open), so the awaiting daemon spins forever. Without this
    // watchdog the only recovery is a manual daemon restart.
    const STALL_MS = options.stallTimeoutMs ?? 180_000;
    const HARD_MS  = options.hardTimeoutMs  ?? 600_000;
    const startedAt = Date.now();
    let lastProgressAt = startedAt;
    const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
    const watchdog = setInterval(() => {
      const idle = Date.now() - lastProgressAt;
      const total = Date.now() - startedAt;
      if (idle < STALL_MS && total < HARD_MS) return;
      const reason = total >= HARD_MS ? `hard timeout ${HARD_MS}ms` : `stalled ${idle}ms`;
      try { onLog(`claude-code: killing pid ${proc.pid} — ${reason} (acc=${acc.length}ch)`); } catch {}
      try { proc.kill('SIGTERM'); } catch {}
      // Hard kill after 2s grace if SIGTERM didn't take.
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
      // Don't reject here — let close/error handler fire naturally.
      // If close still doesn't fire after kill, the safety net below trips.
      setTimeout(() => {
        if (!settled) {
          settled = true;
          clearInterval(watchdog);
          reject(new Error(`claude-code: pid ${proc.pid} ${reason} and never closed after kill`));
        }
      }, 5000);
    }, 5000);
    let settled = false;
    const wrapReject = (err) => { if (!settled) { settled = true; clearInterval(watchdog); reject(err); } };
    const wrapResolve = (v)   => { if (!settled) { settled = true; clearInterval(watchdog); resolve(v); } };

    let buf = '';
    let acc = '';
    let finalText = null;
    let stderrBuf = '';
    // Non-JSON stdout lines (e.g. the CLI's "invalid model" / usage text
    // when it dies before emitting stream-json). Without this they're
    // dropped at the JSON.parse guard below, so a nonzero exit reports
    // "no stderr" with nothing to debug. Capped — we only need the tail.
    let rawTail = '';
    // Captured from claude's stream-json events. The CLI emits a
    // 'system'/'init' event at start with session_id; we surface it
    // back to the host via optionsPatch so subsequent calls can pass
    // it as --resume. Without this, every persona invocation starts
    // a brand-new conversation.
    let capturedSessionId = null;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      lastProgressAt = Date.now();
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let ev;
        try { ev = JSON.parse(t); } catch {
          rawTail = (rawTail + '\n' + t).slice(-1000);
          continue;
        }

        // Capture session_id from any event that carries it (the
        // system/init event is typical, but be liberal). First-wins
        // so a single invocation locks onto one session id.
        if (typeof ev.session_id === 'string' && !capturedSessionId) {
          capturedSessionId = ev.session_id;
        }

        if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') {
          const d = ev.event.delta;
          if (d?.type === 'text_delta' && typeof d.text === 'string') {
            acc += d.text;
            onUpdate(acc);
          }
        } else if (ev.type === 'assistant' && ev.message?.content) {
          const text = ev.message.content
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('');
          if (text && !acc) { acc = text; onUpdate(acc); }
        } else if (ev.type === 'result') {
          if (ev.subtype === 'success' && typeof ev.result === 'string') {
            finalText = ev.result;
          } else if (ev.subtype && ev.subtype !== 'success') {
            // The 'result' event for an error subtype can carry useful detail
            // in any of: ev.error (string), ev.message (string|object),
            // ev.result (sometimes a fallback message). We surface all of them
            // plus the current stderr buffer and the raw event JSON, because
            // "error_during_execution" alone is unactionable.
            const parts = [];
            if (ev.error) parts.push(typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error));
            if (ev.message) parts.push(typeof ev.message === 'string' ? ev.message : JSON.stringify(ev.message));
            if (typeof ev.result === 'string' && ev.result) parts.push(ev.result);
            if (stderrBuf.trim()) parts.push(`stderr: ${stderrBuf.trim()}`);
            // Append a truncated raw event for the irreducible-mystery case.
            try {
              const raw = JSON.stringify(ev);
              if (parts.length === 0) parts.push(`raw event: ${raw.slice(0, 600)}${raw.length > 600 ? '…' : ''}`);
            } catch {}
            const detail = parts.join('\n  ');
            return wrapReject(new Error(`claude: ${ev.subtype}${detail ? '\n  ' + detail : ''}`));
          }
        }
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', c => { lastProgressAt = Date.now(); stderrBuf += c; });

    proc.on('close', code => {
      const dur = Date.now() - startedAt;
      try { onLog(`claude-code: pid ${proc.pid} exit ${code} after ${dur}ms (acc=${acc.length}ch, final=${finalText ? finalText.length+'ch' : 'null'})`); } catch {}
      if (code !== 0) {
        const diag = stderrBuf.trim()
          || rawTail.trim()
          || `no stderr/stdout (model=${options.model ?? 'default'}, resume=${options.sessionId ?? 'none'})`;
        return wrapReject(new Error(`claude exit ${code}: ${diag}`));
      }
      const text = finalText ?? acc;
      // Object return form: runBrainTurn / runDefaultBrainTurn both
      // recognize { text, optionsPatch } and persist optionsPatch
      // back into the session config (so the next call gets
      // --resume <session>). When session_id wasn't surfaced for
      // any reason, optionsPatch is null and runBrainTurn falls
      // back to its legacy string-handling path.
      wrapResolve({
        text,
        optionsPatch: capturedSessionId ? { sessionId: capturedSessionId } : null,
      });
    });
    proc.on('error', err => {
      if (err.code === 'ENOENT') {
        // ENOENT can mean either the binary or the cwd is missing. Disambiguate.
        const msg = cwd
          ? `spawn ENOENT: claude binary or cwd not found. cwd=${cwd}, original options.cwd=${options.cwd ?? '(none)'}`
          : 'claude not found on PATH';
        return wrapReject(new Error(msg));
      }
      wrapReject(err);
    });

    // Resume mode: send only the new user turn (claude has session in JSONL).
    // Stateless mode: pipe the whole conversation file as one user message.
    proc.stdin.write(isResume ? (message ?? '') : (history ?? ''));
    proc.stdin.end();
  });
}
