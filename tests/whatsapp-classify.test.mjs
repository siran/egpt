// tests/whatsapp-classify.test.mjs — chat-classification rules.
//
// classifyWhatsAppChat() is the single source of truth for "is this WA
// message in an egpt chat or an observed chat", and for "should the
// bridge auto-capture this chat as the egpt chat_id". Every WA mirror
// regression so far has been a chat-classification bug:
//
//   * group JID auto-captured as chat_id because onChatId fired on the
//     very first message regardless of self-DM status;
//   * LID-format self-DM (privacy-format JID with a number that doesn't
//     match the phone number) failed the bare-number self-DM check and
//     ended up observe-only;
//   * a previously-persisted stale chat_id (a group JID from a buggy
//     capture) survived a fix because EGPT_CONFIG was treated as
//     authoritative, so group messages still classified as egpt.
//
// These tests pin the rules so future refactors can't quietly bring any
// of them back.
//
// Bridge fixture (the "An (16468217865)" account from the user's transcripts):
//   phone JID:   16468217865@s.whatsapp.net
//   LID JID:     34836563681438@lid
//   self-DM jid: 16468217865@s.whatsapp.net (precomputed by bridge)

import { describe, it, expect } from 'vitest';
import { classifyWhatsAppChat } from '../src/bridges/whatsapp-classify.mjs';

const BRIDGE = {
  myJid:       '16468217865:42@s.whatsapp.net',
  myLid:       '34836563681438:42@lid',
  myLidNumber: '34836563681438',
  selfDmJid:   '16468217865@s.whatsapp.net',
};

const PHONE_SELF_DM   = '16468217865@s.whatsapp.net';
const LID_SELF_DM     = '34836563681438@lid';
const RANDOM_GROUP    = '51917828733-1529368812@g.us';
const FRIEND_DM       = '12025550100@s.whatsapp.net';

describe('classifyWhatsAppChat — self-DM detection', () => {
  it('phone-format self-DM → isSelfDM, isEgptChat, full mirror', () => {
    const r = classifyWhatsAppChat({ chatId: PHONE_SELF_DM, bridgeInfo: BRIDGE, waConfig: {} });
    expect(r.isSelfDM).toBe(true);
    expect(r.isEgptChat).toBe(true);
    expect(r.observeOnly).toBe(false);
    expect(r.shouldCaptureChatId).toBe(true);
  });

  it('LID-format self-DM → isSelfDM via LID number match (the regression we just fixed)', () => {
    const r = classifyWhatsAppChat({ chatId: LID_SELF_DM, bridgeInfo: BRIDGE, waConfig: {} });
    expect(r.isSelfDM).toBe(true);
    expect(r.isEgptChat).toBe(true);
    expect(r.observeOnly).toBe(false);
    expect(r.shouldCaptureChatId).toBe(true);
  });

  it('LID self-DM still works when myLid is missing (falls back to selfDmJid match for phone form only)', () => {
    // pre-LID-aware bridge: no myLid info. LID self-DM can't be detected.
    // documented for clarity — older bridge versions misclassified LID self-DM.
    const partial = { ...BRIDGE, myLid: null, myLidNumber: null };
    const r = classifyWhatsAppChat({ chatId: LID_SELF_DM, bridgeInfo: partial, waConfig: {} });
    expect(r.isSelfDM).toBe(false);
    expect(r.observeOnly).toBe(true);
  });

  it('group → not self-DM, observe-only, do not auto-capture', () => {
    const r = classifyWhatsAppChat({ chatId: RANDOM_GROUP, bridgeInfo: BRIDGE, waConfig: {} });
    expect(r.isSelfDM).toBe(false);
    expect(r.isEgptChat).toBe(false);
    expect(r.observeOnly).toBe(true);
    expect(r.shouldCaptureChatId).toBe(false);
  });

  it('friend DM → not self-DM, observe-only, do not auto-capture', () => {
    const r = classifyWhatsAppChat({ chatId: FRIEND_DM, bridgeInfo: BRIDGE, waConfig: {} });
    expect(r.isSelfDM).toBe(false);
    expect(r.observeOnly).toBe(true);
    expect(r.shouldCaptureChatId).toBe(false);
  });
});

describe('classifyWhatsAppChat — egpt_chats[] explicit list', () => {
  it('group listed in egpt_chats → isEgptChat (full mirror) but NOT self-DM', () => {
    const waConfig = { egpt_chats: [RANDOM_GROUP] };
    const r = classifyWhatsAppChat({ chatId: RANDOM_GROUP, bridgeInfo: BRIDGE, waConfig });
    expect(r.isSelfDM).toBe(false);
    expect(r.isEgptChat).toBe(true);
    expect(r.observeOnly).toBe(false);
    // explicit egpt_chats does NOT trigger chat_id auto-capture; chat_id
    // is for the canonical self-DM only.
    expect(r.shouldCaptureChatId).toBe(false);
  });

  it('friend DM listed in egpt_chats → isEgptChat', () => {
    const waConfig = { egpt_chats: [FRIEND_DM] };
    const r = classifyWhatsAppChat({ chatId: FRIEND_DM, bridgeInfo: BRIDGE, waConfig });
    expect(r.isEgptChat).toBe(true);
    expect(r.observeOnly).toBe(false);
  });

  it('chat NOT listed → still observe-only', () => {
    const waConfig = { egpt_chats: [FRIEND_DM] };
    const r = classifyWhatsAppChat({ chatId: RANDOM_GROUP, bridgeInfo: BRIDGE, waConfig });
    expect(r.isEgptChat).toBe(false);
    expect(r.observeOnly).toBe(true);
  });
});

describe('classifyWhatsAppChat — chat_id config trust rules', () => {
  it('chat_id matches a phone-form self-DM JID → that JID is egpt chat', () => {
    const waConfig = { chat_id: PHONE_SELF_DM };
    const r = classifyWhatsAppChat({ chatId: PHONE_SELF_DM, bridgeInfo: BRIDGE, waConfig });
    expect(r.isSelfDM).toBe(true);
    expect(r.isEgptChat).toBe(true);
  });

  it('chat_id matches an LID-form self-DM JID → that JID is egpt chat', () => {
    const waConfig = { chat_id: LID_SELF_DM };
    const r = classifyWhatsAppChat({ chatId: LID_SELF_DM, bridgeInfo: BRIDGE, waConfig });
    expect(r.isSelfDM).toBe(true);
    expect(r.isEgptChat).toBe(true);
  });

  it('STALE chat_id pointing at a group JID does NOT make group messages egpt chat', () => {
    // This is the regression scenario: a previous buggy capture put a
    // group JID into chat_id. Without the self-DM-shape guard, group
    // messages would keep classifying as egpt chat and full-mirror to
    // shell. The guard rejects any chat_id whose number doesn't match
    // either myNumber or myLidNumber.
    const waConfig = { chat_id: RANDOM_GROUP };
    const r = classifyWhatsAppChat({ chatId: RANDOM_GROUP, bridgeInfo: BRIDGE, waConfig });
    expect(r.isSelfDM).toBe(false);
    expect(r.isEgptChat).toBe(false);
    expect(r.observeOnly).toBe(true);
  });

  it('STALE chat_id (group) does not also mistakenly pull in real self-DM', () => {
    const waConfig = { chat_id: RANDOM_GROUP };
    const r = classifyWhatsAppChat({ chatId: LID_SELF_DM, bridgeInfo: BRIDGE, waConfig });
    // LID match still wins independently.
    expect(r.isSelfDM).toBe(true);
    expect(r.isEgptChat).toBe(true);
  });
});

describe('classifyWhatsAppChat — input safety', () => {
  it('missing bridgeInfo → no false positives', () => {
    const r = classifyWhatsAppChat({ chatId: PHONE_SELF_DM });
    expect(r.isSelfDM).toBe(false);
    expect(r.isEgptChat).toBe(false);
    expect(r.observeOnly).toBe(true);
  });

  it('null chatId → false', () => {
    const r = classifyWhatsAppChat({ chatId: null, bridgeInfo: BRIDGE });
    expect(r.isSelfDM).toBe(false);
    expect(r.observeOnly).toBe(true);
  });

  it('empty waConfig is fine', () => {
    expect(() => classifyWhatsAppChat({ chatId: PHONE_SELF_DM, bridgeInfo: BRIDGE })).not.toThrow();
  });

  it('waConfig.egpt_chats not an array is treated as empty', () => {
    const r = classifyWhatsAppChat({ chatId: RANDOM_GROUP, bridgeInfo: BRIDGE, waConfig: { egpt_chats: 'not-array' } });
    expect(r.isEgptChat).toBe(false);
  });
});
