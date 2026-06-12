// brains/llama.mjs — local llama.cpp via llama-server's OpenAI-compatible
// HTTP endpoint. Mirrors the warm-server pattern egpt already uses for
// whisper-server: a model kept resident in a local process, POSTed per
// turn. STATELESS — there is no session/resume; the whole conversation is
// sent as the prompt each call (same as the non-resume path of the claude
// brains). @l is a CHATTER: no tools, no filesystem — it reasons/replies.
//
// Start the server (operator, CPU-first):
//   llama-server -m <model.gguf> -c 4096 --port 8080
//   (add `-ngl 99` to offload layers to GPU when available)
//
// Interface matches the other brains:
//   stream({ history, message }, onUpdate, options) -> Promise<{ text, optionsPatch }>

export const name = 'llama';
export const legacyNames = ['local', 'llamacpp', 'llama-cpp'];
export const description = 'Local llama.cpp model via llama-server (OpenAI-compatible HTTP). Chat only — no tools.';
export const requires = [];
// No --resume: the host must NOT gate this brain on a session_id, and must
// pass the full conversation as `history` each turn.
export const sessionless = true;

const DEFAULT_URL = 'http://127.0.0.1:8080';

export function stream({ history, message }, onUpdate, options = {}) {
  return new Promise(async (resolve, reject) => {
    const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
    const base = String(options.url || options.baseUrl || DEFAULT_URL).replace(/\/+$/, '');
    const messages = [];
    if (typeof options.appendSystemPrompt === 'string' && options.appendSystemPrompt.trim()) {
      messages.push({ role: 'system', content: options.appendSystemPrompt.trim() });
    }
    // `history` may be a STRING (a single cramped prompt — engineer turns /
    // fallback) OR an ARRAY of {role,content} chat turns. The array is how a chat
    // model WANTS its context — real alternating user/assistant turns — which a
    // small model handles far better than one giant prompt (no echo/garble of the
    // last line). The host (egpt) builds the turns from the chat transcript.
    if (Array.isArray(history) && history.length) {
      for (const m of history) {
        if (m && (m.role === 'user' || m.role === 'assistant') && String(m.content ?? '').trim()) {
          messages.push({ role: m.role, content: String(m.content).trim() });
        }
      }
      if (!messages.some((m) => m.role === 'user')) messages.push({ role: 'user', content: String(message ?? '') });
    } else {
      messages.push({ role: 'user', content: String(history ?? message ?? '') });
    }

    const body = {
      messages,
      stream: true,
      ...(options.model ? { model: options.model } : {}),
      ...(Number.isFinite(options.temperature) ? { temperature: options.temperature } : {}),
      ...(Number.isFinite(options.maxTokens) ? { max_tokens: options.maxTokens } : {}),
    };

    const HARD_MS = options.hardTimeoutMs ?? 600_000;
    // Stall = no NEW token for this long. The trap on a CPU model: while
    // llama-server is PROMPT-EVALUATING a large context (cold cache, e.g. a
    // big conversation-L), the SSE stream sends NOTHING until the first
    // generated token — so a long-but-healthy prompt eval looks like a stall.
    // 120s was too tight (it aborted @l mid-prompt-eval as "aborted (timeout)"
    // before it ever spoke). 300s gives cold eval room; generation streaming
    // resets the clock per token, so a truly hung generation is still caught.
    const STALL_MS = options.stallTimeoutMs ?? 300_000;
    const ac = new AbortController();
    let settled = false;
    let lastProgress = Date.now();
    const startedAt = Date.now();
    const wd = setInterval(() => {
      const idle = Date.now() - lastProgress;
      const total = Date.now() - startedAt;
      if (idle < STALL_MS && total < HARD_MS) return;
      const why = total >= HARD_MS ? `hard timeout ${HARD_MS}ms` : `stalled ${idle}ms`;
      onLog(`llama: aborting — ${why}`);
      try { ac.abort(); } catch {}
    }, 5000);
    const done = (fn, v) => { if (!settled) { settled = true; clearInterval(wd); fn(v); } };

    onLog(`llama: POST ${base}/v1/chat/completions model=${options.model ?? '(server default)'}`);
    let acc = '';
    try {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        return done(reject, new Error(`llama-server HTTP ${res.status}: ${t.slice(0, 300) || res.statusText}`));
      }
      if (!res.body) return done(reject, new Error('llama-server: streaming response had no body'));

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: rdone } = await reader.read();
        if (rdone) break;
        lastProgress = Date.now();
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const l = line.trim();
          if (!l.startsWith('data:')) continue;
          const payload = l.slice(5).trim();
          if (payload === '[DONE]') continue;
          let ev;
          try { ev = JSON.parse(payload); } catch { continue; }
          const delta = ev?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            acc += delta;
            try { onUpdate(acc); } catch (e) { onLog(`llama: onUpdate threw: ${e?.message ?? e}`); }
          }
        }
      }
      onLog(`llama: settled in ${Date.now() - startedAt}ms (${acc.length}ch)`);
      done(resolve, { text: acc, optionsPatch: null });
    } catch (e) {
      if (e?.name === 'AbortError') return done(reject, new Error('llama: aborted (timeout)'));
      const hint = /ECONNREFUSED|fetch failed/i.test(String(e?.message ?? ''))
        ? ` — is llama-server running at ${base}? (llama-server -m <model.gguf> --port 8080)`
        : '';
      done(reject, new Error(`llama: ${e?.message ?? e}${hint}`));
    }
  });
}

// Non-streaming chat turn WITH tool support, for the agentic loop. Tool calls
// can't be cleanly reassembled from SSE deltas, so this uses a buffered
// (stream:false) request and returns the assistant message verbatim:
//   { content, toolCalls } — toolCalls is the OpenAI tool_calls array (each
//   { id, function: { name, arguments(JSON string) } }), [] when none.
// `messages` is the full OpenAI-format conversation (system/user/assistant/
// tool). `tools` is the schema array (omit/empty = a plain completion).
export async function chatWithTools({ messages, tools }, options = {}) {
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const base = String(options.url || options.baseUrl || DEFAULT_URL).replace(/\/+$/, '');
  const body = {
    messages,
    stream: false,
    ...(Array.isArray(tools) && tools.length ? { tools, tool_choice: 'auto' } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(Number.isFinite(options.temperature) ? { temperature: options.temperature } : {}),
    ...(Number.isFinite(options.maxTokens) ? { max_tokens: options.maxTokens } : {}),
  };
  onLog(`llama: tool-turn POST ${base}/v1/chat/completions (${messages.length} msgs, ${tools?.length ?? 0} tools)`);
  let res;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.hardTimeoutMs ?? 600_000),
    });
  } catch (e) {
    const hint = /ECONNREFUSED|fetch failed/i.test(String(e?.message ?? ''))
      ? ` — is llama-server running at ${base}?` : '';
    throw new Error(`llama: ${e?.message ?? e}${hint}`);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`llama-server HTTP ${res.status}: ${t.slice(0, 300) || res.statusText}`);
  }
  const j = await res.json();
  const msg = j?.choices?.[0]?.message ?? {};
  return { content: String(msg.content ?? ''), toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [] };
}
