// brains/don.mjs — @d: a REMOTE egpt agent (Don) reachable over the LAN via the
// agent endpoint (src/tools/agent-endpoint.mjs) running inside egpt on another
// machine (DOLLY). egpt dials it like any sibling; Don holds its OWN resumable
// Claude session on the far side, so from egpt's view this brain is sessionless
// — it ships the new turn and returns Don's reply.
//
// Transport is HTTP request/response (no text-length / media / file limits that
// a bot channel would impose), HMAC-signed with the shared `agent_token`. This
// is the egpt<->egpt channel the operator chose (2026-06-12); Telegram is only a
// watch-mirror, not the transport. Mirrors the llama brain's shape:
//
//   stream({ message }, onUpdate, { url, agentToken, from }) -> { text }
//
// The reply rides egpt's normal gated + logged sibling path, so it surfaces back
// in the chat @d was addressed from and lands in that chat's transcript.md.

import { postAgentTurn } from '../../src/tools/agent-endpoint.mjs';

export const name = 'don';
export const description = 'Remote egpt agent (Don) over the LAN agent endpoint — HTTP request/response, HMAC-authed. Don keeps its session on the far machine.';
export const requires = [];
// Sessionless FROM EGPT'S VIEW: egpt does not manage a session id — Don keeps
// its own conversation on the far side. So egpt sends only the new turn
// (`message`); the host-supplied `history` is ignored (Don remembers).
export const sessionless = true;

export async function stream({ history, message } = {}, onUpdate = () => {}, options = {}) {
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const endpoint = options.url || options.endpoint;
  const keyB64 = options.agentToken || options.agent_token;
  if (!endpoint) throw new Error('don: no endpoint url — set siblings.<name>.url to the DOLLY agent endpoint (e.g. http://192.168.1.102:23391)');
  if (!keyB64) throw new Error('don: no agent_token — set agent_token in config.local.json (same value as the worker)');

  const msg = String(message ?? history ?? '').trim();
  const text = await postAgentTurn(msg, {
    endpoint,
    keyB64,
    from: options.from || 'spine',
    timeoutMs: Number(options.hardTimeoutMs) || 600_000,
  }, onLog);

  // HTTP is request/response, not streamed — surface the whole reply once so the
  // dispatch layer's onUpdate/coalesce path sees it like any other brain.
  try { onUpdate(text); } catch (e) { onLog(`don: onUpdate threw: ${e?.message ?? e}`); }
  return { text, optionsPatch: null };
}
