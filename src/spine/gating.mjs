// gating.mjs — the §2c gating service: resolve a being's per-CONVERSATION policy
// (its mode, read from conversations.yaml — the per-conversation home, operator
// 2026-06-30) and turn it into the loop's decisions. The
// mode→decision LOGIC is the kept, test-locked auto-mode.mjs; this service only
// resolves WHICH mode/policy applies and packages the per-message decision:
//
//   decide(being, ev, mention?, { denied?, bot? }) -> { mode, receives, mayReply, quiet? }   (ONE conv-state read)
//   surfaces(decision, replyText)-> boolean    POST-brain: mayReply + the 'on'/quiet '...' silence cosmetic
//
// `mode` resolves down ONE chain, most specific first (operator 2026-07-25):
//   config.yaml         closed_chats.<surface>.<id>   'off' for every being (closed-chats.mjs)
//   conversations.yaml  <conv>.agents.<name>.mode   per-conversation override (an alias room's own first)
//   conversations.yaml  <conv>.<name>.mode          per-conversation block    (getBeing reads both)
//   config.yaml         agents.<name>.mode          the AGENT's own default
//   config.yaml         dispatch.auto_default_mode  node-wide, every being (legacy whatsapp.auto_e_default)
//   built-in            'mention'
// `send_to_egpt: always` (a context turn that never replies) is RETIRED (operator 2026-10-23):
// a being runs only when it may reply; `accum` hands it the context instead. The
// absolute kill is dispatch.auto_paused (legacy whatsapp.auto_e_paused). The routing globals
// moved OUT of the whatsapp transport block into `dispatch:` (operator 2026-06-25 —
// E is a sibling, not a network); the whatsapp.* reads stay as back-compat fallbacks
// so an un-migrated config is a no-op. The old config.auto_modes route is GONE —
// modes live in the agents registry + conversations.yaml.
import { getBeing } from '../conversations-state.mjs';
import { receives, replyAllowed, mayEmitChat, isSilenceReply, isAutoMode, DEFAULT_AUTO_MODE } from '../auto-mode.mjs';
import { beeperBlockOf } from '../tools/config-io.mjs';
import { closedChat } from './closed-chats.mjs';

// The mode an agent takes when its conversation says nothing. PER-AGENT FIRST (operator
// 2026-07-25: "better to have in config.yaml the configuration per agent on its mode"): an
// agent may declare its own default as `agents.<name>.mode` in the SAME registry entry that
// already carries its configuration/handles/relay_channel — that is what lets @don be
// mention-direct while @e is mention in the very same chat. Keyed lowercase, boot's own
// convention for that map. Below it (phase 2, operator 2026-08-14: "remove the concept of
// siblings" — every being's un-configured default gate resolves the SAME way now, no more
// being === defaultKey branch): the node's dispatch.auto_default_mode (legacy
// whatsapp.auto_e_default), falling back to DEFAULT_AUTO_MODE ('mention') when that's also
// unset — which is today's ultimate fallback for every being anyway, so this is a no-op for
// a node that never configured auto_default_mode.
//
// THE MODE A BEING RUNS UNDER, and which tier set it: the conversation's own mode when it names a
// real one, else that ladder. Exported (operator 2026-09-24) so the room's config.readonly.yaml
// states the mode decide() uses, and where it came from, without a second copy of this order.
// `bv` is getBeing's view of the conversation (`.mode`, and `.surface`/`.chatId` for closed_chats), null for "none".
export function resolveMode(bv, being, c = {}) {
  if (closedChat(c, bv?.surface, bv?.chatId)) return { mode: 'off', source: 'closed' };
  if (isAutoMode(bv?.mode)) return { mode: bv.mode, source: 'conversation' };
  const own = c.agents?.[String(being ?? '').toLowerCase()]?.mode;
  if (isAutoMode(own)) return { mode: own, source: 'agent' };
  const def = c.dispatch?.auto_default_mode ?? c.whatsapp?.auto_e_default;
  return isAutoMode(def) ? { mode: def, source: 'node' } : { mode: DEFAULT_AUTO_MODE, source: 'default' };
}

// Is side group `chatId` still read by a human? true | false (DEFINITE: the GET 404'd, or the roster
// holds only our mouth accounts) | null (unknown — keep using it). The operator counts as a human; a
// mouth is any config.beeper phone other than the primary's. Shared by /join and the automatic group.
export async function superChannelAlive(chatId, { chatRaw, config = {} }) {
  const raw = await chatRaw(chatId);
  if (raw === false) return false;
  const items = raw?.participants?.items;
  if (!Array.isArray(items)) return null;
  const digits = (v) => String(v ?? '').replace(/\D/g, '');
  const beeper = beeperBlockOf(config);
  const operator = digits(beeper?.primary?.phone);
  const mouths = new Set(Object.values(beeper ?? {}).map((a) => digits(a?.phone)).filter((d) => d && d !== operator));
  return items.some((p) => !mouths.has(digits(p?.phoneNumber)));
}

// sideGroupFor(ev, { create }) → the chat a reply here goes to instead (a chat id, or a function that
// makes it, for sender.open to call), false = withhold it, null = in place (commands.autoSideGroup:
// reply_in_side_group, operator 2026-10-18). { chatId, tunnel: true } = the chat's open /split
// (2026-10-31): the decision says `tunnel`. Absent → always in place.
// seedOf(ev) → { agents: { <being>: block }, … } a brand-new conversation is seeded with (boot: the stranger rule), or null.
export function createGating({ getConfig = () => ({}), loadState = null, seedOf = null, sideGroupFor = null } = {}) {
  const cfg = () => getConfig() ?? {};

  // The single per-target decision. ONE conversations.yaml read resolves the being's mode here. `mention` is passed
  // explicitly by the loop (it's the ROUTED being's mention — a sibling routed by its own @name
  // is mentioned for ITS gate, not @e's); default to ev.mention for direct callers.
  // `denied` is the router's allowed_users answer for this target (router.resolve): a denied
  // sender is recorded but runs no turn, in any mode.
  // `bot`: the line is not a human's (the spine's isHumanTurn). With dispatch.bot_quiet (default on) its
  // turn is `quiet`: no ⏳ train, posted once whole, its '…' never shown, in any mode (operator 2026-10-31).
  async function decide(being, ev, mention = ev.mention, { denied = false, bot = false } = {}) {
    const c = cfg();
    let state = null;
    if (loadState) { try { state = await loadState(); } catch { state = null; } }
    let bv = null;
    if (state) { try { bv = getBeing(state, ev.surface, ev.chatId, being); } catch { bv = null; } }
    if (!bv) bv = seedOf?.(ev)?.agents?.[being] ?? null;   // no entry yet: the block its seed will write
    const { mode } = resolveMode(bv, being, c);
    const paused = !!(c.dispatch?.auto_paused ?? c.whatsapp?.auto_e_paused);
    const allowed = replyAllowed(mode, mention ?? {});
    let mayReply = !denied && mayEmitChat({ paused, mode, replyAllowed: allowed, isReaction: ev.kind === 'reaction' });
    // Not asked for a backlog read or the operator's own line in an auto chat: no reply follows either.
    let replyChatId = null, tunnel = false;
    if (mayReply && sideGroupFor && !ev.backlog && !(mode === 'auto' && ev.isSender)) {
      let at = null;
      // An addressed reply makes the group now; an unaddressed one (on/auto) once it has something to post.
      try { at = await sideGroupFor(ev, { create: replyAllowed('mention', mention ?? {}) }); } catch { at = false; }
      if (at === false) mayReply = false;
      else if (at?.chatId) { replyChatId = at.chatId; tunnel = at.tunnel === true; }
      else if (at) replyChatId = at;
    }
    const quiet = bot && c.dispatch?.bot_quiet !== false;
    return { mode, receives: receives(mode), mayReply, ...(replyChatId ? { replyChatId } : {}), ...(tunnel ? { tunnel } : {}), ...(quiet ? { quiet } : {}) };
  }

  // POST-brain surfacing: the reply surfaces when mayReply held AND it isn't an
  // 'on'-mode '...' silence (E free to post but declining to add noise — recorded,
  // not surfaced). Every other mode is already fully decided by mayReply.
  function surfaces(decision, replyText) {
    if (!decision?.mayReply) return false;
    // 'auto' gates like 'on' — its free-post silence ('…') is likewise recorded, not surfaced. So is a quiet turn's, in any mode.
    return !((decision.mode === 'on' || decision.mode === 'auto' || decision.quiet) && isSilenceReply(replyText));
  }

  return { decide, surfaces };
}
