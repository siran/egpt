// tests/spine-transcript.test.mjs — the §3.1 stats-collector chokepoint: transcript.log()
// fires recordMemberStat fire-and-forget on every received message, and NEVER throws/rejects
// even when the collector's io read/write blows up. Same createTranscript harness shape as
// spine-v1.test.mjs (fake contacts resolver + fake io).
import { describe, it, expect } from 'vitest';
import { createTranscript } from '../src/spine/transcript.mjs';

// The collector is fire-and-forget (not awaited by log()); give its async read-merge-write
// a beat to land before asserting on the written stats.yaml.
const settle = () => new Promise((r) => setTimeout(r, 25));

// A fake contacts resolver: chatId → a fixed slug (no rename self-heal needed here).
const fakeContacts = { resolve: async () => 'fam-1234567890' };

const ev = {
  surface: 'whatsapp', chatId: '!room:beeper.com', chatName: 'fam',
  senderId: '@whatsapp_555:beeper.local', ts: Date.UTC(2026, 6, 3, 14, 22),
  line: 'An@[fam].wa (14:22) #m1: hola', body: 'hola',
};

describe('transcript.log — §3.1 stats collector chokepoint', () => {
  it('fires the member collector into stats.yaml (fire-and-forget) on a received message', async () => {
    const files = new Map();
    const io = {
      appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); },
      mkdir: async () => {},
      existsSync: (p) => files.has(p),
      readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
      writeFile: async (p, d) => { files.set(p, d); },
    };
    const t = createTranscript({ contacts: fakeContacts, io });
    expect(await t.log(ev)).toBe(true);
    await settle();
    const stats = [...files.entries()].find(([p]) => p.endsWith('stats.yaml'));
    expect(stats).toBeTruthy();
    expect(stats[1]).toContain('@whatsapp_555:beeper.local');   // the senderId keyed the counter
    expect(stats[1]).toContain('count: 1');
    expect(stats[1]).toContain('2026-07-03T14:22');             // last_seen = isoFromMs(ev.ts)
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
    };
    const t = createTranscript({ contacts: fakeContacts, io, onLog: (m) => logs.push(m) });
    await expect(t.log(ev)).resolves.toBe(true);   // collector failure is swallowed, log() still succeeds
    await settle();
    const transcript = [...files.entries()].find(([p]) => p.endsWith('transcript.md'));
    expect(transcript[1]).toContain('hola');        // the transcript append path is untouched by the collector
  });
});
