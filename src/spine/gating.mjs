// gating.mjs — the §2c gating service: resolve a being's per-CONVERSATION policy
// (mode + send_to_egpt, both read from conversations.yaml — the per-conversation
// home, operator 2026-06-30) and turn it into the loop's decisions. The
// mode→decision LOGIC is the kept, test-locked auto-mode.mjs; this service only
// resolves WHICH mode/policy applies and packages the per-message decision:
//
//   decide(being, ev, mention?)  -> { mode, receives, mayReply, sendToEgpt }   (ONE conv-state read)
//   surfaces(decision, replyText)-> boolean    POST-brain: mayReply + the 'on'-'...' silence cosmetic
//
// `mode` is the conversation's `<being>.mode` (conversations.yaml), defaulting to
// config.whatsapp.auto_e_default (E) / 'mention' (sibling). `sendToEgpt` is the
// conversation's `<being>.send_to_egpt` override, else the global config default
// (whatsapp.send_to_egpt), else 'mode'. `auto_e_paused` (config) is the absolute
// kill. The old config.auto_modes route is GONE — modes live in conversations.yaml.
import { getBeing } from '../../conversations-state.mjs';
import { receives, replyAllowed, mayEmitChat, isSilenceReply, isAutoMode, DEFAULT_AUTO_MODE } from '../auto-mode.mjs';

const _send = (v) => (v === 'always' || v === 'mode') ? v : null;

export function createGating({ getConfig = () => ({}), loadState = null } = {}) {
  const cfg = () => getConfig() ?? {};

  function defaultMode(being, c) {
    const def = being === 'e' ? c.whatsapp?.auto_e_default : 'mention';
    return isAutoMode(def) ? def : DEFAULT_AUTO_MODE;
  }

  async function beingView(being, ev) {
    if (!loadState) return null;
    try { return getBeing(await loadState(), ev.surface, ev.chatId, being); } catch { return null; }
  }

  // The single per-message decision. ONE conversations.yaml read resolves the
  // conversation's mode + send_to_egpt; the rest is pure auto-mode logic. `mention`
  // is passed explicitly by the loop (it's the ROUTED being's mention — a sibling
  // routed by its own @name is mentioned for ITS gate, not @e's); default to
  // ev.mention for direct callers.
  async function decide(being, ev, mention = ev.mention) {
    const c = cfg();
    const bv = await beingView(being, ev);
    const mode = isAutoMode(bv?.mode) ? bv.mode : defaultMode(being, c);
    const paused = !!c.whatsapp?.auto_e_paused;
    const allowed = replyAllowed(mode, mention ?? {});
    const mayReply = mayEmitChat({ paused, mode, replyAllowed: allowed, isReaction: ev.kind === 'reaction' });
    // send_to_egpt keeps E in a chat's context even when it won't reply — that's an
    // E concern. A sibling is an engineer, not a context-follower: it runs ONLY when
    // it may reply, so force 'mode' for a non-E being (never 'always').
    const sendToEgpt = being !== 'e'
      ? 'mode'
      : (_send(bv?.send_to_egpt) ?? _send(c.whatsapp?.send_to_egpt) ?? 'mode');
    return { mode, receives: receives(mode), mayReply, sendToEgpt };
  }

  // POST-brain surfacing: the reply surfaces when mayReply held AND it isn't an
  // 'on'-mode '...' silence (E free to post but declining to add noise — recorded,
  // not surfaced). Every other mode is already fully decided by mayReply.
  function surfaces(decision, replyText) {
    if (!decision?.mayReply) return false;
    return !(decision.mode === 'on' && isSilenceReply(replyText));
  }

  return { decide, surfaces };
}
