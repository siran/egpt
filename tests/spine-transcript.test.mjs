// tests/spine-transcript.test.mjs — the §3.1 stats-collector chokepoint: transcript.log()
// fires recordMemberStat fire-and-forget on every received message, and NEVER throws/rejects
// even when the collector's io read/write blows up. Same createTranscript harness shape as
// spine-v1.test.mjs (fake contacts resolver + fake io).
import { describe, it, expect } from 'vitest';
import { createTranscript } from '../src/spine/transcript.mjs';

// The collector is fire-and-forget (not awaited by log()); give its async read-merge-write
// a beat to land before asserting on the written stats.yaml.
const settle = () => new Promise((r) => setTimeout(r, 25));

// resolveStatFilename (inside recordMemberStat) scans the surface dir by body id to find a
// possibly-renamed stats file — so the collector io must virtualize readdir over the same
// Map its readFile/writeFile use (else it would fall back to the REAL fs). Lists the basenames
// of the map keys living directly under `dir` (paths normalized so Windows backslashes match).
const readdirOver = (files) => async (dir) => {
  const norm = (p) => String(p).replace(/\\/g, '/');
  const prefix = norm(dir).replace(/\/$/, '') + '/';
  const out = new Set();
  for (const k of files.keys()) {
    const nk = norm(k);
    if (nk.startsWith(prefix)) { const rest = nk.slice(prefix.length); if (!rest.includes('/')) out.add(rest); }
  }
  return [...out];
};

// A fake contacts resolver: chatId → a fixed slug (no rename self-heal needed here).
const fakeContacts = { resolve: async () => 'fam-1234567890' };

const ev = {
  surface: 'whatsapp', chatId: '!room:beeper.com', chatName: 'fam',
  senderId: '@whatsapp_555:beeper.local', ts: Date.UTC(2026, 6, 3, 14, 22),
  line: 'An@[fam].wa (14:22) #m1: hola', body: 'hola',
};

describe('transcript.log — §3.1 stats collector chokepoint', () => {
  it('fires the member collector into BOTH the per-chat and per-contact stats files (fire-and-forget)', async () => {
    const files = new Map();
    const io = {
      appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); },
      mkdir: async () => {},
      existsSync: (p) => files.has(p),
      readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
      writeFile: async (p, d) => { files.set(p, d); },
      readdir: readdirOver(files),
    };
    const t = createTranscript({ contacts: fakeContacts, io });
    expect(await t.log(ev)).toBe(true);
    await settle();
    // per-CHAT file: named by the chat DISPLAY name now (ev.chatName='fam' → fam.yaml), not the
    // opaque chatId — the members: map counter + the chat name land in it.
    const chat = [...files.entries()].find(([p]) => p.endsWith('fam.yaml'));
    expect(chat).toBeTruthy();
    expect(chat[1]).toContain('@whatsapp_555:beeper.local');   // the senderId keyed the counter
    expect(chat[1]).toContain('count: 1');
    expect(chat[1]).toContain('2026-07-03T14:22');             // last_seen = isoFromMs(ev.ts)
    expect(chat[1]).toContain('name: fam');                    // chat display name written onto the per-chat file
    // per-CONTACT file: keyed by the SANITIZED senderId (':' -> ~3a), flat rollup, NO name (ev has none)
    const contact = [...files.entries()].find(([p]) => p.endsWith('@whatsapp_555~3abeeper.local.yaml'));
    expect(contact).toBeTruthy();
    expect(contact[1]).toContain('count: 1');
    expect(contact[1]).toContain('2026-07-03T14:22');
    expect(contact[1]).not.toContain('name:');                 // ev carries no senderName → name never invented
  });

  it('threads ev.senderName into the per-contact file when the event carries one', async () => {
    const files = new Map();
    const io = {
      appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); },
      mkdir: async () => {},
      existsSync: (p) => files.has(p),
      readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
      writeFile: async (p, d) => { files.set(p, d); },
      readdir: readdirOver(files),
    };
    const t = createTranscript({ contacts: fakeContacts, io });
    expect(await t.log({ ...ev, senderName: 'Andrés' })).toBe(true);
    await settle();
    // present senderName → the contact file is NAMED by it (Andrés.yaml), and name is on the body.
    const contact = [...files.entries()].find(([p]) => p.endsWith('Andrés.yaml'));
    expect(contact).toBeTruthy();
    expect(contact[1]).toContain('name: Andrés');              // present senderName → refreshed onto the contact rollup
    expect(contact[1]).toContain('@whatsapp_555:beeper.local');  // body sender_id anchor preserved
  });

  it('never throws/rejects when the collector io read/write throws — transcript still appended', async () => {
    const logs = [];
    const files = new Map();
    const io = {
      appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); },
      mkdir: async () => {},
      existsSync: (p) => files.has(p),
      readFile: async () => { throw new Error('read blew up'); },
      writeFile: async () => { throw new Error('write blew up'); },
      readdir: readdirOver(files),
    };
    const t = createTranscript({ contacts: fakeContacts, io, onLog: (m) => logs.push(m) });
    await expect(t.log(ev)).resolves.toBe(true);   // collector failure is swallowed, log() still succeeds
    await settle();
    const transcript = [...files.entries()].find(([p]) => p.endsWith('transcript.md'));
    expect(transcript[1]).toContain('hola');        // the transcript append path is untouched by the collector
  });
});
