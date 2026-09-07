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

// The three registrations that must reach EVERY connection, and the three questions that must be
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

      // THE ROSTER QUESTION, and it is per-ACCOUNT for the same reason wasSentByUs is (operator
      // 2026-09-07). `fallback_handle`'s `unless_present` asks "is that identity in THIS chat"
      // (router.mjs, via boot's `isPresent: (identity, ev) => bridge.chatHasParticipant(ev.chatId,
      // identity)`) — and `bridge` is THIS facade. Asked only of the default connection it was
      // asked about a chatId that connection has never seen: one real group is a DIFFERENT room
      // per account (crossAccountChatKey's header, measured live 2026-09-05), so the default
      // Desktop 404s, chatInfo leaves `participants: null`, and the answer is UNKNOWN. Measured
      // consequence on a two-account node: in a group only the SECOND account is in, the fallback
      // was silenced by that unknown and NOBODY answered a message addressed to this node.
      //
      // NOT `.some()`, unlike wasSentByUs: the answer is true | false | null and a null must stay
      // null. `.some()` would read "the account that has this chat says NO" and "nobody here has
      // this chat" as the same thing — the second is exactly the state the router must fail closed
      // on. So: any definite TRUE wins, else any definite FALSE, else UNKNOWN. Because chat ids
      // are per-account, at most one connection ever holds a definite answer, which makes this
      // "ask the one that knows" rather than a vote.
      //
      // A THROW is one connection's failure, not the node's: it becomes that connection's null and
      // the connection that actually has the chat still answers. The router's own try/catch around
      // isPresent (router.mjs presentInChat) still covers a facade-level failure.
      //
      // THE COST, NAMED AND ACCEPTED (operator 2026-09-07) — so the next reader does not rediscover
      // it as a bug. Every connection that does NOT have this chat pays a real GET, and pays it
      // again next time: beeper.mjs's chatInfo leaves `participants: null` on a failed GET, and
      // chatHasParticipant's `fresh` test requires participants, so a negative never caches. That
      // is one extra loopback 404 (and one "no roster in the chat payload; membership UNKNOWN"
      // bridge-log line) per GUARDED mention per non-owning connection — N-1 of them, so exactly
      // one on a two-account node.
      //
      // Acceptable, and NOT worth a negative cache today: the path runs only for a hit that already
      // matched a `fallback_handle` token and survived the surface pin and allowed_users, the
      // router asks once per resolve() (its `presence` Map), the requests go out together rather
      // than in series, and a human types those mentions at human rates. Caching the negative would
      // also point the wrong way — "this account does not have this chat" is exactly the fact that
      // changes when the account is added to a group, which is the event the roster TTL exists to
      // notice. If the log noise ever does matter, the smallest fix is in beeper.mjs: let chatInfo
      // distinguish a 404 from a failed GET and let `fresh` accept a 404-negative for the TTL.
      if (key === 'chatHasParticipant') {
        return async (...args) => {
          const answers = await Promise.all(bridges.map(async (b) => {
            try { return await b?.chatHasParticipant?.(...args); } catch { return null; }
          }));
          if (answers.some((a) => a === true)) return true;
          if (answers.some((a) => a === false)) return false;
          return null;
        };
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
