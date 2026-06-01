// src/attach/protocol.mjs — wire format for the loopback-TCP attach channel
// between the nucleus (server) and thin-client surfaces (TTY shell, extension).
//
// Framing: newline-delimited JSON ("NDJSON"). One JSON object per line; '\n'
// terminates a frame. JSON.stringify never emits a raw newline (newlines inside
// strings are escaped as \n), so a literal '\n' is an unambiguous delimiter.
//
// Every frame has a string `t` (type). Payload fields are type-specific and
// documented inline below. Auth: the client's first frame is HELLO carrying a
// `sig` (HMAC over a challenge, produced by src/tools/bus-sign.mjs); the server
// verifies before accepting any further frames.

// client → nucleus
export const C2N = Object.freeze({
  HELLO:  'hello',    // { kind, cols, rows, sig }   first frame; authenticates the client
  INPUT:  'input',    // { chatId?, text }           a typed line / command from the operator
  RESIZE: 'resize',   // { cols, rows }              terminal size changed
  PING:   'ping',     // {}                          liveness keepalive
});

// nucleus → client
export const N2C = Object.freeze({
  WELCOME:    'welcome',    // { nucleusPid, version }   handshake accepted
  ITEM:       'item',       // { author, body, ... }     render/mirror one output item
  STREAM:     'stream',     // { id, chunk }             streaming partial (brain still typing)
  STREAM_END: 'streamEnd',  // { id, text }              stream finished; final text
  SYS:        'sys',        // { body }                  system line (status, errors)
  PONG:       'pong',       // {}                        reply to PING
  BYE:        'bye',        // { reason }                nucleus is exiting (e.g. /restart) — reconnect
});

const ALL_TYPES = new Set([...Object.values(C2N), ...Object.values(N2C)]);
export function isKnownType(t) { return ALL_TYPES.has(t); }

// Encode one frame object to a single NDJSON line (with trailing '\n').
export function encodeFrame(frame) {
  if (!frame || typeof frame !== 'object' || typeof frame.t !== 'string') {
    throw new Error('encodeFrame: frame must be an object with a string .t');
  }
  return JSON.stringify(frame) + '\n';
}

// A stateful line decoder. Feed it arbitrary chunks (string or Buffer); it
// returns an array of parsed frame objects for every COMPLETE line seen so far,
// buffering any trailing partial line for the next feed. Malformed lines are
// surfaced via onError (if given) and skipped — a single bad frame must never
// desync the stream. This is the only stateful piece of the protocol; both the
// server (per connection) and the client own one decoder.
export function createFrameDecoder({ onError = null } = {}) {
  let buf = '';
  return function feed(chunk) {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const out = [];
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const s = line.trim();
      if (!s) continue;                                   // tolerate blank lines / keepalive newlines
      let frame;
      try { frame = JSON.parse(s); }
      catch (e) { onError?.(new Error(`bad frame JSON: ${e.message}`), s); continue; }
      if (!frame || typeof frame.t !== 'string') { onError?.(new Error('frame missing string .t'), s); continue; }
      out.push(frame);
    }
    return out;
  };
}
