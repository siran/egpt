// boot-book-email.test.mjs — /book + /email wired end to end through boot (2026-10-15): the being's
// reply carries the verb, boot's limbs run it against the injected fetch (fake feed + fake SES), and
// the outcome returns to the being through the background wake, as a turn in the same chat.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-boot-book-email-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

let boot, emptyState, ensureContact;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

const CHAT = '!lead:beeper.com';
const NOW = Date.UTC(2026, 9, 15, 18, 0);   // Thu 2026-10-15 14:00 Caracas
const ICS_URL = 'https://calendar.google.com/calendar/ical/demos%40x/private-feedfacefeedfacefeedfacefeedface/basic.ics';
const KEY_ID = 'AKIAFAKEKEYID0000003';
const SECRET = 'fakeSecretValue/boot0123456789abcdefghijkl';
const CONFIG = (actions) => () => ({
  node_name: 'kg',
  user_name: 'John',
  beeper: { use: 'main', main: { account: 'you@example.com', token: 'TOK' } },
  agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, ...(actions ? { actions } : {}) } },
  email: { from: 'Contoso <ventas@contoso.example>', to: ['contacto@contoso-services.example'], subject_prefix: '[Contoso lead]', aws_access_key_id: KEY_ID, aws_secret_access_key: SECRET },
  book: { ics_url: ICS_URL, calendar_email: 'demos@contoso-services.example', timezone: 'America/Caracas', duration_minutes: 30 },
});

function memIo() {
  const files = new Map();
  const dirs = new Set();
  const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    files,
    appendFile: async (path, data) => files.set(path, `${files.get(path) ?? ''}${data}`),
    writeFile: async (path, data) => files.set(path, String(data)),
    readFile: async (path) => { if (!files.has(path)) throw missing(path); return files.get(path); },
    mkdir: async (path) => { dirs.add(path); },
    existsSync: (path) => files.has(path) || dirs.has(path),
    readdir: async (path) => [...files.keys()].filter((f) => dirname(f) === path).map((f) => f.slice(path.length + 1)),
    rename: async (from, to) => { if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); files.delete(from); },
  };
}

function fakeTransport() {
  const built = [];
  const start = async (opts) => {
    const spy = { opts, onIncoming: opts.onIncoming, streams: [] };
    built.push(spy);
    return {
      async send() { return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { init, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); } };
        spy.streams.push(h); return h;
      },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

function fakeFetch() {
  const ses = [];
  const feeds = [];
  const fetch = async (url, init = {}) => {
    if (url === ICS_URL) { feeds.push(url); return { ok: true, status: 200, text: async () => 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' }; }
    ses.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => '{"MessageId":"m-1"}' };
  };
  return { fetch, ses, feeds };
}

function seedOn() {
  const ens = ensureContact(emptyState(), 'whatsapp', CHAT, { pushedName: 'Bea', slugHint: 'bea' });
  const entry = ens.state.contacts.whatsapp[CHAT];
  entry.agents = { ...(entry.agents ?? {}), egpt: { ...(entry.agents?.egpt ?? {}), mode: 'on' } };
  return ens.state;
}

async function run(actions) {
  const { start, built } = fakeTransport();
  const net = fakeFetch();
  const io = memIo();
  const lines = [];
  const prompts = [];
  let convState = seedOn();
  const app = await boot({
    readConfig: CONFIG(actions),
    startBridge: start,
    makeSession: (opts) => ({
      opts, sessionId: 'sess-1',
      async turn(m, onUpdate) {
        prompts.push(m);
        const text = prompts.length === 1 ? 'Perfecto, le aviso al equipo.\n/email Lead: Bea, Colegio San José\n/book 2026-10-20 10:00 Demo Contoso — Bea' : `↩ ${m}`;
        onUpdate?.(text);
        return { text, sessionId: this.sessionId };
      },
      close() {},
    }),
    probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => convState,
    writeState: async (s) => { convState = s; },
    io, ingest: false, tickMs: 0,
    now: () => NOW,
    fetch: net.fetch,
    log: { line: (m) => lines.push(m) },
  });
  const spy = built[0];
  await spy.onIncoming('quiero una demo el martes 20 a las 10', {
    chatId: CHAT, chatName: 'Bea', network: 'whatsapp', userId: 'u-1', senderName: 'Bea', authorized: true, msgKey: 'm1',
  });
  return { app, spy, net, io, lines, prompts };
}

describe('boot — /email and /book run for an enabled agent and wake it with the outcome', () => {
  it('both limbs run, each outcome returns as a wake turn in the same chat, and no secret leaks', async () => {
    const { app, spy, net, io, lines, prompts } = await run(['book', 'email']);
    expect(spy.streams[0].finals[0]).toContain('Perfecto, le aviso al equipo.');
    expect(spy.streams[0].finals[0]).not.toMatch(/\/email|\/book/);
    await vi.waitFor(() => expect(spy.streams[2]?.finals).toHaveLength(1), { timeout: 5000 });

    expect(net.ses.map((c) => c.body.Destination.ToAddresses)).toEqual([['contacto@contoso-services.example'], ['demos@contoso-services.example']]);
    expect(net.feeds).toHaveLength(1);
    expect(spy.streams.map((s) => s.chatId)).toEqual([CHAT, CHAT, CHAT]);
    expect(prompts[1]).toContain('A background task you started has finished: /email → sent.');
    expect(prompts[2]).toContain('A background task you started has finished: /book 2026-10-20 10:00 → booked: invitation sent to the team calendar for 2026-10-20 10:00-10:30 (America/Caracas).');

    const raw = Buffer.from(net.ses[0].body.Content.Raw.Data, 'base64').toString('utf8');
    const attachment = raw.split(/\r\n--egpt-[^\r\n]+/).find((p) => p.includes('Content-Disposition: attachment; filename="transcript-Bea-'));
    expect(Buffer.from(attachment.slice(attachment.indexOf('\r\n\r\n') + 4).replace(/\s+/g, ''), 'base64').toString('utf8')).toContain('quiero una demo el martes 20 a las 10');

    const transcript = [...io.files.entries()].find(([p]) => p.endsWith('transcript.md'))?.[1] ?? '';
    expect(transcript).toContain('/email "Lead: Bea, Colegio San José" → sent');
    expect(transcript).toContain('/book 2026-10-20 10:00 "Demo Contoso — Bea" → booked');

    const seen = [lines.join('\n'), prompts.join('\n'), transcript, ...spy.streams.flatMap((s) => s.finals)].join('\n');
    for (const s of [ICS_URL, 'private-feedface', KEY_ID, SECRET]) expect(seen).not.toContain(s);
    app.stop();
  });

  it('an agent without agents.<name>.actions: refused, nothing sent, no wake', async () => {
    const { app, spy, net, lines } = await run(undefined);
    expect(spy.streams[0].finals[0]).toContain('Perfecto, le aviso al equipo.');
    expect(spy.streams[0].finals[0]).not.toMatch(/\/email|\/book/);
    await new Promise((r) => setTimeout(r, 50));
    expect(net.ses).toEqual([]);
    expect(net.feeds).toEqual([]);
    expect(spy.streams).toHaveLength(1);
    expect(lines.filter((l) => /not enabled for egpt/.test(l))).toHaveLength(2);
    app.stop();
  });
});
