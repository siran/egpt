// Decide whether an incoming WhatsApp message belongs to an "egpt chat"
// (full mirror to shell + bus + other bridges) or an "observed chat"
// (silent listening, persona-only dispatch back to the originating chat).
//
// The rule set lives here, outside egpt.mjs, so it can be unit-tested in
// isolation — chat classification has been the source of every WA mirror
// regression so far (group JID auto-captured as chat_id, LID self-DM
// failing the phone-number match, stale chat_id surviving a fix).
//
// inputs:
//   chatId         — the WA JID of the chat. Possible shapes:
//                      '<phone>@s.whatsapp.net'  (regular contact / your phone-DM)
//                      '<lidNumber>@lid'         (LID privacy-format JID)
//                      '<gid>-<ts>@g.us'         (group)
//   bridgeInfo     — { myJid, myLid, myLidNumber, selfDmJid } from the
//                    WhatsApp bridge (see bridges/whatsapp.mjs getters).
//   waConfig       — { chat_id, egpt_chats } from EGPT_CONFIG.whatsapp.
//
// returns:
//   { isSelfDM, isEgptChat, observeOnly, shouldCaptureChatId }
//
// where:
//   isSelfDM       — chatId is the user's "Message Yourself" chat. Detected
//                    via four independent signals (any one is sufficient):
//                      1. bare-number match against myJid's phone number
//                      2. bare-number match against myLid's LID number
//                         (WhatsApp's privacy format gives the user's
//                         self-DM a different number than the phone — neither
//                         signal alone is enough)
//                      3. exact match against bridge.selfDmJid (precomputed)
//                      4. exact match against waConfig.chat_id, IF chat_id
//                         itself looks like a self-DM. The IF-guard
//                         protects against stale group JIDs persisted by
//                         prior buggy captures.
//   isEgptChat     — isSelfDM OR chatId is listed in waConfig.egpt_chats[].
//                    Non-self-DM egpt chats (a friend's DM you've decided
//                    is part of the egpt play, a designated group) belong
//                    in egpt_chats[], not chat_id.
//   observeOnly    — !isEgptChat. Observed chats: egpt listens, surfaces
//                    @egpt mentions, but doesn't echo to shell or bus.
//   shouldCaptureChatId — bridge should fire onChatId for this message.
//                    Equal to isSelfDM. Auto-capture is the way the bridge
//                    teaches the host which JID is the canonical egpt chat;
//                    capturing a non-self-DM (e.g. the user's first message
//                    happened to be in a group) poisons the persisted
//                    chat_id and breaks egpt-chat detection until manually
//                    fixed. Observed chats never auto-capture.

export function classifyWhatsAppChat({ chatId, bridgeInfo = {}, waConfig = {} } = {}) {
  const { myJid = null, myLid = null, myLidNumber = null, selfDmJid = null } = bridgeInfo;

  const bareNumber = (jid) => String(jid ?? '').split('@')[0]?.split(':')[0] ?? '';
  const myNum = bareNumber(myJid);
  const chatNum = bareNumber(chatId);

  const isSelfByNumber    = !!myNum       && !!chatNum && chatNum === myNum;
  const isSelfByLid       = !!myLidNumber && !!chatNum && chatNum === myLidNumber;
  const isSelfBySelfDmJid = !!selfDmJid   && chatId === selfDmJid;

  const liveChatId = waConfig?.chat_id ?? null;
  const liveChatNum = bareNumber(liveChatId);
  const liveChatIsSelfDM = !!liveChatId
    && ((!!myNum && liveChatNum === myNum) || (!!myLidNumber && liveChatNum === myLidNumber));
  const isSelfByConfig = liveChatIsSelfDM && chatId === liveChatId;

  const isSelfDM = isSelfByNumber || isSelfByLid || isSelfBySelfDmJid || isSelfByConfig;

  const egptChats = Array.isArray(waConfig?.egpt_chats) ? waConfig.egpt_chats : [];
  const isEgptChat = isSelfDM || egptChats.includes(chatId);

  return {
    isSelfDM,
    isEgptChat,
    observeOnly: !isEgptChat,
    shouldCaptureChatId: isSelfDM,
  };
}

// Suppress unused-export warnings during type-strip; not used externally
// other than via classifyWhatsAppChat. Kept as a named re-export for
// people grepping "isSelfDM".
export const __test_internals__ = Object.freeze({});
