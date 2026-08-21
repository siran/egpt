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

export function createLlamaHttpSession(options = {}) {
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const stream = options.stream || llamaStream;   // injectable for tests
  let closed = false;
  let inFlight = false;

  return {
    async turn(message, onUpdate = () => {}) {
      if (closed) throw new Error('llama-http: session closed');
      if (inFlight) throw new Error('llama-http: a turn is already in flight (the pool must serialize per key)');
      inFlight = true;
      try {
        const text = await stream(
          { history: options.history ?? [], message: String(message ?? '') },
          onUpdate,
          {
            url: options.url,
            model: options.model,
            appendSystemPrompt: options.appendSystemPrompt,
            onLog,
          },
        );
        return { text: String(text ?? ''), sessionId: null };
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
