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

export function createCommands({
  getConfig = () => ({}),
  send,                                  // (chatId, text) -> deliver a plain system reply
  exit = (code) => process.exit(code),
  writeRewindTarget,
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
      exit(code);                          // process leaves; the daemon respawns (43) / upgrades (42) / rewinds (44)
      return;
    }
    const tok = line.split(/\s+/)[0];
    await send?.(ev.chatId, `${tok}: recognized — only lifecycle (/restart, /upgrade, /rewind) is wired in v2 so far.`);
  }

  return { isCommand, run };
}
