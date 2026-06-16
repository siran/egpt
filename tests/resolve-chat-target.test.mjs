// Locks two recurring resolver bugs (operator 2026-06-16):
//   bug 3 — a Beeper room id ('!…:beeper.local', no '@') was treated as a fuzzy
//           name, so getChatName never ran → `/e auto status` printed raw ids.
//   bug 2 — the LIVE chat list wasn't authoritative, so a stale/duplicate
//           registry jid for the SAME group made `/e auto on HFM` → "matches 2".

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveChatTarget, serialize } from '../conversations-state.mjs';

const dirs = [];
const tmpState = (state) => {
  const dir = mkdtempSync(join(tmpdir(), 'egpt-rct-'));
  dirs.push(dir);
  const p = join(dir, 'conversations.yaml');
  writeFileSync(p, serialize(state), 'utf8');
  return p;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('resolveChatTarget — Beeper room ids resolve (bug 3)', () => {
  it('treats a !…:beeper.local room id as a jid and resolves its live name', async () => {
    const r = await resolveChatTarget('!kQnSaA:beeper.local', {
      statePath: tmpState({ contacts: { whatsapp: {} } }),
      waBridge: { getChatName: (id) => (id === '!kQnSaA:beeper.local' ? 'Mi Grupo' : null) },
    });
    expect(r).toEqual({ jid: '!kQnSaA:beeper.local', name: 'Mi Grupo' });
  });

  it('still resolves a classic WA @-jid', async () => {
    const r = await resolveChatTarget('12345@g.us', {
      statePath: tmpState({ contacts: { whatsapp: {} } }),
      waBridge: { getChatName: (id) => (id === '12345@g.us' ? 'Group' : null) },
    });
    expect(r).toEqual({ jid: '12345@g.us', name: 'Group' });
  });
});

describe('resolveChatTarget — live list is authoritative (bug 2)', () => {
  it('a fuzzy name matching one LIVE chat resolves it, ignoring a stale registry duplicate', async () => {
    const statePath = tmpState({ contacts: { whatsapp: {
      // stale baileys-era jid for the SAME group — NOT in the live list
      '120363@g.us': { slug: 'HFM-stale', pushedName: 'HFM - high frequency masturbation' },
    } } });
    const r = await resolveChatTarget('HFM', {
      statePath,
      waBridge: { listChats: async () => [{ jid: '!live:beeper.local', name: 'HFM - high frequency masturbation' }] },
    });
    expect(r).toEqual({ jid: '!live:beeper.local', name: 'HFM - high frequency masturbation' });
  });

  it('falls back to the registry only when NO live chat matches', async () => {
    const statePath = tmpState({ contacts: { whatsapp: {
      '!arch:beeper.local': { slug: 'archived', pushedName: 'Archived Chat' },
    } } });
    const r = await resolveChatTarget('Archived', {
      statePath,
      waBridge: { listChats: async () => [] },   // nothing live matches
    });
    expect(r).toMatchObject({ jid: '!arch:beeper.local' });
  });

  it('genuinely-different live chats sharing the search term still report ambiguity', async () => {
    const r = await resolveChatTarget('team', {
      statePath: tmpState({ contacts: { whatsapp: {} } }),
      waBridge: { listChats: async () => [
        { jid: '!a:beeper.local', name: 'team alpha' },
        { jid: '!b:beeper.local', name: 'team beta' },
      ] },
    });
    expect(r.error).toMatch(/matches 2/);
  });
});
