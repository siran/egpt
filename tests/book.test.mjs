// /book (src/spine/book.mjs): availability from the calendar's secret iCal address, booking by an
// iCalendar invitation over the /email SES path. Fake feed + fake SES: no request leaves.
import { describe, it, expect } from 'vitest';
import { busyFromIcs, createBookLimb } from '../src/spine/book.mjs';
import { createEmail } from '../src/spine/email.mjs';

const TZ = 'America/Caracas';                         // UTC-4, no DST
const NOW = Date.UTC(2026, 9, 15, 18, 0);             // Thu 2026-10-15 14:00 Caracas
const ICS_SECRET = 'private-0123456789abcdef0123456789abcdef';
const ICS_URL = `https://calendar.google.com/calendar/ical/demos%40contoso-services.example/${ICS_SECRET}/basic.ics`;
const KEY_ID = 'AKIAFAKEKEYID0000002';
const SECRET = 'fakeSecretValue/zyxwvutsrqponmlkjihgfedcba98';
const SECRETS = [ICS_SECRET, ICS_URL, KEY_ID, SECRET];
const EV = { surface: 'whatsapp', chatId: '!lead:beeper.local', chatName: 'Juan Pérez' };
const Z = (d, h, mi = 0) => Date.UTC(2026, 9, d, h, mi);   // October 2026, UTC
const C = (d, h, mi = 0) => Z(d, h + 4, mi);                // October 2026, Caracas wall clock

const ics = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
const WEEKLY_TU_TH_9 = ['DTSTART;TZID=America/Caracas:20261001T090000', 'DTEND;TZID=America/Caracas:20261001T100000', 'RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=TU,TH;UNTIL=20261231T235959Z', 'SUMMARY:Standup'];

const CONFIG = (book = {}, email = {}) => ({
  book: { ics_url: ICS_URL, calendar_email: 'demos@contoso-services.example', timezone: TZ, duration_minutes: 30, ...book },
  email: { from: 'Contoso <ventas@contoso.example>', to: ['contacto@contoso-services.example'], aws_access_key_id: KEY_ID, aws_secret_access_key: SECRET, ...email },
});

function build({ config = CONFIG(), feed = ics(), feedStatus = 200, feedThrows = null } = {}) {
  const logs = [];
  const sent = [];
  const feeds = [];
  const fetch = async (url, init = {}) => {
    if (url === ICS_URL) {
      feeds.push(url);
      if (feedThrows) throw feedThrows;
      return { ok: feedStatus === 200, status: feedStatus, text: async () => feed };
    }
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => '{"MessageId":"m-1"}' };
  };
  const getConfig = () => config;
  const mail = createEmail({ getConfig, fetch, now: () => NOW, log: (m) => logs.push(`[email] ${m}`) });
  const limb = createBookLimb({ getConfig, fetch, ses: mail.ses, missingMail: mail.missing, now: () => NOW, log: (m) => logs.push(`[book] ${m}`) });
  return { book: (date, time, summary = 'Demo Contoso — Colegio San José') => limb.book({ type: 'book', date, time, summary }, EV, 'edw-marketer'), logs, sent, feeds };
}

// The raw MIME of an SES call, and its text/calendar part decoded.
function invite(call) {
  const raw = Buffer.from(call.body.Content.Raw.Data, 'base64').toString('utf8');
  const headers = raw.slice(0, raw.indexOf('\r\n\r\n'));
  const boundary = /boundary="([^"]+)"/.exec(headers)[1];
  const cal = raw.split(`--${boundary}`).find((p) => p.includes('Content-Type: text/calendar'));
  const ical = Buffer.from(cal.slice(cal.indexOf('\r\n\r\n') + 4).replace(/\s+/g, ''), 'base64').toString('utf8').replace(/\r\n /g, '');
  return { raw, headers, cal, ical };
}

describe('busyFromIcs — the feed read as busy intervals', () => {
  const window = { tz: TZ, from: C(18, 0), to: C(28, 0) };

  it('UTC, TZID (another zone) and all-day events', () => {
    const busy = busyFromIcs(ics(
      ['DTSTART:20261020T140000Z', 'DTEND:20261020T143000Z'],
      ['DTSTART;TZID=Europe/Madrid:20261020T110000', 'DTEND;TZID=Europe/Madrid:20261020T120000'],
      ['DTSTART;VALUE=DATE:20261021', 'DTEND;VALUE=DATE:20261022'],
    ), window);
    expect(busy).toEqual([
      { s: Z(20, 14), e: Z(20, 14, 30) },
      { s: Z(20, 9), e: Z(20, 10) },          // Madrid is UTC+2 on 2026-10-20 (CEST)
      { s: C(21, 0), e: C(22, 0) },           // the whole day, in the calendar's zone
    ]);
  });

  it('a weekly RRULE (BYDAY, UNTIL) expands across the window', () => {
    const starts = busyFromIcs(ics(WEEKLY_TU_TH_9), window).map((b) => b.s);
    expect(starts).toEqual([C(20, 9), C(22, 9), C(27, 9)]);
  });

  it('COUNT and INTERVAL bound the expansion', () => {
    const daily = busyFromIcs(ics(['DTSTART;TZID=America/Caracas:20261019T150000', 'DTEND;TZID=America/Caracas:20261019T160000', 'RRULE:FREQ=DAILY;COUNT=3']), window);
    expect(daily.map((b) => b.s)).toEqual([C(19, 15), C(20, 15), C(21, 15)]);
    const biweekly = busyFromIcs(ics(['DTSTART:20261005T120000Z', 'DTEND:20261005T130000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2']), window);
    expect(biweekly.map((b) => b.s)).toEqual([Z(19, 12)]);
  });

  it('a series started years ago still lands in the window; one spent before it does not', () => {
    const old = busyFromIcs(ics(['DTSTART;TZID=America/Caracas:20190107T080000', 'DTEND;TZID=America/Caracas:20190107T083000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE']), window);
    expect(old.map((b) => b.s)).toEqual([C(19, 8), C(21, 8), C(26, 8)]);
    expect(busyFromIcs(ics(['DTSTART:20261010T120000Z', 'DTEND:20261010T130000Z', 'RRULE:FREQ=DAILY;COUNT=5']), window)).toEqual([]);
    expect(busyFromIcs(ics(['DTSTART:20261010T120000Z', 'DTEND:20261010T130000Z', 'RRULE:FREQ=DAILY;UNTIL=20261017']), window)).toEqual([]);
  });

  it('skips cancelled and transparent events; a nested VALARM does not leak into the event', () => {
    const busy = busyFromIcs(ics(
      ['DTSTART:20261020T140000Z', 'DTEND:20261020T150000Z', 'STATUS:CANCELLED'],
      ['DTSTART:20261020T160000Z', 'DTEND:20261020T170000Z', 'TRANSP:TRANSPARENT'],
      ['DTSTART:20261020T180000Z', 'DURATION:PT1H', 'BEGIN:VALARM', 'TRIGGER:-PT10M', 'DURATION:PT5M', 'END:VALARM'],
    ), window);
    expect(busy).toEqual([{ s: Z(20, 18), e: Z(20, 19) }]);
  });

  it('an unsupported RRULE is busy at its first instance only, and noted', () => {
    const notes = [];
    const busy = busyFromIcs(ics(['DTSTART:20261020T140000Z', 'DTEND:20261020T150000Z', 'RRULE:FREQ=MONTHLY;BYDAY=1TU']), { ...window, onNote: (m) => notes.push(m) });
    expect(busy).toEqual([{ s: Z(20, 14), e: Z(20, 15) }]);
    expect(notes).toEqual(['1 recurring event(s) with an unsupported RRULE counted at their first instance only']);
  });

  it('folded lines are unfolded', () => {
    const busy = busyFromIcs('BEGIN:VEVENT\r\nDTSTART:20261020T1\r\n 40000Z\r\nDTEND:20261020T150000Z\r\nEND:VEVENT\r\n', window);
    expect(busy).toEqual([{ s: Z(20, 14), e: Z(20, 15) }]);
  });
});

describe('/book — a free slot is booked by an invitation to book.calendar_email', () => {
  it('free: one SES call, raw MIME, METHOD:REQUEST, only the configured attendee', async () => {
    const { book, sent, feeds } = build();
    const r = await book('2026-10-20', '10:00');
    expect(r).toEqual({ outcome: 'booked', detail: 'invitation sent to the team calendar for 2026-10-20 10:00-10:30 (America/Caracas)' });
    expect(feeds).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.Destination).toEqual({ ToAddresses: ['demos@contoso-services.example'] });
    expect(sent[0].body.FromEmailAddress).toBe('Contoso <ventas@contoso.example>');
    const { headers, cal, ical } = invite(sent[0]);
    expect(headers).toMatch(/^To: demos@contoso-services\.example$/m);
    expect(cal).toContain('Content-Type: text/calendar; charset=UTF-8; method=REQUEST');
    expect(ical).toContain('METHOD:REQUEST');
    expect(ical).toMatch(/^UID:.+@egpt$/m);
    expect(ical).toMatch(/^DTSTAMP:20261015T180000Z$/m);
    expect(ical).toMatch(/^DTSTART:20261020T140000Z$/m);
    expect(ical).toMatch(/^DTEND:20261020T143000Z$/m);
    expect(ical).toContain('SUMMARY:Demo Contoso — Colegio San José');
    expect(ical).toContain('ORGANIZER:mailto:ventas@contoso.example');
    expect(ical).toContain('ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:demos@contoso-services.example');
  });

  it('addresses or headers in the summary never become recipients or headers', async () => {
    const { book, sent } = build();
    await book('2026-10-20', '10:00', 'Demo\r\nBcc: x@evil.test\r\nTo: y@evil.test; ATTENDEE:mailto:z@evil.test');
    expect(sent[0].body.Destination).toEqual({ ToAddresses: ['demos@contoso-services.example'] });
    const { headers, ical } = invite(sent[0]);
    expect(headers).not.toMatch(/evil/);
    expect(headers.split('\r\n').map((l) => l.split(':')[0])).toEqual(['From', 'To', 'Subject', 'Date', 'MIME-Version', 'Content-Type']);
    expect(ical.match(/^ATTENDEE.*$/gm)).toEqual(['ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:demos@contoso-services.example']);
    expect(ical).toContain('SUMMARY:Demo Bcc: x@evil.test To: y@evil.test\\; ATTENDEE:mailto:z@evil.test');
  });

  it('a slot booked here reads busy before the feed shows it', async () => {
    const { book, sent } = build();
    expect((await book('2026-10-20', '10:00')).outcome).toBe('booked');
    expect((await book('2026-10-20', '10:00')).outcome).toBe('busy');
    expect(sent).toHaveLength(1);
  });
});

describe('/book — a taken slot returns the nearest free slots inside working hours', () => {
  it('taken: no invitation, the three nearest free slots', async () => {
    const { book, sent } = build({ feed: ics(['DTSTART;TZID=America/Caracas:20261020T100000', 'DTEND;TZID=America/Caracas:20261020T110000']) });
    expect(await book('2026-10-20', '10:00')).toEqual({ outcome: 'busy', detail: 'that slot is taken; nearest free slots (America/Caracas): 2026-10-20 09:00, 2026-10-20 09:30, 2026-10-20 11:00' });
    expect(sent).toHaveLength(0);
  });

  it('a weekly RRULE instance blocks its slots too', async () => {
    const { book } = build({ feed: ics(WEEKLY_TU_TH_9, ['DTSTART;TZID=America/Caracas:20261020T100000', 'DTEND;TZID=America/Caracas:20261020T110000']) });
    expect((await book('2026-10-20', '10:00')).detail).toBe('that slot is taken; nearest free slots (America/Caracas): 2026-10-20 08:30, 2026-10-20 11:00, 2026-10-20 11:30');
  });

  it('outside working hours (evening, weekend) is busy with in-hours alternatives', async () => {
    const { book, sent } = build();
    expect(await book('2026-10-20', '19:00')).toEqual({ outcome: 'busy', detail: 'outside working hours (mon,tue,wed,thu,fri 08:00-17:00); nearest free slots (America/Caracas): 2026-10-20 15:30, 2026-10-20 16:00, 2026-10-20 16:30' });
    expect((await book('2026-10-24', '10:00')).detail).toMatch(/^outside working hours .*: 2026-10-23 \d\d:\d\d, 2026-10-23 \d\d:\d\d, 2026-10-23 16:30$/);
    expect(sent).toHaveLength(0);
  });

  it('a time already past is busy, and every offered slot is in the future', async () => {
    const { book } = build();
    expect((await book('2026-10-15', '09:00')).detail).toBe('that time has passed; nearest free slots (America/Caracas): 2026-10-15 14:30, 2026-10-15 15:00, 2026-10-15 15:30');
  });

  it('working_hours and duration come from config', async () => {
    const { book } = build({ config: CONFIG({ duration_minutes: 60, working_hours: { days: ['sat'], start: '09:00', end: '12:00' } }) });
    expect((await book('2026-10-20', '10:00')).detail).toBe('outside working hours (sat 09:00-12:00); nearest free slots (America/Caracas): 2026-10-24 09:00, 2026-10-24 09:30, 2026-10-24 10:00');
  });
});

describe('/book — not-configured, failed, and the secret boundary', () => {
  it('not-configured: no ics_url, no calendar_email, or no SES key — no feed read, no send', async () => {
    for (const config of [CONFIG({ ics_url: '' }), CONFIG({ calendar_email: '' }), CONFIG({}, { aws_access_key_id: '' }), CONFIG({}, { from: '' }), {}]) {
      const { book, feeds, sent, logs } = build({ config });
      expect(await book('2026-10-20', '10:00')).toEqual({ outcome: 'not-configured', detail: null });
      expect(feeds).toHaveLength(0);
      expect(sent).toHaveLength(0);
      expect(logs.filter((l) => l.startsWith('[book]'))).toHaveLength(1);
    }
  });

  it('an unreadable date fails back to the being with the expected form', async () => {
    for (const [date, time] of [[null, null], ['2026-02-30', '10:00'], ['2026-10-20', '25:00']]) {
      const { book, feeds } = build();
      expect(await book(date, time)).toEqual({ outcome: 'failed', detail: 'expected /book YYYY-MM-DD HH:MM <summary>' });
      expect(feeds).toHaveLength(0);
    }
  });

  it('a feed that fails is failed, and its secret address never reaches a log', async () => {
    const http = build({ feedStatus: 404 });
    expect(await http.book('2026-10-20', '10:00')).toEqual({ outcome: 'failed', detail: null });
    expect(http.logs.join('\n')).toMatch(/calendar feed HTTP 404/);
    const thrown = build({ feedThrows: new Error(`getaddrinfo ENOTFOUND for ${ICS_URL}`) });
    expect((await thrown.book('2026-10-20', '10:00')).outcome).toBe('failed');
    for (const s of SECRETS) { expect(http.logs.join('\n')).not.toContain(s); expect(thrown.logs.join('\n')).not.toContain(s); }
  });

  it('no secret appears in any result, log line, or sent message', async () => {
    const all = [];
    for (const feed of [ics(), ics(['DTSTART:20261020T140000Z', 'DTEND:20261020T150000Z'])]) {
      const { book, logs, sent } = build({ feed });
      all.push(JSON.stringify(await book('2026-10-20', '10:00')), ...logs, ...sent.map((c) => invite(c).raw), ...sent.map((c) => JSON.stringify(c.body)));
    }
    for (const s of SECRETS) expect(all.join('\n')).not.toContain(s);
  });
});
