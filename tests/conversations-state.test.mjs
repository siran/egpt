// tests/conversations-state.test.mjs — pure-logic tests for the
// per-contact YAML registry. No fs IO touched: parse/serialize +
// upsert + migration all run in-memory.

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyState,
  sanitizeSlug,
  findContactByJid,
  findContactsByName,
  ensureContact,
  patchContact,
  recordThread,
  isMuted,
  shouldFireHeartbeat,
  migrateJsonToYaml,
  parse,
  serialize,
  nowIsoString,
  isoFromMs,
  KNOWN_SURFACES,
  DEFAULT_PERSONALITY_TOOLS,
  readPersonality,
  readPersonalityMeta,
} from '../conversations-state.mjs';

const WA = 'whatsapp';
const TG = 'telegram';

describe('emptyState / sanitizeSlug basics', () => {
  it('emptyState() has no contacts', () => {
    expect(emptyState()).toEqual({ contacts: {} });
  });
  it('sanitizeSlug normalizes JIDs and weird chars', () => {
    expect(sanitizeSlug('26087681749235@lid')).toBe('26087681749235_lid');
    expect(sanitizeSlug('premise-driven: bitcoin & evolution')).toBe('premise-driven_bitcoin_evolution');
    expect(sanitizeSlug('  hello world!  ')).toBe('hello_world');
    expect(sanitizeSlug('')).toBe('');
  });
  it('KNOWN_SURFACES is the canonical bucket list', () => {
    expect(KNOWN_SURFACES).toContain('whatsapp');
    expect(KNOWN_SURFACES).toContain('telegram');
    expect(KNOWN_SURFACES).toContain('shell');
  });
});

describe('ensureContact — surface-aware, new contact, multi-JID merge', () => {
  it('creates a fresh contact under the named surface', () => {
    const s0 = emptyState();
    const jid = '26087681749235@lid';
    const { state, jid: primary, slug, entry, isNew, surface } = ensureContact(s0, WA, jid, {
      pushedName: 'Diego Pérez (Koma)',
      slugHint: 'diego',
    });
    expect(isNew).toBe(true);
    expect(surface).toBe(WA);
    expect(primary).toBe(jid);
    expect(slug).toMatch(/^diego-\d{10}$/);
    expect(entry.slug).toBe(slug);
    expect(entry.personality).toBe('default');
    expect(entry.firstSeenAt).toBeTruthy();
    expect(entry.pushedName).toBe('Diego Pérez (Koma)');
    expect(entry.jids).toBeUndefined();
    expect(state.contacts[WA][jid]).toEqual(entry);
  });

  it('a second JID with matching slugHint becomes an alias within the same surface', () => {
    let s = emptyState();
    const r1 = ensureContact(s, WA, '26087681749235@lid', { pushedName: 'Diego Pérez (Koma)', slugHint: 'diego' });
    s = r1.state;
    const r2 = ensureContact(s, WA, '584122182178@s.whatsapp.net', { slugHint: 'diego' });
    expect(r2.slug).toBe(r1.slug);
    expect(r2.jid).toBe(r1.jid);
    expect(r2.isNew).toBe(false);
    expect(r2.state.contacts[WA]['584122182178@s.whatsapp.net']).toEqual({ aliasOf: r1.jid });
  });

  it('same JID under different surfaces is independent', () => {
    let s = emptyState();
    const r1 = ensureContact(s, WA, '88164392', { slugHint: 'an-wa' });
    s = r1.state;
    const r2 = ensureContact(s, TG, '88164392', { slugHint: 'an-tg' });
    expect(r1.slug).not.toBe(r2.slug);
    expect(r2.state.contacts[WA]['88164392'].slug).toMatch(/^an-wa-\d{10}$/);
    expect(r2.state.contacts[TG]['88164392'].slug).toMatch(/^an-tg-\d{10}$/);
  });

  it('re-encountering a known JID refreshes pushedName on the primary', () => {
    let s = emptyState();
    const r1 = ensureContact(s, WA, '26087681749235@lid', { pushedName: '', slugHint: 'diego' });
    s = r1.state;
    const r2 = ensureContact(s, WA, '26087681749235@lid', { pushedName: 'Diego Pérez (Koma)' });
    expect(r2.jid).toBe(r1.jid);
    expect(r2.slug).toBe(r1.slug);
    expect(r2.isNew).toBe(false);
    expect(r2.changed).toBe(true);
    expect(r2.entry.pushedName).toBe('Diego Pérez (Koma)');
  });

  it('falls back to a contact-<timestamp> slug when no slugHint or pushedName', () => {
    const s = emptyState();
    const jid = '584122182178@s.whatsapp.net';
    const r = ensureContact(s, WA, jid, {});
    expect(r.slug).toMatch(/^contact-\d{10}$/);
    expect(r.state.contacts[WA][jid].slug).toBe(r.slug);
  });

  it('aliasOf resolves through findContactByJid', () => {
    let s = emptyState();
    const r1 = ensureContact(s, WA, '26087681749235@lid', { slugHint: 'diego' });
    s = ensureContact(r1.state, WA, '584122182178@s.whatsapp.net', { slugHint: 'diego' }).state;
    expect(findContactByJid(s, WA, '26087681749235@lid')).toBe(r1.slug);
    expect(findContactByJid(s, WA, '584122182178@s.whatsapp.net')).toBe(r1.slug);
  });

  it('ensureContact rejects an unknown surface', () => {
    expect(() => ensureContact(emptyState(), 'martian-radio', '1@lid', {}))
      .toThrow(/unknown surface/);
  });

  it('honors ctx.personality on new contact creation', () => {
    const r = ensureContact(emptyState(), WA, '34836563681438@lid', {
      pushedName: 'self', slugHint: 'self', personality: 'system',
    });
    expect(r.entry.personality).toBe('system');
  });
});

describe('findContactByJid (surface-scoped)', () => {
  it('returns null for unknown JID', () => {
    expect(findContactByJid(emptyState(), WA, '0@lid')).toBe(null);
  });
  it('returns the slug for a JID with a primary entry, scoped to surface', () => {
    const s = {
      contacts: {
        whatsapp: {
          '26087681749235@lid':           { slug: 'diego', personality: 'default' },
          '584122182178@s.whatsapp.net':  { aliasOf: '26087681749235@lid' },
          '1@lid':                        { slug: 'bob', personality: 'default' },
        },
        telegram: {
          '88164392': { slug: 'an-tg', personality: 'system' },
        },
      },
    };
    expect(findContactByJid(s, WA, '26087681749235@lid')).toBe('diego');
    expect(findContactByJid(s, WA, '584122182178@s.whatsapp.net')).toBe('diego');
    expect(findContactByJid(s, WA, '1@lid')).toBe('bob');
    expect(findContactByJid(s, WA, '88164392')).toBe(null);          // TG-only
    expect(findContactByJid(s, TG, '88164392')).toBe('an-tg');
    expect(findContactByJid(s, TG, '26087681749235@lid')).toBe(null); // WA-only
  });
});

describe('patchContact + recordThread (surface-scoped)', () => {
  const baseState = () => ({
    contacts: { whatsapp: {
      'j': { slug: 'diego', personality: 'default', pushedName: 'D' },
    } },
  });
  it('patchContact accepts a JID key', () => {
    const s2 = patchContact(baseState(), WA, 'j', { personality: 'serious' });
    expect(s2.contacts[WA].j.personality).toBe('serious');
    expect(s2.contacts[WA].j.pushedName).toBe('D');
    expect(s2.contacts[WA].j.slug).toBe('diego');
  });
  it('patchContact accepts a slug for back-compat', () => {
    const s2 = patchContact(baseState(), WA, 'diego', { personality: 'joke' });
    expect(s2.contacts[WA].j.personality).toBe('joke');
  });
  it('patchContact resolves through aliasOf to primary', () => {
    const s = { contacts: { whatsapp: {
      'j': { slug: 'diego', personality: 'default' },
      'k': { aliasOf: 'j' },
    } } };
    const s2 = patchContact(s, WA, 'k', { personality: 'silent' });
    expect(s2.contacts[WA].j.personality).toBe('silent');
    expect(s2.contacts[WA].k).toEqual({ aliasOf: 'j' });
  });
  it('patchContact rejects unknown surface', () => {
    expect(() => patchContact(baseState(), 'mars', 'j', {}))
      .toThrow(/unknown surface/);
  });
  it('recordThread sets threadId + ISO timestamp on the primary', () => {
    const s = { contacts: { whatsapp: { 'j': { slug: 'diego', personality: 'default' } } } };
    const s2 = recordThread(s, WA, 'j', 'thr-abc', '2026-05-19T18:34:00.000Z');
    expect(s2.contacts[WA].j.threadId).toBe('thr-abc');
    expect(s2.contacts[WA].j.threadCreatedAt).toBe('2026-05-19T18:34:00.000Z');
    expect(s2.contacts[WA].j.identityInjectedAt).toBe('2026-05-19T18:34:00.000Z');
  });

  // Regression: root fields (system_thread, etc.) must survive contact
  // mutations. Earlier the rebuild `{ contacts: ... }` was dropping
  // system_thread on every non-system contact dispatch, wiping the
  // shared system-e memory. Caught by Codex review 2026-05-21.
  it('patchContact preserves root state fields (system_thread, etc.)', () => {
    const s = {
      system_thread: { threadId: 'sys-thr-xyz', threadCreatedAt: '2026-05-21T22:00:00.000Z' },
      contacts: { whatsapp: { 'j': { slug: 'diego', personality: 'default' } } },
    };
    const s2 = patchContact(s, WA, 'j', { personality: 'serious' });
    expect(s2.system_thread).toBeDefined();
    expect(s2.system_thread.threadId).toBe('sys-thr-xyz');
  });
  it('ensureContact preserves root state fields', () => {
    const s = {
      system_thread: { threadId: 'sys-thr-zzz' },
      _meta: { somethingElseAtRoot: true },
      contacts: { whatsapp: {} },
    };
    const r = ensureContact(s, WA, '99@lid', { slugHint: 'newguy' });
    expect(r.state.system_thread).toBeDefined();
    expect(r.state.system_thread.threadId).toBe('sys-thr-zzz');
    expect(r.state._meta).toEqual({ somethingElseAtRoot: true });
  });
});

describe('findContactsByName (cross-surface name search)', () => {
  const s = {
    contacts: {
      whatsapp: {
        '1@lid': { slug: 'diego-2605200133', pushedName: 'Diego Pérez (Koma)' },
        '2@lid': { aliasOf: '1@lid' },
        '3@lid': { slug: 'jorge-2605200419', pushedName: 'Jorge' },
      },
      telegram: {
        '88164392': { slug: 'an-self-2605211200', pushedName: 'An (TG)', personality: 'system' },
      },
    },
  };
  it('matches across all surfaces by default', () => {
    const r = findContactsByName(s, 'di');
    const slugs = r.map(x => x.slug);
    expect(slugs).toContain('diego-2605200133');
    expect(slugs.length).toBe(1);   // aliases excluded
  });
  it('returns surface in each result', () => {
    const r = findContactsByName(s, 'an');
    expect(r[0].surface).toBe(TG);
  });
  it('respects an explicit surface filter', () => {
    const r = findContactsByName(s, 'an', WA);
    expect(r).toEqual([]);                // no WA contact named 'an'
  });
  it('returns empty for empty / whitespace term', () => {
    expect(findContactsByName(s, '')).toEqual([]);
    expect(findContactsByName(s, '   ')).toEqual([]);
  });
});

describe('isMuted + shouldFireHeartbeat predicates', () => {
  it('isMuted true only when personality === mute', () => {
    expect(isMuted({ personality: 'mute' })).toBe(true);
    expect(isMuted({ personality: 'default' })).toBe(false);
    expect(isMuted({ personality: 'silent' })).toBe(false);
    expect(isMuted(null)).toBe(false);
  });
  it('shouldFireHeartbeat false when not enabled', () => {
    expect(shouldFireHeartbeat({ heartbeatEnabled: false }, Date.now())).toBe(false);
  });
  it('shouldFireHeartbeat respects interval', () => {
    const now = Date.now();
    const e = {
      heartbeatEnabled: true,
      heartbeatIntervalMin: 30,
      heartbeatLastFiredAt: new Date(now - 10 * 60_000).toISOString(),
    };
    expect(shouldFireHeartbeat(e, now)).toBe(false);
    const e2 = { ...e, heartbeatLastFiredAt: new Date(now - 35 * 60_000).toISOString() };
    expect(shouldFireHeartbeat(e2, now)).toBe(true);
  });
  it('shouldFireHeartbeat fires immediately when never fired', () => {
    expect(shouldFireHeartbeat({ heartbeatEnabled: true, heartbeatIntervalMin: 30 }, Date.now())).toBe(true);
  });
});

describe('YAML parse / serialize round-trip', () => {
  it('round-trips an empty state', () => {
    const s = emptyState();
    expect(parse(serialize(s))).toEqual(s);
  });
  it('round-trips a populated, multi-surface state', () => {
    const s = {
      contacts: {
        whatsapp: {
          '26087681749235@lid': {
            slug: 'diego-2605200133',
            personality: 'default',
            threadId: 'abc',
            threadCreatedAt: '2026-05-19T18:34:00.000Z',
            identityInjectedAt: '2026-05-19T18:34:00.000Z',
            pushedName: 'Diego Pérez (Koma)',
            heartbeatEnabled: true,
            heartbeatIntervalMin: 60,
            heartbeatLastFiredAt: null,
          },
          '584122182178@s.whatsapp.net': { aliasOf: '26087681749235@lid' },
        },
        telegram: {
          '88164392': {
            slug: 'an-self-2605211200',
            personality: 'system',
            threadId: null,
            pushedName: 'An',
          },
        },
      },
    };
    expect(parse(serialize(s))).toEqual(s);
  });
  it('parse() of empty / garbage returns emptyState', () => {
    expect(parse('')).toEqual(emptyState());
    expect(parse(null)).toEqual(emptyState());
    expect(parse('   ')).toEqual(emptyState());
  });
});

describe('migrateJsonToYaml — legacy slug-keyed JSON (pre-surface)', () => {
  it('groups multiple JIDs with the same customName into one contact', () => {
    const json = {
      '26087681749235@lid':         { pushedName: 'Diego Pérez (Koma)', customName: 'diego' },
      '584122182178@s.whatsapp.net':{ pushedName: '',                    customName: 'diego' },
      '120363407494846096@g.us':    { pushedName: 'premise-driven: bitcoin & evolution', customName: '' },
    };
    const r = migrateJsonToYaml(json);
    expect(r.migrated).toBe(2);
    expect(r.jids).toBe(3);
    expect(r.state.contacts.diego.jids).toEqual([
      '26087681749235@lid',
      '584122182178@s.whatsapp.net',
    ]);
    expect(r.state.contacts.diego.pushedName).toBe('Diego Pérez (Koma)');
    expect(r.state.contacts['premise-driven_bitcoin_evolution']).toBeTruthy();
  });
  it('preserves operator customNameSource flag', () => {
    const json = {
      '1@lid': { pushedName: 'X', customName: '', customNameSource: 'pushname' },
    };
    const r = migrateJsonToYaml(json);
    const onlyContact = Object.values(r.state.contacts)[0];
    expect(onlyContact.customNameSource).toBe('pushname');
  });
  it('returns null for non-object input', () => {
    expect(migrateJsonToYaml(null)).toBe(null);
    expect(migrateJsonToYaml('garbage')).toBe(null);
  });
});

describe('personality frontmatter / allowed_tools (security scoping)', () => {
  const tmpDirs = [];
  async function makeOpDir(files) {
    const dir = await mkdtemp(join(tmpdir(), 'egpt-personalities-'));
    tmpDirs.push(dir);
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(dir, name), body, 'utf8');
    }
    return dir;
  }

  it('readPersonalityMeta returns frontmatter allowed_tools when present', async () => {
    const operatorDir = await makeOpDir({
      'system.md': `---\nallowed_tools: all\n---\n\n# Who I am\nI'm system-e.\n`,
    });
    const meta = await readPersonalityMeta('system', { operatorDir, shippedDir: operatorDir });
    expect(meta.allowed_tools).toBe('all');
  });

  it('readPersonalityMeta supports array of tools', async () => {
    const operatorDir = await makeOpDir({
      'restricted.md': `---\nallowed_tools: [Read, Grep]\n---\n\n# body\n`,
    });
    const meta = await readPersonalityMeta('restricted', { operatorDir, shippedDir: operatorDir });
    expect(meta.allowed_tools).toEqual(['Read', 'Grep']);
  });

  it('readPersonalityMeta falls back to DEFAULT_PERSONALITY_TOOLS when frontmatter omitted', async () => {
    const operatorDir = await makeOpDir({
      'nofm.md': `# Just a body, no frontmatter.\n`,
    });
    const meta = await readPersonalityMeta('nofm', { operatorDir, shippedDir: operatorDir });
    expect(meta.allowed_tools).toEqual(DEFAULT_PERSONALITY_TOOLS);
  });

  it('readPersonalityMeta falls back to safe default when file missing', async () => {
    const operatorDir = await makeOpDir({});
    const meta = await readPersonalityMeta('does-not-exist', { operatorDir, shippedDir: operatorDir });
    expect(meta.allowed_tools).toEqual(DEFAULT_PERSONALITY_TOOLS);
  });

  it('readPersonality strips the frontmatter from the body', async () => {
    const operatorDir = await makeOpDir({
      'p.md': `---\nallowed_tools: []\n---\n\n# Body starts here.\n`,
    });
    const body = await readPersonality('p', { operatorDir, shippedDir: operatorDir });
    expect(body).toBe('\n# Body starts here.\n');
    expect(body).not.toContain('allowed_tools');
  });

  it('DEFAULT_PERSONALITY_TOOLS bans self-elevation primitives', () => {
    // Regression guard: a personality without frontmatter MUST NOT get
    // any tool that allows shelling out, spawning sub-agents, or
    // executing notebook code. Read/Write/Edit on files inside the
    // slug-dir are fine — additionalDirectories pins them.
    //
    // Operator (2026-05-22) refinement: conversation-e should be able
    // to write text files (summaries, notes, scratch state) within its
    // own slug-dir, so Write+Edit ARE allowed. Bash/Agent/NotebookEdit
    // stay forbidden because they're the self-elevation primitives:
    //   - Bash: chmod+exec arbitrary scripts; escapes additionalDirectories
    //   - Agent: spawn sub-agents that may escape the scope
    //   - NotebookEdit: executes notebook code blocks
    const forbidden = ['Bash', 'Agent', 'NotebookEdit'];
    for (const t of forbidden) {
      expect(DEFAULT_PERSONALITY_TOOLS).not.toContain(t);
    }
    expect(DEFAULT_PERSONALITY_TOOLS).toContain('Read');
    expect(DEFAULT_PERSONALITY_TOOLS).toContain('Write');
  });

  // Cleanup — was `expect(true).toBe(true)` (tautology audit 2026-05-29).
  // Now actually verifies each temp dir was removed.
  it('temp dirs cleaned up', async () => {
    const dirs = tmpDirs.splice(0);
    await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true })));
    for (const d of dirs) expect(existsSync(d)).toBe(false);
  });
});

describe('ISO time helpers', () => {
  it('nowIsoString produces parseable ISO 8601', () => {
    const s = nowIsoString();
    expect(typeof s).toBe('string');
    expect(Number.isNaN(Date.parse(s))).toBe(false);
  });
  it('isoFromMs converts numbers to ISO', () => {
    expect(isoFromMs(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(isoFromMs(1779216717520)).toBe(new Date(1779216717520).toISOString());
    expect(isoFromMs('not-a-number')).toBe(null);
    expect(isoFromMs(NaN)).toBe(null);
  });
});
