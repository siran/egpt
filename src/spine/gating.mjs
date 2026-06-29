// gating.mjs — the §2c gating service: the per-chat mode + pause + mention gate
// (contracts C4.1–C4.5). A thin wrapper over auto-mode.mjs (kept verbatim, its
// logic already test-locked) that resolves WHICH mode applies to a being in a
// chat from the LIVE config (so the operator can re-tune without restart) and
// exposes the loop's two questions:
//
//   mayReceive(being, ev)  — does this being see this chat at all? ('off' = no)
//   mayReply(being, ev)    — may its reply reach the chat? (mode + mention +
//                            the absolute auto_e_paused kill)
//
// v1 NOTE (SPINE-REWRITE-PLAN.md §4): mayReply runs BEFORE the brain, so it is
// the mayEmitChat emit-gate used as the pre-brain gate. The richer "invoke for
// context but withhold fan-out" path (fanOutDecision) and accum BUFFERING (flush
// once per heartbeat) layer in with heartbeats — until then accum is gated like
// mention (immediate). Documented so it isn't silently lost.
import { resolveBeingMode, receives, replyAllowed, mayEmitChat } from '../auto-mode.mjs';

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

  return {
    modeFor,
    mayReceive(being, ev) { return receives(modeFor(being, ev)); },
    mayReply(being, ev) {
      const mode = modeFor(being, ev);
      const paused = !!cfg().whatsapp?.auto_e_paused;
      const allowed = replyAllowed(mode, ev.mention ?? {});
      return mayEmitChat({ paused, mode, replyAllowed: allowed, isReaction: ev.kind === 'reaction' });
    },
  };
}
