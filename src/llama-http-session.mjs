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
// MEMORY: llama-server is a stateless completion API — there is no server-side
// thread to resume, so a thread id would point at nothing. The SESSION OBJECT is
// therefore the session: the warm pool keeps one per being per chat, and this
// module accumulates the turns in memory and replays them each turn.
//
// The current turn must be appended INTO the history array, never passed only
// alongside it: the brain drops `message` once history already holds a user
// turn. Append-only also keeps llama-server's prefix cache valid — a growing,
// stable prefix is exactly what it can reuse.
//
// This memory dies with the session (eviction, restart). Rehydrating it from the
// chat transcript — what config `resident_history_chars` was specified for — is
// a separate, undecided layer; `historyChars` here only bounds the in-memory
// tail so a long chat cannot outgrow the context window.
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
  const historyChars = Number.isFinite(options.historyChars) ? options.historyChars : 30000;
  const history = options.history ? [...options.history] : [];
  let closed = false;
  let inFlight = false;

  // Drop the OLDEST turns until the tail fits. Applied to what is SENT (the cap
  // exists to stay inside the context window, so the payload is what counts) and
  // to what is kept. The newest turn is never dropped — it is the question.
  function trimmed(turns) {
    const out = [...turns];
    let total = out.reduce((n, m) => n + String(m.content ?? '').length, 0);
    while (out.length > 1 && total > historyChars) {
      total -= String(out.shift().content ?? '').length;
    }
    return out;
  }

  return {
    async turn(message, onUpdate = () => {}) {
      if (closed) throw new Error('llama-http: session closed');
      if (inFlight) throw new Error('llama-http: a turn is already in flight (the pool must serialize per key)');
      inFlight = true;
      try {
        const msg = String(message ?? '');
        const turns = trimmed([...history, { role: 'user', content: msg }]);
        if (agentic) {
          const text = await agentLoop({
            systemPrompt: options.appendSystemPrompt,
            userText: msg,
            history: turns,
            toolsCfg: options.toolsCfg,
            sandboxRoot: options.sandboxRoot,
            sendMessage: options.sendMessage,
            confirm: options.confirm,
            url: options.url,
            model: options.model,
            maxIters: options.agenticMaxIters,
            onLog,
          });
          const out = String(text ?? '');
          history.push({ role: 'user', content: msg }, { role: 'assistant', content: out });
          history.splice(0, history.length, ...trimmed(history));
          return { text: out, sessionId: null };
        }
        // The brain resolves { text, optionsPatch } — NOT a bare string. Reading
        // it as one stringifies the object to "[object Object]" and posts THAT
        // to the chat (live bug, 2026-08-20).
        const result = await stream(
          // history stays UNDEFINED when unset — NOT []. The brain does
          // `String(history ?? message ?? '')` on the no-history path, and an
          // empty array is not nullish, so `?? []` made every prompt EMPTY
          // (live bug, 2026-08-20: the model answered nothing at all).
          { history: turns, message: msg },
          onUpdate,
          {
            url: options.url,
            model: options.model,
            appendSystemPrompt: options.appendSystemPrompt,
            onLog,
          },
        );
        const out = String(result?.text ?? '');
        // Recorded ONLY on success — a failed turn must not leave a half
        // exchange (a user line with no reply) poisoning the next prompt.
        history.push({ role: 'user', content: msg }, { role: 'assistant', content: out });
        history.splice(0, history.length, ...trimmed(history));
        return { text: out, sessionId: null };
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
