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
            return wrapReject(new Error(`claude-sdk: ${parts.join(' — ') || 'error_during_execution'}`));
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
