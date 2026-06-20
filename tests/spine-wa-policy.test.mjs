import { describe, expect, it, vi } from 'vitest';
import {
  createWaBypassSync,
  createWhatsAppConfirmMirror,
  resolveWaTransport,
} from '../src/spine-wa-policy.mjs';

describe('spine whatsapp policy', () => {
  it('defaults to beeper transport and only selects cdp explicitly', () => {
    expect(resolveWaTransport({})).toBe('beeper');
    expect(resolveWaTransport({ transport: 'beeper' })).toBe('beeper');
    expect(resolveWaTransport({ transport: 'cdp' })).toBe('cdp');
    expect(resolveWaTransport({ transport: 'baileys' })).toBe('beeper');
  });

  it('syncs bypass chats from joined and auto-e chats', () => {
    const calls = [];
    const waBridgeRef = {
      current: {
        setBypassChats: (chats) => calls.push(chats),
      },
    };
    const sync = createWaBypassSync({
      waBridgeRef,
      getJoinedChats: () => [{ jid: 'wa-1' }, { jid: 'wa-2' }],
      getAutoChats: () => ['wa-2', 'wa-3'],
    });

    sync();
    expect(calls).toEqual([['wa-1', 'wa-2', 'wa-3']]);
  });

  it('mirrors confirm payloads to shell and outbox destinations', async () => {
    const pushes = [];
    const outbox = [];
    const confirm = createWhatsAppConfirmMirror({
      config: {
        whatsapp: {
          confirm_chats: {
            'chat-1': ['shell', 'self', 'egptbot'],
          },
          chat_id: 'self-jid',
          egptbot_jid: 'bot-jid',
        },
      },
      pushItem: (item) => pushes.push(item),
      emitOutbox: async (ev) => outbox.push(ev),
      now: () => 1234,
    });

    await confirm('chat-1', '<-E', 'hello');
    expect(pushes).toHaveLength(1);
    expect(pushes[0].body).toBe('Debug: <-E\nhello');
    expect(outbox).toEqual([
      { jid: 'self-jid', body: 'Debug: <-E\n```\nhello\n```', deliverEcho: true },
      { jid: 'bot-jid', body: 'Debug: <-E\n```\nhello\n```', deliverEcho: true },
    ]);
  });

  it('skips egptbot mirroring when no bot jid is configured', async () => {
    const pushes = [];
    const outbox = [];
    const confirm = createWhatsAppConfirmMirror({
      config: {
        whatsapp: {
          confirm_chats: { 'chat-1': ['egptbot'] },
        },
      },
      pushItem: (item) => pushes.push(item),
      emitOutbox: async (ev) => outbox.push(ev),
      now: () => 1,
    });

    await confirm('chat-1', null, 'body');
    expect(outbox).toEqual([]);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].body).toMatch(/needs whatsapp\.egptbot_jid configured/);
  });
});
