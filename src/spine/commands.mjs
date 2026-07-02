// commands.mjs — the §2c command intercept: an operator's slash command (typed
// in the Self DM, or from any authorized sender) is handled HERE, not routed to
// the brain. v2's loop otherwise sends every inbound to E — so "/restart" went to
// the persona instead of bouncing the node.
//
// v1 wires the LIFECYCLE commands (the operator's standing need: control the node
// from Self) via the same exit-code path as ingest. The other ~50 slash/*.mjs
// commands need a richer ctx (sessions, bridge, channels) and land as that ctx is
// built (Phase 4c); until then they are RECOGNIZED (not leaked to E) and answered
// with a short note.
import { lifecycleExit } from './ingest.mjs';
import { isAutoMode, AUTO_MODES } from '../auto-mode.mjs';
import { patchContact, getContact } from '../../conversations-state.mjs';

// Resolve a target chat for `/e auto <mode> <target>` (so the operator can set a
// remote chat's mode from the Self DM). A verbatim @jid / room-id is used as-is;
// otherwise a fuzzy slug/name fragment is matched against the surface's contacts —
// exactly one must match (else: not-found / ambiguous). Conv-state only: the chat
// you'd set a mode for is one E has already seen, so it is a contact.
function resolveTarget(state, term, surface) {
  if (/[@!]|:beeper/.test(term)) {
    // A verbatim jid must still be a chat E has seen — else patchContact silently
    // no-ops (returns state unchanged) and we'd report a false "✅" for a typo'd or
    // never-seen id. Resolve it through getContact so a bad id fails loudly here.
    const c = getContact(state, surface, term);
    if (!c) return { error: `no chat matches "${term}" — E hasn't seen that chat id` };
    return { jid: c.jid, name: c.slug };
  }
  const bucket = state?.contacts?.[surface] ?? {};
  const needle = term.toLowerCase();
  const hits = [];
  for (const [jid, entry] of Object.entries(bucket)) {
    if (!entry || entry.aliasOf || !entry.slug) continue;
    const name = String(entry.pushedName ?? entry.slug);
    if (name.toLowerCase().includes(needle) || String(entry.slug).toLowerCase().includes(needle)) hits.push({ jid, name });
  }
  if (!hits.length) return { error: `no chat matches "${term}" — try the exact name or its @jid` };
  if (hits.length > 1) return { error: `"${term}" matches ${hits.length}: ${hits.slice(0, 6).map((h) => h.name).join(', ')} — be more specific` };
  return hits[0];
}

export function createCommands({
  getConfig = () => ({}),
  send,                                  // (chatId, text) -> deliver a plain system reply
  exit = (code) => process.exit(code),
  writeRewindTarget,
  loadState = null, writeState = null,   // conv-state IO — lets /e auto persist a mode
  onLog = () => {},
} = {}) {
  const cfg = () => getConfig() ?? {};

  // Same id in any form counts as the Self DM (lid vs phone-form — a /restart
  // often arrives as the @lid self-jid). The Self DM is PER-SURFACE now (operator
  // 2026-07-02): a /restart typed in the telegram surface's own chat_id is checked
  // against cfg.telegram.chat_id, not whatsapp's — ids are per-surface namespaces.
  // Fall back to the whatsapp block when ev.surface is absent (safety). Authorized
  // senders (per-surface allowed_users / isSender) can command from anywhere.
  function isCommand(ev) {
    const body = String(ev?.body ?? '').trim();
    if (!body.startsWith('/')) return false;
    const selfDm = cfg()[ev?.surface ?? 'whatsapp']?.chat_id;
    return (selfDm && ev.chatId === selfDm) || !!ev.authorized || !!ev.isSender;
  }

  async function run(ev) {
    const line = String(ev.body ?? '').trim();
    const code = lifecycleExit(line, { writeRewindTarget });
    if (code != null) {
      onLog(`${line} -> exit ${code}`);
      await exit(code);                    // process leaves (after the bridge's "restarting…" announce); the daemon respawns
      return;
    }

    // /e auto <mode> [<target>] — set a conversation's E reply-mode (modes live in
    // conversations.yaml now). In a chat: omit <target> to set THIS chat. From the
    // Self DM: name the target chat (slug/name fragment, or its @jid / room-id).
    const auto = /^\/(?:e|egpt)\s+auto\s+(\S+)(?:\s+(.+?))?\s*$/i.exec(line);
    if (auto) {
      const mode = auto[1].toLowerCase();
      const targetTerm = auto[2]?.trim() || null;
      if (!isAutoMode(mode)) { await send?.(ev.chatId, `/e auto: unknown mode "${mode}" — use one of: ${AUTO_MODES.join(', ')}`); return; }
      if (!loadState || !writeState) { await send?.(ev.chatId, '/e auto: conversation state not wired'); return; }
      try {
        const state = await loadState();
        let jid = ev.chatId, where = 'here';
        if (targetTerm) {
          const r = resolveTarget(state, targetTerm, ev.surface);
          if (r.error) { await send?.(ev.chatId, `/e auto: ${r.error}`); return; }
          jid = r.jid; where = `for ${r.name}`;
        }
        await writeState(patchContact(state, ev.surface, jid, { mode }));
        await send?.(ev.chatId, `✅ E mode ${where} → ${mode}`);
      } catch (e) { onLog(`/e auto ${ev.chatId}: ${e?.message ?? e}`); await send?.(ev.chatId, `/e auto: failed — ${e?.message ?? e}`); }
      return;
    }

    const tok = line.split(/\s+/)[0];
    await send?.(ev.chatId, `${tok}: recognized — lifecycle (/restart, /upgrade, /rewind) + /e auto <mode> are wired in v2 so far.`);
  }

  return { isCommand, run };
}
