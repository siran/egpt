// src/wa-joined.mjs — the WA "joined / bound" chat set (from /use, /join),
// lifted out of egpt-spine.mjs's App component (Phase C strangler). It owns the
// set + the empty/single/multi accessors so callers don't special-case them; the
// bridge-bypass side-effect is INJECTED (`syncBypass`) so this module stays
// transport-agnostic.
//
// Each entry: { jid, dir? } where dir ∈ 'both' | 'in' | 'out' (default 'both'):
//   'both' — bidirectional · 'in' — chat→shell only · 'out' — shell→chat only.

export function createJoinedChats({ syncBypass = () => {} } = {}) {
  let map = null;   // jid -> entry; null when empty (preserves the legacy ref shape)

  const all = () => (map ? [...map.values()] : []);
  // Outgoing targets: chats that should receive shell-typed text.
  const outgoing = () => all().filter((e) => (e.dir ?? 'both') !== 'in');
  // Incoming-allowed: chats whose arrivals should render in shell.
  const incomingAllowed = (jid) => {
    const e = map?.get(jid);
    if (!e) return false;
    return (e.dir ?? 'both') !== 'out';
  };
  const first = () => (map && map.size > 0 ? map.values().next().value : null);
  const has = (jid) => !!(map && map.has(jid));
  const size = () => map?.size ?? 0;

  const add = (entry) => {
    if (!map) map = new Map();
    map.set(entry.jid, entry);
    syncBypass();
  };
  const remove = (jid) => {
    if (!map) return false;
    const removed = map.delete(jid);
    if (map.size === 0) map = null;
    syncBypass();
    return removed;
  };
  const clear = () => { map = null; syncBypass(); };

  return { all, outgoing, incomingAllowed, first, has, size, add, remove, clear };
}
