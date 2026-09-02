// bridge-fanout.mjs — ONE spine, listening on EVERY Beeper connection it holds.
//
// WHY (operator 2026-09-02). Outbound has been per-connection since 2026-08-30: an agent's
// `beeper_connection` names which connection its own sends ride, and base_url (2026-09-02) let
// those connections reach DIFFERENT Beeper Desktops — the agent's in Session 0, the operator's
// in Session 1. Inbound never caught up: the spine registered on the DEFAULT connection's
// bridge alone, so a message arriving on any other connection woke nothing. The multi-connection
// work called that "a documented gap for a follow-up"; this is the follow-up.
//
// It closes the loop the operator described: with both accounts on one machine, "e hi" arriving
// on Rodz's connection is heard by the spine that HAS E, and E's reply goes back out on Rodz's
// connection by its own `beeper_connection`. Mind and mouth in one process — no relay agent, no
// envelope, no cross-node round trip. The mesh stays for what it is uniquely good at: reaching a
// node you cannot dial.
//
// NO DEDUPLICATION, DELIBERATELY (operator's ruling). Two accounts in one real group do not see
// "the same message twice": Beeper is Matrix, each account has its own room, so one real chat is
// a DIFFERENT chatId per connection and therefore a different conversation with its own thread,
// warm process and queue. There is nothing to dedup — which of them ANSWERS is decided by
// addressing (`fallback_handle`), exactly as it already is across two nodes. A content hash here
// would have been a patch laid over a question the architecture already answers.
//
// OWNERSHIP STILL HOLDS. A connection this node does not own is wrapped outbound-only by boot
// (its onMessage/onEdit/onMedia are no-ops), so registering across every bridge automatically
// respects `owner_node` without this module knowing the rule exists.

// The three registrations that must reach EVERY connection, and the two questions that must be
// asked of ALL of them rather than of the default one.
const FANOUT_REGISTER = new Set(['onMessage', 'onEdit', 'onMedia']);

/**
 * @param {object} primary  the DEFAULT connection's bridge — every non-inbound call still lands
 *   here untouched, so every existing outbound call site behaves exactly as before.
 * @param {object[]} all    every bridge this node holds, INCLUDING the primary.
 * @returns {object} a bridge-shaped facade
 */
export function fanoutInbound(primary, all = []) {
  const bridges = (Array.isArray(all) ? all : []).filter(Boolean);
  // A single connection is the overwhelmingly common case and must cost nothing: hand back the
  // bridge itself, so a node with one Beeper account is not merely equivalent but IDENTICAL.
  if (bridges.length <= 1) return primary;

  return new Proxy(primary, {
    get(target, key, receiver) {
      if (FANOUT_REGISTER.has(key)) {
        // Register the SAME callback on every connection. Bridges that are outbound-only
        // (not owned by this node) implement these as no-ops, so ownership is honoured here
        // by construction rather than by a second rule kept in sync with the first.
        return (cb) => { for (const b of bridges) b?.[key]?.(cb); };
      }

      // THE ECHO GATE, and the reason this is not a one-line Proxy. `wasSentByUs` asks "did WE
      // post this?" — a question that is per-ACCOUNT. Asked only of the default connection, a
      // reply E sent on Rodz's connection comes back as inbound, the default bridge truthfully
      // says "not mine", and the spine processes its own reply: an echo loop, on a real account.
      // So ask EVERY connection and take ANY yes. Erring toward "ours" costs one suppressed
      // message; erring the other way costs a loop.
      if (key === 'wasSentByUs') {
        return (...args) => bridges.some((b) => !!b?.wasSentByUs?.(...args));
      }

      // stop() must reach every connection too — the spine stops "the bridge", and a connection
      // it never stopped would keep its socket open past shutdown.
      if (key === 'stop') {
        return (...args) => { for (const b of bridges) b?.stop?.(...args); };
      }

      return Reflect.get(target, key, receiver);
    },
  });
}
