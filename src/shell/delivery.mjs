// src/shell/delivery.mjs — pure formatting for delivery-failure notices.
//
// server.send() (src/shell/server.mjs) returns false in exactly two cases — no spine
// connected, or the WS write itself threw (caught there and only reaching its own onLog
// sink, which egpt.mjs currently wires to a no-op) — collapsed to a single boolean with no
// reason string reaching the caller. This module turns that boolean, plus whether the
// server reported itself connected at send-time, into the verbose transcript line the
// operator asked for instead of the send failure being dropped silently.
export function notDeliveredMessage(wasConnected) {
  return wasConnected
    ? '⚠ not delivered: send failed while connected to the spine — see editor logs'
    : '⚠ not delivered: spine is not connected (up to ~60s after a fresh start)';
}
