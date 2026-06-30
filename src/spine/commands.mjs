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
import { patchContact } from '../../conversations-state.mjs';

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
  // often arrives as the @lid self-jid). Authorized senders (allowed_users /
  // isSender) can command from anywhere.
  function isCommand(ev) {
    const body = String(ev?.body ?? '').trim();
    if (!body.startsWith('/')) return false;
    const selfDm = cfg().whatsapp?.chat_id;
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

    // /e auto <mode> — set THIS conversation's E reply-mode in conversations.yaml
    // (modes live there now). Typed in the chat itself, by an authorized operator.
    const auto = /^\/(?:e|egpt)\s+auto\s+(\S+)\s*$/i.exec(line);
    if (auto) {
      const mode = auto[1].toLowerCase();
      if (!isAutoMode(mode)) { await send?.(ev.chatId, `/e auto: unknown mode "${mode}" — use one of: ${AUTO_MODES.join(', ')}`); return; }
      if (!loadState || !writeState) { await send?.(ev.chatId, '/e auto: conversation state not wired'); return; }
      try {
        await writeState(patchContact(await loadState(), ev.surface, ev.chatId, { mode }));
        await send?.(ev.chatId, `✅ E mode here → ${mode}`);
      } catch (e) { onLog(`/e auto ${ev.chatId}: ${e?.message ?? e}`); await send?.(ev.chatId, `/e auto: failed — ${e?.message ?? e}`); }
      return;
    }

    const tok = line.split(/\s+/)[0];
    await send?.(ev.chatId, `${tok}: recognized — lifecycle (/restart, /upgrade, /rewind) + /e auto <mode> are wired in v2 so far.`);
  }

  return { isCommand, run };
}
