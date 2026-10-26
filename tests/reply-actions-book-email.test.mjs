// /book + /email as being limbs (src/spine/reply-actions.mjs): parsed like every limb, run ONLY for
// an agent whose agents.<name>.actions lists them, and their outcome handed back through `wake`
// (boot: spine.wakeOnBackground).
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseReplyActions, partialProse, createReplyActions, confinedFile } from '../src/spine/reply-actions.mjs';
import { limbAction } from '../src/dispatch-line.mjs';

const EV = { chatId: '!lead:beeper.local', surface: 'whatsapp', chatName: 'Juan' };
const BRIDGE = { send: async () => ({}), react: async () => true };

describe('parse', () => {
  it('/book <date> <time> <summary> and /email <text> are actions, stripped from the prose', () => {
    const { prose, run, stripped } = parseReplyActions('Perfecto, lo agendo.\n/book 2026-10-20 10:00 Demo EduWeb — Colegio San José\n/email Lead: Juan, Colegio San José, 0414-000', EV);
    expect(prose).toBe('Perfecto, lo agendo.');
    expect(stripped).toEqual([]);
    expect(run).toEqual([
      { type: 'book', chatId: EV.chatId, date: '2026-10-20', time: '10:00', summary: 'Demo EduWeb — Colegio San José' },
      { type: 'email', chatId: EV.chatId, text: 'Lead: Juan, Colegio San José, 0414-000' },
    ]);
  });

  it('a /book whose date is unreadable still runs, so its failure can reach the being', () => {
    expect(parseReplyActions('/book mañana a las 10 demo', EV).run).toEqual([{ type: 'book', chatId: EV.chatId, date: null, time: null, summary: 'mañana a las 10 demo' }]);
  });

  it('an empty or placeholder-only line is stripped, never run', () => {
    for (const line of ['/book', '/book <YYYY-MM-DD> <HH:MM> <summary>', '/email', '/email <text>']) {
      const { run, stripped, prose } = parseReplyActions(line, EV);
      expect(run).toEqual([]);
      expect(stripped).toHaveLength(1);
      expect(prose).toBe('');
    }
  });

  it('mid-sentence mentions stay prose; a streaming /book line is withheld until it ends', () => {
    expect(parseReplyActions('puedo usar /book y /email si hace falta', EV).run).toEqual([]);
    expect(partialProse('Listo.\n/bo', EV)).toBe('Listo.');
    expect(partialProse('Listo.\n/book 2026-10-20 10', EV)).toBe('Listo.');
  });
});

function build({ actions = { 'edw-marketer': ['book', 'email'] }, limbs, wake = vi.fn(async () => true) } = {}) {
  const logs = [];
  const calls = [];
  const fake = (type, r) => async (a, ev, being) => { calls.push({ type, a, ev, being }); return r; };
  const ra = createReplyActions({
    bridge: BRIDGE,
    limbs: limbs ?? { book: fake('book', { outcome: 'busy', detail: 'that slot is taken; nearest free slots (America/Caracas): 2026-10-20 11:00' }), email: fake('email', { outcome: 'sent' }) },
    actionsOf: (being) => actions[being],
    wake,
    onLog: (m) => logs.push(m),
  });
  const run = (text, being) => { const p = ra.parse(text, EV); return ra.execute(p.run, p.stripped, EV, { being }); };
  return { run, logs, calls, wake };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('execute — enabled agents only, outcome back through the wake', () => {
  it('an enabled agent runs the limb; the outcome is recorded and woken back into the same chat', async () => {
    const { run, calls, wake } = build();
    const { ran } = await run('/book 2026-10-20 10:00 Demo\n/email Lead: Juan', 'edw-marketer');
    expect(calls.map((c) => [c.type, c.being, c.ev.chatId])).toEqual([['book', 'edw-marketer', EV.chatId], ['email', 'edw-marketer', EV.chatId]]);
    expect(ran.map((a) => [a.type, a.outcome])).toEqual([['book', 'busy'], ['email', 'sent']]);
    await tick();
    expect(wake.mock.calls.map((c) => c[0])).toEqual([
      { being: 'edw-marketer', surface: 'whatsapp', chatId: EV.chatId, summaries: ['/book 2026-10-20 10:00 → busy: that slot is taken; nearest free slots (America/Caracas): 2026-10-20 11:00'] },
      { being: 'edw-marketer', surface: 'whatsapp', chatId: EV.chatId, summaries: ['/email → sent'] },
    ]);
  });

  it('a being NOT enabled cannot use the verbs: refused, logged, no limb, no wake, not recorded', async () => {
    for (const [being, actions] of [['egpt', { 'edw-marketer': ['book', 'email'] }], ['edw-marketer', { 'edw-marketer': ['email'] }], ['edw-marketer', {}]]) {
      const { run, calls, wake, logs } = build({ actions });
      const { ran } = await run('/book 2026-10-20 10:00 Demo', being);
      await tick();
      expect(calls).toEqual([]);
      expect(wake).not.toHaveBeenCalled();
      expect(ran).toEqual([]);
      expect(logs).toEqual([`book: not enabled for ${being} (agents.${being}.actions) — refused`]);
    }
  });

  it('the wake is never awaited — a turn that holds the FIFO cannot deadlock on it', async () => {
    const { run, wake } = build({ wake: vi.fn(() => new Promise(() => {})) });
    await expect(run('/email Lead', 'edw-marketer')).resolves.toMatchObject({ ran: [{ type: 'email', outcome: 'sent' }] });
    await tick();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('no limb wired → not-configured, still returned to the being; no wake wired → logged', async () => {
    const { run, wake } = build({ limbs: {} });
    await run('/email Lead', 'edw-marketer');
    await tick();
    expect(wake.mock.calls[0][0].summaries).toEqual(['/email → not-configured']);
    const logs = [];
    const ra = createReplyActions({ bridge: BRIDGE, limbs: { email: async () => ({ outcome: 'sent' }) }, actionsOf: () => ['email'], onLog: (m) => logs.push(m) });
    const p = ra.parse('/email Lead', EV);
    await ra.execute(p.run, p.stripped, EV, { being: 'x' });
    expect(logs).toEqual(['email: no wake wired — result not returned to x: /email → sent']);
  });

  it('a failing wake is logged, never thrown into the turn', async () => {
    const { run, logs } = build({ wake: async () => { throw new Error('nope'); } });
    await run('/email Lead', 'edw-marketer');
    await tick();
    expect(logs).toEqual(['email: result wake failed: nope']);
  });
});

describe('transcript stage-direction', () => {
  it('records what the limb did, outcome included', () => {
    expect(limbAction({ type: 'book', date: '2026-10-20', time: '10:00', summary: 'Demo EduWeb', outcome: 'booked' })).toBe('/book 2026-10-20 10:00 "Demo EduWeb" → booked');
    expect(limbAction({ type: 'email', text: 'Lead: Juan', outcome: 'not-configured' })).toBe('/email "Lead: Juan" → not-configured');
    expect(limbAction({ type: 'group', what: 'title', value: 'EduWeb · Ventas', outcome: 'set' })).toBe('/group title "EduWeb · Ventas" → set');
  });
});

// /group (2026-10-26): the being changes ITS OWN chat's photo, title or description. Gated and woken
// back exactly like /book and /email; the photo is held to the conversation folder by the /media check.
describe('/group — parse', () => {
  const TG = { chatId: 'tg:-1001234/77', surface: 'telegram', chatName: 'SI+EduWeb' };

  it('photo <path>, title <text>, description <text> are actions on ev.chatId, stripped from the prose', () => {
    const { prose, run, stripped } = parseReplyActions('Listo, lo cambio.\n/group photo media/logo.png\n/group title EduWeb · Ventas\n/group description Demos y ventas de EduWeb', TG);
    expect(prose).toBe('Listo, lo cambio.');
    expect(stripped).toEqual([]);
    expect(run).toEqual([
      { type: 'group', chatId: TG.chatId, what: 'photo', value: 'media/logo.png' },
      { type: 'group', chatId: TG.chatId, what: 'title', value: 'EduWeb · Ventas' },
      { type: 'group', chatId: TG.chatId, what: 'description', value: 'Demos y ventas de EduWeb' },
    ]);
  });

  it('malformed — no value, a bad sub-verb, an unsafe path, a doc placeholder — is stripped, never run', () => {
    for (const [line, reason] of [
      ['/group', /group: expected/],
      ['/group title', /group: expected/],
      ['/group description   ', /group: expected/],
      ['/group name Ventas', /group: expected/],
      ['/group photo ../../secrets.png', /traversal/],
      ['/group photo /etc/passwd', /absolute/],
      ['/group photo C:/Windows/x.png', /absolute/],
      ['/group photo <path>', /placeholder/],
      ['/group title <text>', /placeholder/],
      ['/group description <text>', /placeholder/],
    ]) {
      const { run, stripped, prose } = parseReplyActions(line, TG);
      expect(run, line).toEqual([]);
      expect(stripped, line).toHaveLength(1);
      expect(stripped[0].reason, line).toMatch(reason);
      expect(prose, line).toBe('');
    }
  });

  it('mid-sentence it is prose; a streaming /group line is withheld until it ends', () => {
    expect(parseReplyActions('puedo usar /group title X si quieres', TG).run).toEqual([]);
    expect(partialProse('Listo.\n/gro', TG)).toBe('Listo.');
    expect(partialProse('Listo.\n/group title Ven', TG)).toBe('Listo.');
  });
});

describe('/group — gated, outcome back through the wake', () => {
  const TG = { chatId: 'tg:-1001234/77', surface: 'telegram', chatName: 'SI+EduWeb' };
  const mk = ({ actions = { ed: ['group'] }, group, wake = vi.fn(async () => true) } = {}) => {
    const logs = [], calls = [];
    const ra = createReplyActions({
      bridge: BRIDGE,
      limbs: { group: group ?? (async (a, ev, being) => { calls.push({ a, ev, being }); return { outcome: 'failed', detail: 'Bad Request: not enough rights to change chat title' }; }) },
      actionsOf: (being) => actions[being],
      wake,
      onLog: (m) => logs.push(m),
    });
    const run = (text, being) => { const p = ra.parse(text, TG); return ra.execute(p.run, p.stripped, TG, { being }); };
    return { run, logs, calls, wake };
  };

  it('not listed in agents.<being>.actions: refused + logged, no limb, no wake', async () => {
    const { run, logs, calls, wake } = mk({ actions: { ed: ['book', 'email'] } });
    const { ran } = await run('/group title Ventas', 'ed');
    await tick();
    expect(calls).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
    expect(ran).toEqual([]);
    expect(logs).toEqual(['group: not enabled for ed (agents.ed.actions) — refused']);
  });

  it('listed: the limb gets the action for ev.chatId, and its outcome (Telegram\'s refusal) is woken back naming what was set', async () => {
    const { run, calls, wake } = mk();
    const { ran } = await run('/group title Ventas', 'ed');
    expect(calls.map((c) => [c.being, c.ev.chatId, c.a.what, c.a.value])).toEqual([['ed', TG.chatId, 'title', 'Ventas']]);
    expect(ran.map((a) => [a.type, a.outcome])).toEqual([['group', 'failed']]);
    await tick();
    expect(wake.mock.calls.map((c) => c[0])).toEqual([
      { being: 'ed', surface: 'telegram', chatId: TG.chatId, summaries: ['/group title → failed: Bad Request: not enough rights to change chat title'] },
    ]);
  });
});

// The ONE execute-time containment check (/media and /group photo both call it). '..' and absolute
// paths are refused at parse already; this is the re-check against the real folder.
describe('confinedFile — the shared conversation-folder check', () => {
  it('a file inside is its absolute path; .., absolute, missing and a link out are refused', () => {
    const base = mkdtempSync(join(tmpdir(), 'egpt-confined-'));
    const dir = join(base, 'room'), outside = join(base, 'operator');
    mkdirSync(join(dir, 'media'), { recursive: true }); mkdirSync(outside);
    writeFileSync(join(dir, 'media', 'logo.png'), 'png');
    writeFileSync(join(outside, 'secret.png'), 'png');
    symlinkSync(outside, join(dir, 'link'), 'junction');
    try {
      expect(confinedFile(dir, 'media/logo.png')).toEqual({ ok: true, path: join(dir, 'media', 'logo.png') });
      expect(confinedFile(dir, '../operator/secret.png')).toMatchObject({ ok: false, reason: expect.stringMatching(/escapes the conversation dir/) });
      expect(confinedFile(dir, join(outside, 'secret.png'))).toMatchObject({ ok: false, reason: expect.stringMatching(/escapes the conversation dir/) });
      expect(confinedFile(dir, 'link/secret.png')).toMatchObject({ ok: false, reason: expect.stringMatching(/through a link/) });
      expect(confinedFile(dir, 'nope.png')).toMatchObject({ ok: false, reason: expect.stringMatching(/not found/) });
      expect(confinedFile(null, 'media/logo.png')).toMatchObject({ ok: false, reason: expect.stringMatching(/no conversation dir/) });
      // the reason reaches the being (a wake turn): it never carries the host path
      for (const p of ['nope.png', 'link/secret.png', '../x']) expect(confinedFile(dir, p).reason).not.toContain(base);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
