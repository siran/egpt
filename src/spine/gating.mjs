// gating.mjs — the §2c gating service: the per-chat mode + pause + mention gate
// (contracts C4.1–C4.5). A thin wrapper over auto-mode.mjs (kept verbatim, its
// logic already test-locked) that resolves WHICH mode applies to a being in a
// chat from the LIVE config (so the operator can re-tune without restart) and
// exposes the loop's questions:
//
//   mayReceive(being, ev)     — does this being see this chat at all? ('off' = no)
//   mayReply(being, ev)       — COULD its reply surface? (mode + mention + the
//                               absolute auto_e_paused kill). Pre-brain check.
//   sendToEgpt(being, ev)     — does E actually RUN on this message? 'always' |
//                               'mode' (config whatsapp.send_to_egpt). 'mode' =
//                               only when mayReply; 'always' = every received msg.
//   surfaces(being, ev, text) — POST-brain: may THIS reply reach the chat? =
//                               mayReply + the 'on'-mode '...' silence cosmetic.
//
// The loop runs the brain when mayReply OR send_to_egpt='always', then surfaces
// the reply per surfaces(). accum BUFFERING (flush once per heartbeat) still
// layers in with heartbeats — until then accum is gated like mention (immediate).
import { resolveBeingMode, receives, replyAllowed, mayEmitChat, isSilenceReply } from '../auto-mode.mjs';

export function createGating({ getConfig = () => ({}) } = {}) {
  const cfg = () => getConfig() ?? {};

  function modeFor(being, ev) {
    const c = cfg();
    return resolveBeingMode({
      autoModes: c.auto_modes ?? {},
      autoEModes: c.whatsapp?.auto_e_modes ?? {},
      chatId: ev.chatId,
      being,
      // E's chat default falls to the config default; siblings default to 'mention'.
      defaultMode: being === 'e' ? c.whatsapp?.auto_e_default : 'mention',
    });
  }

  function mayReply(being, ev) {
    const mode = modeFor(being, ev);
    const paused = !!cfg().whatsapp?.auto_e_paused;
    const allowed = replyAllowed(mode, ev.mention ?? {});
    return mayEmitChat({ paused, mode, replyAllowed: allowed, isReaction: ev.kind === 'reaction' });
  }

  // send_to_egpt: 'always' | 'mode' (default 'mode'). Decides only whether E RUNS,
  // never whether its reply surfaces. Per-chat override (send_to_egpt_chats[chatId])
  // wins over the global whatsapp.send_to_egpt.
  function sendToEgpt(being, ev) {
    const w = cfg().whatsapp ?? {};
    const v = w.send_to_egpt_chats?.[ev.chatId] ?? w.send_to_egpt ?? 'mode';
    return v === 'always' ? 'always' : 'mode';
  }

  return {
    modeFor,
    mayReceive(being, ev) { return receives(modeFor(being, ev)); },
    mayReply,
    sendToEgpt,
    // POST-brain surfacing: mayReply plus the 'on'-mode '...' silence cosmetic (E
    // free to post but declining to add noise — recorded, not surfaced). Every
    // other mode is already fully decided by mayReply; the reply text never gates it.
    surfaces(being, ev, replyText) {
      if (!mayReply(being, ev)) return false;
      return !(modeFor(being, ev) === 'on' && isSilenceReply(replyText));
    },
  };
}
