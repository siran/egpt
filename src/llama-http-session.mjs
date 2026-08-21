// llama-http-session.mjs — a session over the LOCAL llama-server (@l).
//
// The odd one out among engines. ccode and codex both spawn a CLI and talk
// stdio; this one is plain HTTP against llama-server's OpenAI-compatible
// endpoint, and the brain is SESSIONLESS (config/brains/llama.mjs exports
// `sessionless = true`): there is no server-side thread to resume, so
// `sessionId` is always null.
//
// Warmth therefore lives somewhere else than for the CLI engines. It is not
// this process — it is llama-server's PREFIX CACHE: a repeated prompt prefix
// re-prefills in ~1s instead of minutes (measured 2026-08-20: 94s cold, 1.3s
// warm on a 2825-token prefix). Which is why the HOST must feed a STABLE,
// APPEND-ONLY history per chat — a reordered or rewritten prefix throws the
// cache away and the turn pays full prefill again.
//
// History: the brain accepts `{ history, message }` where history is either an
// array of {role,content} turns or a single string. eGPT owns the per-chat
// transcript (config `resident_history_chars`), so the host composes it and
// passes it in; this module just forwards.
//
// Interface = what src/warm-sessions.mjs (createWarmPool) expects:
//   turn(message, onUpdate) -> { text, sessionId }   ·   close()
// The pool owns lazy-warm, idle-evict, LRU and per-key serialization, so this
// primitive only guards that ONE turn runs at a time.
import { stream as llamaStream } from '../config/brains/llama.mjs';
import { runAgentLoop } from './tools/agent-loop.mjs';

export function createLlamaHttpSession(options = {}) {
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const stream = options.stream || llamaStream;        // injectable for tests
  const agentLoop = options.agentLoop || runAgentLoop;  // injectable for tests
  // AGENTIC (config local_llm.agentic): run eGPT's ReAct loop against the
  // permission-gated tool registry instead of a plain chat turn. OFF keeps @l
  // a pure chatter — which is the shipped default, because an unleashed local
  // model will not self-refuse a destructive call (see tools/agent-tools.mjs).
  // NOTE: the loop does not stream, so onUpdate never fires in this mode.
  const agentic = options.agentic === true;
  let closed = false;
  let inFlight = false;

  return {
    async turn(message, onUpdate = () => {}) {
      if (closed) throw new Error('llama-http: session closed');
      if (inFlight) throw new Error('llama-http: a turn is already in flight (the pool must serialize per key)');
      inFlight = true;
      try {
        if (agentic) {
          const text = await agentLoop({
            systemPrompt: options.appendSystemPrompt,
            userText: String(message ?? ''),
            toolsCfg: options.toolsCfg,
            sandboxRoot: options.sandboxRoot,
            sendMessage: options.sendMessage,
            confirm: options.confirm,
            url: options.url,
            model: options.model,
            maxIters: options.agenticMaxIters,
            onLog,
          });
          return { text: String(text ?? ''), sessionId: null };
        }
        // The brain resolves { text, optionsPatch } — NOT a bare string. Reading
        // it as one stringifies the object to "[object Object]" and posts THAT
        // to the chat (live bug, 2026-08-20).
        const result = await stream(
          // history stays UNDEFINED when unset — NOT []. The brain does
          // `String(history ?? message ?? '')` on the no-history path, and an
          // empty array is not nullish, so `?? []` made every prompt EMPTY
          // (live bug, 2026-08-20: the model answered nothing at all).
          { history: options.history, message: String(message ?? '') },
          onUpdate,
          {
            url: options.url,
            model: options.model,
            appendSystemPrompt: options.appendSystemPrompt,
            onLog,
          },
        );
        return { text: String(result?.text ?? ''), sessionId: null };
      } finally {
        inFlight = false;   // release even when the brain throws, so the next turn can run
      }
    },
    close() {
      closed = true;
    },
    get sessionId() { return null; },
  };
}
