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

import { isAbsolute, join } from 'node:path';

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

// Canonical form for path comparison: msys-translate, forward slashes,
// no trailing slash, lowercased (Windows FS is case-insensitive).
export function canonPath(p) {
  return normalizeCwd(String(p ?? '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// Is `target` inside one of `roots`? Relative targets resolve against
// baseCwd. Used to confine a sandboxed conversation's file tools to its
// own directory — the guard that stops a contact reading ~/.egpt/config.yaml.
// The `rr + '/'` check prevents a sibling-prefix escape (e.g. /a/.egpt
// must NOT match /a/.egpt-evil).
export function isPathInsideRoots(target, roots, baseCwd) {
  if (!target) return true;   // tools with no path arg are not path-confined here
  const t = String(target);
  const abs = isAbsolute(t) ? t : (baseCwd ? join(baseCwd, t) : t);
  const n = canonPath(abs);
  return (roots ?? []).some((r) => {
    const rr = canonPath(r);
    return rr !== '' && (n === rr || n.startsWith(rr + '/'));
  });
}

export function stream({ history, message }, onUpdate, options = {}) {
  return new Promise(async (resolve, reject) => {
    const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};

    // Resume mode: send only the new user turn (the session JSONL on disk
    // already has the prior history). Stateless mode: pipe the whole
    // conversation file as one user message — same fallback as the CLI brain.
    const isResume = !!options.sessionId;
    const prompt = isResume ? (message ?? '') : (history ?? '');

    // Build the SDK options block. The fields mirror what claude-code.mjs
    // passes as CLI flags:
    //   --add-dir <dir>            → additionalDirectories: [dir, ...]
    //   --resume <id>              → resume: id
    //   --model <name>             → model: name
    //   --allowedTools "all" / "*" → permissionMode: 'bypassPermissions' + allow flag
    //   --allowedTools "<list>"    → allowedTools: [tool1, tool2, ...]
    //   --append-system-prompt "X" → systemPrompt: { preset: 'claude_code', append: X }
    const sdkOpts = {};

    const cwd = normalizeCwd(options.cwd);
    if (cwd) sdkOpts.cwd = cwd;

    if (Array.isArray(options.addDirs) && options.addDirs.length) {
      sdkOpts.additionalDirectories = options.addDirs.filter(d => d && typeof d === 'string');
    }
    if (isResume) sdkOpts.resume = options.sessionId;
    if (typeof options.model === 'string' && options.model.trim()) {
      sdkOpts.model = options.model.trim();
    }

    // Tool permission model — same belt+suspenders the CLI brain uses.
    const confineRoots = Array.isArray(options.confineToDirs)
      ? options.confineToDirs.filter((d) => d && typeof d === 'string')
      : null;
    if (options.allowedTools) {
      const at = options.allowedTools;
      if (at === 'all' || at === '*') {
        sdkOpts.permissionMode = 'bypassPermissions';
        sdkOpts.allowDangerouslySkipPermissions = true;
      } else {
        const list = Array.isArray(at) ? at : String(at).trim().split(/\s+/).filter(Boolean);
        if (confineRoots && confineRoots.length) {
          // SANDBOX. A PreToolUse hook — NOT canUseTool — is the gate.
          // canUseTool is skipped for read-only tools the SDK auto-approves
          // (that is exactly how Read escaped: a contact read
          // ~/.egpt/config.yaml). PreToolUse fires for EVERY tool call
          // regardless of permission mode, so it can deny out-of-sandbox
          // paths and any tool outside the permitted list.
          sdkOpts.allowedTools = list;   // pre-approve the toolset; the hook still bounds paths
          const permitted = new Set(list.map((s) => s.toLowerCase()));
          const baseCwd = cwd;
          const deny = (reason) => ({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: reason,
            },
          });
          sdkOpts.hooks = {
            PreToolUse: [{
              hooks: [async (input) => {
                const toolName = input?.tool_name ?? '';
                const ti = (input && typeof input.tool_input === 'object') ? input.tool_input : {};
                if (!permitted.has(String(toolName).toLowerCase())) {
                  return deny(`tool ${toolName} not permitted in this conversation`);
                }
                const pathArg = ti.file_path ?? ti.path ?? ti.notebook_path ?? null;
                if (pathArg && !isPathInsideRoots(pathArg, confineRoots, baseCwd)) {
                  return deny(`path outside conversation sandbox: ${pathArg}`);
                }
                return { continue: true };
              }],
            }],
          };
          onLog(`claude-sdk: sandbox confine=[${confineRoots.join(', ')}] tools=[${list.join(',')}]`);
        } else if (list.length) {
          sdkOpts.allowedTools = list;
        }
      }
    }

    // Append-system-prompt: SDK supports the same as --append-system-prompt
    // via the preset form. The 'claude_code' preset uses the CLI's default
    // system prompt as the base, then appends our text.
    if (typeof options.appendSystemPrompt === 'string' && options.appendSystemPrompt.trim()) {
      sdkOpts.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: options.appendSystemPrompt.trim(),
      };
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
