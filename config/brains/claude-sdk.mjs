// brains/claude-sdk.mjs — Anthropic claude-agent-sdk in-process.
//
// Same semantics as brains/claude-code.mjs (model, sandbox, session resume,
// tool use, append-system-prompt) but WITHOUT the per-turn `spawn('claude',
// ...)` subprocess cost. Calls into @anthropic-ai/claude-agent-sdk's
// `query()` API directly from the daemon's node process. Same auth path as
// the CLI (uses ~/.claude credentials, no separate API key needed for users
// on a Claude subscription).
//
// Operator (2026-05-21): switched from `ccode` brain to eliminate the
// 5–15s subprocess startup. Per-turn latency drops to ~500ms–2s for haiku.
//
// Interface matches brains/claude-code.mjs:
//   stream({ history, message }, onUpdate, options) → Promise<{ text, optionsPatch }>
//
// Reused from claude-code.mjs:
//   parseConversation(text, principal, brainName) → turns[]
//   (Same .md parser; /summarize and similar features walk turns identically.)

import { query } from '@anthropic-ai/claude-agent-sdk';
import { parseConversation } from './claude-code.mjs';

export const name = 'claude-sdk';
export const legacyNames = [];
export const description = 'In-process Anthropic claude-agent-sdk (replaces subprocess spawn of `claude` CLI).';
export const requires = [];

export { parseConversation };

// MSYS2/Cygwin paths translate same as claude-code.mjs.
function normalizeCwd(p) {
  if (!p) return p;
  const m = String(p).match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p;
}

// Canonical form for path-prefix comparison: drive-letter uppercased,
// separators unified to '/', trailing slash dropped, case-folded (Windows
// filesystems are case-insensitive). Conservative — when in doubt, deny.
function _normForCompare(p) {
  let s = normalizeCwd(String(p ?? '')).replace(/\\/g, '/');
  s = s.replace(/\/+$/, '');
  return s.toLowerCase();
}

// Is `target` inside one of `roots`? Boundary-safe: a root C:/a does not match
// C:/ab, only C:/a or C:/a/...
export function isUnderAnyRoot(target, roots = []) {
  const t = _normForCompare(target);
  if (!t) return false;
  return roots.some((r) => {
    const root = _normForCompare(r);
    return root && (t === root || t.startsWith(root + '/'));
  });
}

// Tools that WRITE to a path. Read/Grep/Glob are not here — read-only grants
// still allow them. Bash is denied wholesale by the sandbox already.
const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit']);

// PreToolUse hook that denies a write-class tool whose target path falls under
// a read-only grant root. A PreToolUse 'deny' bypasses the normal approval, so
// this holds even though the dir is in additionalDirectories (needed for reads).
export function makeReadOnlyHook(readOnlyRoots = [], onLog = () => {}) {
  return async (input) => {
    try {
      const tool = String(input?.tool_name ?? '').toLowerCase();
      if (!WRITE_TOOLS.has(tool)) return { continue: true };
      const inp = input?.tool_input ?? {};
      const target = inp.file_path ?? inp.path ?? inp.notebook_path ?? inp.filePath ?? null;
      if (target && isUnderAnyRoot(target, readOnlyRoots)) {
        onLog(`claude-sdk: read-only grant — denied ${tool} on ${target}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `read-only grant: ${target} may be read but not written`,
          },
        };
      }
    } catch { /* fail open to continue — the sandbox still confines paths */ }
    return { continue: true };
  };
}

// Build the static (non-runtime) SDK options from a brain `options` block.
// Pure + exported so the permission/confinement wiring is unit-testable.
// Field mapping mirrors claude-code.mjs CLI flags:
//   addDirs        → additionalDirectories
//   sessionId      → resume
//   model          → model
//   allowedTools   → bypass (trusted) | allowedTools list (restricted)
//   appendSystemPrompt → systemPrompt preset
//
// CONFINEMENT (operator 2026-05-23): a contact-facing turn passes
// confineToDirs. The leak was that the SDK loaded ~/.claude/settings.json,
// which has defaultMode:bypassPermissions + a blanket Read/Write allow —
// so a contact could read ~/.egpt/config.yaml. Fix is claude-native, not
// hand-rolled path parsing: settingSources:[] makes the SDK load NO
// settings files (no inherited bypass), and permissionMode:'default' with
// additionalDirectories scoped to ONLY this contact's dir lets the SDK's
// own permission engine refuse every other path — other contacts' dirs
// included (cross-conversation isolation). Verified live: inside=allowed,
// cross-contact=denied, ~/.egpt/config.yaml=denied.
export function buildSdkOptions(options = {}) {
  const sdkOpts = {};

  const cwd = normalizeCwd(options.cwd);
  if (cwd) sdkOpts.cwd = cwd;

  const addDirs = Array.isArray(options.addDirs)
    ? options.addDirs.filter((d) => d && typeof d === 'string')
    : [];
  if (addDirs.length) sdkOpts.additionalDirectories = addDirs;

  if (options.sessionId) sdkOpts.resume = options.sessionId;
  if (typeof options.model === 'string' && options.model.trim()) {
    sdkOpts.model = options.model.trim();
  }

  const confineRoots = Array.isArray(options.confineToDirs)
    ? options.confineToDirs.filter((d) => d && typeof d === 'string')
    : null;

  if (options.allowedTools) {
    const at = options.allowedTools;
    if (at === 'all' || at === '*') {
      // Trusted (system-e, engineers): full access; inherit normal config.
      sdkOpts.permissionMode = 'bypassPermissions';
      sdkOpts.allowDangerouslySkipPermissions = true;
    } else {
      const list = Array.isArray(at) ? at : String(at).trim().split(/\s+/).filter(Boolean);
      if (confineRoots && confineRoots.length) {
        sdkOpts.settingSources = [];          // do NOT inherit ~/.claude bypass
        sdkOpts.permissionMode = 'default';   // NOT bypass — engine enforces
        sdkOpts.additionalDirectories = [
          ...new Set([...(sdkOpts.additionalDirectories ?? []), ...confineRoots]),
        ];
        // Pre-approve ONLY non-file tools (e.g. WebFetch). File tools are
        // deliberately NOT pre-approved: an allowedTools entry bypasses the
        // permission engine for ANY path — that is exactly how Read leaked
        // even with settingSources cleared. Left un-pre-approved, file tools
        // are path-confined to additionalDirectories by the engine, while
        // Bash and anything else off the list stay denied (no approver).
        const FILE_TOOLS = new Set(['read', 'write', 'edit', 'multiedit', 'notebookedit', 'glob', 'grep']);
        const preApprove = list.filter((t) => !FILE_TOOLS.has(t.toLowerCase()));
        if (preApprove.length) sdkOpts.allowedTools = preApprove;
      } else if (list.length) {
        sdkOpts.allowedTools = list;
      }
    }
  }

  if (typeof options.appendSystemPrompt === 'string' && options.appendSystemPrompt.trim()) {
    sdkOpts.systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      append: options.appendSystemPrompt.trim(),
    };
  }

  // Read-only grants: the dirs are already in additionalDirectories (so reads
  // work); a PreToolUse hook denies write-class tools targeting them. The hook
  // is programmatic (not from a settings file), so it fires even with
  // settingSources:[].
  const readOnlyDirs = Array.isArray(options.readOnlyDirs)
    ? options.readOnlyDirs.filter((d) => d && typeof d === 'string')
    : [];
  if (readOnlyDirs.length) {
    sdkOpts.hooks = {
      ...(sdkOpts.hooks ?? {}),
      PreToolUse: [
        ...((sdkOpts.hooks?.PreToolUse) ?? []),
        { hooks: [makeReadOnlyHook(readOnlyDirs, typeof options.onLog === 'function' ? options.onLog : () => {})] },
      ],
    };
  }
  return sdkOpts;
}

export function stream({ history, message }, onUpdate, options = {}) {
  return new Promise(async (resolve, reject) => {
    const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};

    // Resume mode: send only the new user turn (the session JSONL on disk
    // already has the prior history). Stateless mode: pipe the whole
    // conversation file as one user message — same fallback as the CLI brain.
    const isResume = !!options.sessionId;
    const prompt = isResume ? (message ?? '') : (history ?? '');

    const sdkOpts = buildSdkOptions(options);
    const cwd = sdkOpts.cwd;
    if (sdkOpts.settingSources && sdkOpts.permissionMode === 'default') {
      onLog(`claude-sdk: confined=[${(sdkOpts.additionalDirectories ?? []).join(', ')}] settingSources=[] (native sandbox)`);
    }

    // Abort/timeout: same shape as the CLI brain's watchdog. Stall = no
    // progress for STALL_MS, hard = total exceeded HARD_MS.
    const STALL_MS = options.stallTimeoutMs ?? 180_000;
    const HARD_MS  = options.hardTimeoutMs  ?? 600_000;
    const abortController = new AbortController();
    sdkOpts.abortController = abortController;
    const startedAt = Date.now();
    let lastProgressAt = startedAt;
    let settled = false;

    const watchdog = setInterval(() => {
      const idle = Date.now() - lastProgressAt;
      const total = Date.now() - startedAt;
      if (idle < STALL_MS && total < HARD_MS) return;
      const reason = total >= HARD_MS ? `hard timeout ${HARD_MS}ms` : `stalled ${idle}ms`;
      onLog(`claude-sdk: aborting — ${reason}`);
      try { abortController.abort(); } catch (e) { onLog(`claude-sdk: abort threw: ${e?.message ?? e}`); }
      // Safety net: if the abort doesn't take effect (loop hangs in C++),
      // reject anyway after a grace period.
      setTimeout(() => {
        if (!settled) {
          settled = true;
          clearInterval(watchdog);
          reject(new Error(`claude-sdk: ${reason} and never settled after abort`));
        }
      }, 5000);
    }, 5000);

    const wrapReject = (err) => { if (!settled) { settled = true; clearInterval(watchdog); reject(err); } };
    const wrapResolve = (v)   => { if (!settled) { settled = true; clearInterval(watchdog); resolve(v); } };

    // Diagnostic: dump the SDK options shape so the operator can confirm
    // model / sandbox / resume flags landed. Equivalent to the CLI brain's
    // "spawn claude <args>" log line.
    try {
      const summary = {
        cwd: sdkOpts.cwd ?? null,
        model: sdkOpts.model ?? null,
        resume: sdkOpts.resume ?? null,
        permissionMode: sdkOpts.permissionMode ?? null,
        addDirs: sdkOpts.additionalDirectories ?? null,
        allowedTools: sdkOpts.allowedTools ?? null,
        settingSources: sdkOpts.settingSources ?? null,
        appendSP: !!sdkOpts.systemPrompt,
      };
      onLog(`claude-sdk: query ${JSON.stringify(summary)}`);
    } catch (e) { onLog(`claude-sdk: diag log threw: ${e?.message ?? e}`); }

    let acc = '';
    let finalText = null;
    let capturedSessionId = null;
    let firstSawSession = false;

    try {
      const q = query({ prompt, options: sdkOpts });

      for await (const msg of q) {
        lastProgressAt = Date.now();

        // Session id surfaces on every message; first-wins so a single
        // invocation locks onto one session id.
        if (typeof msg.session_id === 'string' && !capturedSessionId) {
          capturedSessionId = msg.session_id;
          if (!firstSawSession) {
            onLog(`claude-sdk: session_id ${capturedSessionId}`);
            firstSawSession = true;
          }
        }

        if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta') {
          const d = msg.event.delta;
          if (d?.type === 'text_delta' && typeof d.text === 'string') {
            acc += d.text;
            try { onUpdate(acc); } catch (e) { onLog(`claude-sdk: onUpdate threw: ${e?.message ?? e}`); }
          }
        } else if (msg.type === 'assistant' && msg.message?.content) {
          // Aggregate from the full assistant message in case partial
          // events were missed (e.g. caller disabled partial streaming).
          const text = msg.message.content
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('');
          if (text && !acc) {
            acc = text;
            try { onUpdate(acc); } catch (e) { onLog(`claude-sdk: onUpdate threw: ${e?.message ?? e}`); }
          }
        } else if (msg.type === 'result') {
          if (msg.subtype === 'success') {
            finalText = typeof msg.result === 'string' ? msg.result : '';
          } else {
            // Error subtype: surface as much detail as the SDK gave us.
            const parts = [];
            if (msg.subtype) parts.push(msg.subtype);
            if (typeof msg.result === 'string' && msg.result) parts.push(msg.result);
            if (msg.error) parts.push(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error));
            // "error_during_execution" alone is unactionable — dump the raw
            // result message so the failure is diagnosable (num_turns, is_error,
            // usage, any nested error). Truncated to keep the log sane.
            try { onLog(`claude-sdk: error result = ${JSON.stringify(msg).slice(0, 800)}`); } catch {}
            try { const { appendFileSync } = await import('node:fs'); const { homedir } = await import('node:os'); const { join } = await import('node:path'); appendFileSync(join(homedir(), '.egpt', 'logs', 'sdk-errors.log'), `${new Date().toISOString()} model=${sdkOpts.model ?? '?'} cwd=${sdkOpts.cwd ?? '?'} ${JSON.stringify(msg).slice(0, 2000)}\n`); } catch {}
          }
        }
      }

      const dur = Date.now() - startedAt;
      onLog(`claude-sdk: settled in ${dur}ms (acc=${acc.length}ch, final=${finalText ? finalText.length+'ch' : 'null'})`);
      wrapResolve({
        text: finalText ?? acc,
        optionsPatch: capturedSessionId ? { sessionId: capturedSessionId } : null,
      });
    } catch (e) {
      // AbortError when watchdog kicked in is already rejected via the
      // setTimeout above; rethrow other errors verbatim.
      if (e?.name === 'AbortError') return;   // watchdog will reject
      wrapReject(e);
    }
  });
}

// WARM session (feat/sibling-reply): one open query() in streaming-input mode,
// reused across turns — no per-turn cold start. The SDK accepts an
// AsyncIterable<SDKUserMessage> as `prompt`; we keep it open and yield one
// message per turn, reading messages until that turn's `result`. ONE turn at a
// time per session (the pool serializes). Returns { sessionId, turn, close }.
export function createWarmSession(options = {}) {
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const sdkOpts = buildSdkOptions(options);
  const abortController = new AbortController();
  sdkOpts.abortController = abortController;

  // Input pump: a generator the SDK pulls from. _push hands it the next turn;
  // _push(null) closes it (→ query ends).
  let _waiter = null;
  const _queue = [];
  let _closed = false;
  const _push = (text) => {
    const item = text === null ? null
      : { type: 'user', message: { role: 'user', content: String(text) }, parent_tool_use_id: null };
    if (_waiter) { const w = _waiter; _waiter = null; w(item); } else _queue.push(item);
  };
  async function* _input() {
    while (!_closed) {
      const next = _queue.length ? _queue.shift() : await new Promise(r => { _waiter = r; });
      if (next === null) return;
      yield next;
    }
  }

  let _pending = null;          // { resolve, reject, onUpdate, acc }
  let _readerError = null;
  let _sessionId = null;
  const session = { sessionId: null };

  const q = query({ prompt: _input(), options: sdkOpts });
  (async () => {
    try {
      for await (const m of q) {
        if (typeof m.session_id === 'string' && !_sessionId) { _sessionId = m.session_id; session.sessionId = m.session_id; onLog(`claude-sdk warm: session_id ${_sessionId}`); }
        if (!_pending) continue;
        if (m.type === 'stream_event' && m.event?.type === 'content_block_delta') {
          const d = m.event.delta;
          if (d?.type === 'text_delta' && typeof d.text === 'string') { _pending.acc += d.text; try { _pending.onUpdate(_pending.acc); } catch {} }
        } else if (m.type === 'assistant' && m.message?.content) {
          const text = m.message.content.filter(c => c.type === 'text').map(c => c.text).join('');
          if (text && !_pending.acc) { _pending.acc = text; try { _pending.onUpdate(_pending.acc); } catch {} }
        } else if (m.type === 'result') {
          const p = _pending; _pending = null;
          if (m.subtype === 'success') p.resolve({ text: (typeof m.result === 'string' && m.result) || p.acc, sessionId: _sessionId });
          else { try { onLog(`claude-sdk warm: error result ${JSON.stringify(m).slice(0, 400)}`); } catch {} p.reject(new Error(`claude-sdk warm: ${m.subtype ?? 'error'}`)); }
        }
      }
      if (_pending) { _pending.reject(new Error('claude-sdk warm: query ended mid-turn')); _pending = null; }
    } catch (e) {
      _readerError = e;
      if (_pending) { _pending.reject(e); _pending = null; }
    }
  })();

  session.turn = (message, onUpdate = () => {}) => {
    if (_closed) return Promise.reject(new Error('claude-sdk warm: session closed'));
    if (_readerError) return Promise.reject(_readerError);
    if (_pending) return Promise.reject(new Error('claude-sdk warm: turn already in progress'));
    return new Promise((resolve, reject) => { _pending = { resolve, reject, onUpdate, acc: '' }; _push(message); });
  };
  session.close = () => {
    if (_closed) return;
    _closed = true;
    _push(null);
    try { abortController.abort(); } catch {}
    try { q.return?.(); } catch {}
  };
  return session;
}
