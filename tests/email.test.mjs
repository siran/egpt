// /email + the ONE SES path (src/spine/email.mjs). Fake fetch: no request leaves the process.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmail, sigv4 } from '../src/spine/email.mjs';

const KEY_ID = 'AKIAFAKEKEYID0000001';
const SECRET = 'fakeSecretValue/abcdefghijklmnopqrstuv0123';
const CONFIG = (email = {}) => ({
  email: { region: 'us-east-1', from: 'Contoso <ventas@contoso.example>', to: ['contacto@contoso-services.example'], subject_prefix: '[Contoso lead]', aws_access_key_id: KEY_ID, aws_secret_access_key: SECRET, ...email },
});
const EV = { surface: 'whatsapp', chatId: '!lead:beeper.local', chatName: 'Juan Pérez' };

function fakeFetch(status = 200, body = '{"MessageId":"m-1"}') {
  const calls = [];
  const fetch = async (url, init = {}) => { calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null }); return { ok: status >= 200 && status < 300, status, text: async () => body }; };
  return { fetch, calls };
}
function build({ config = CONFIG(), status, body, transcript = '# transcript\n- Bea: hola\n' } = {}) {
  const logs = [];
  const reads = [];
  const f = fakeFetch(status, body);
  const readTranscript = async (ev) => { reads.push(ev); return transcript; };
  const mail = createEmail({ getConfig: () => config, fetch: f.fetch, readTranscript, now: () => Date.UTC(2026, 9, 15, 18, 0, 0), log: (m) => logs.push(m) });
  return { mail, logs, reads, calls: f.calls };
}

// The raw MIME of an SES call: top headers, the decoded subject, and each part's headers + decoded body.
function decode(call) {
  const raw = Buffer.from(call.body.Content.Raw.Data, 'base64').toString('utf8');
  const cut = raw.indexOf('\r\n\r\n');
  const headers = raw.slice(0, cut);
  const boundary = /boundary="([^"]+)"/.exec(headers)[1];
  const parts = raw.slice(cut).split(`--${boundary}`).slice(1, -1).map((p) => {
    const at = p.indexOf('\r\n\r\n');
    return { headers: p.slice(0, at).trim(), body: Buffer.from(p.slice(at + 4).replace(/\s+/g, ''), 'base64').toString('utf8') };
  });
  const subject = Buffer.from(/^Subject: =\?UTF-8\?B\?(.*)\?=$/m.exec(headers)[1], 'base64').toString('utf8');
  return { headers, parts, subject };
}

describe('sigv4 — the published AWS test vectors', () => {
  const base = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', amzDate: '20150830T123600Z', region: 'us-east-1' };
  it('get-vanilla', () => {
    expect(sigv4({ ...base, method: 'GET', host: 'example.amazonaws.com', service: 'service' }))
      .toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });
  it('IAM ListUsers (query + content-type)', () => {
    expect(sigv4({ ...base, method: 'GET', host: 'iam.amazonaws.com', service: 'iam', query: 'Action=ListUsers&Version=2010-05-08', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' } }))
      .toMatch(/Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7$/);
  });
});

describe('/email — the lead summary to the FIXED recipients', () => {
  it('sends through SES v2 SendEmail: config sender, config recipients, config subject prefix', async () => {
    const { mail, calls } = build();
    const r = await mail.email({ type: 'email', text: 'Lead: Juan, Colegio San José, 0414-000' }, EV, 'edw-marketer');
    expect(r).toEqual({ outcome: 'sent' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://email.us-east-1.amazonaws.com/v2/email/outbound-emails');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAFAKEKEYID0000001\/20261015\/us-east-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(calls[0].body.FromEmailAddress).toBe('Contoso <ventas@contoso.example>');
    expect(calls[0].body.Destination).toEqual({ ToAddresses: ['contacto@contoso-services.example'] });
    const m = decode(calls[0]);
    expect(m.subject).toBe('[Contoso lead] Juan Pérez');
    expect(m.headers).toMatch(/^To: contacto@contoso-services\.example$/m);
    expect(m.parts[0].body).toContain('Lead: Juan, Colegio San José, 0414-000');
  });

  it('addresses and headers in the being\'s text never become recipients or headers', async () => {
    const { mail, calls } = build();
    const text = 'To: attacker@evil.test\r\nBcc: x@evil.test\r\nSubject: hi — también a otro@evil.test';
    await mail.email({ type: 'email', text }, { ...EV, chatName: 'Bea\r\nBcc: y@evil.test' }, 'edw-marketer');
    const b = calls[0].body;
    expect(b.Destination).toEqual({ ToAddresses: ['contacto@contoso-services.example'] });
    expect(Object.keys(b)).toEqual(['FromEmailAddress', 'Destination', 'Content']);
    const m = decode(calls[0]);
    expect(m.headers.split('\r\n').map((l) => l.split(':')[0])).toEqual(['From', 'To', 'Subject', 'Date', 'MIME-Version', 'Content-Type']);
    expect(m.headers).not.toMatch(/evil/);
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.parts[0].body).toContain(text);                               // body text only, base64 in its part
  });

  it('not-configured: no keys, no sender, or no recipients — one log line, no request', async () => {
    for (const email of [{ aws_access_key_id: '', aws_secret_access_key: '' }, { from: '' }, { to: [] }]) {
      const { mail, calls, logs } = build({ config: CONFIG(email) });
      expect(await mail.email({ type: 'email', text: 'x' }, EV, 'b')).toEqual({ outcome: 'not-configured' });
      expect(calls).toHaveLength(0);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/not-configured \(missing /);
    }
    const { mail, calls } = build({ config: {} });
    expect(await mail.email({ type: 'email', text: 'x' }, EV, 'b')).toEqual({ outcome: 'not-configured' });
    expect(calls).toHaveLength(0);
  });

  it('a credentials_file stands in for the inline keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egpt-ses-'));
    const file = join(dir, 'credentials');
    writeFileSync(file, `[default]\naws_access_key_id = ${KEY_ID}\naws_secret_access_key = ${SECRET}\n`);
    const { mail, calls } = build({ config: CONFIG({ aws_access_key_id: '', aws_secret_access_key: '', credentials_file: file }) });
    expect(await mail.email({ type: 'email', text: 'x' }, EV, 'b')).toEqual({ outcome: 'sent' });
    expect(calls[0].init.headers.authorization).toContain(`Credential=${KEY_ID}/`);
    const missing = build({ config: CONFIG({ aws_access_key_id: '', aws_secret_access_key: '', credentials_file: join(dir, 'nope') }) });
    expect(await missing.mail.email({ type: 'email', text: 'x' }, EV, 'b')).toEqual({ outcome: 'not-configured' });
  });

  it('an SES refusal is failed; no secret reaches the logs or the result', async () => {
    const { mail, logs } = build({ status: 403, body: `{"message":"bad key ${KEY_ID} ${SECRET}"}` });
    const r = await mail.email({ type: 'email', text: 'x' }, EV, 'b');
    expect(r).toEqual({ outcome: 'failed' });
    expect(logs.join('\n')).toMatch(/HTTP 403/);
    for (const s of [KEY_ID, SECRET]) { expect(logs.join('\n')).not.toContain(s); expect(JSON.stringify(r)).not.toContain(s); }
  });

  it('a network error is failed, never a throw', async () => {
    const logs = [];
    const mail = createEmail({ getConfig: () => CONFIG(), fetch: async () => { throw new Error(`boom ${SECRET}`); }, log: (m) => logs.push(m) });
    expect(await mail.email({ type: 'email', text: 'x' }, EV, 'b')).toEqual({ outcome: 'failed' });
    expect(logs.join('\n')).not.toContain(SECRET);
  });
});

describe('/email — the spine attaches the conversation\'s transcript', () => {
  it('attached as text/markdown, named after the chat and date; recipients stay fixed', async () => {
    const transcript = '# Juan Pérez\n- Juan: quiero una demo\n- Contoso: con gusto\n';
    const { mail, calls, reads } = build({ transcript });
    expect(await mail.email({ type: 'email', text: 'Lead: Juan' }, EV, 'edw-marketer')).toEqual({ outcome: 'sent' });
    expect(reads).toEqual([EV]);
    expect(calls[0].body.Destination).toEqual({ ToAddresses: ['contacto@contoso-services.example'] });
    const m = decode(calls[0]);
    expect(m.headers).toMatch(/^Content-Type: multipart\/mixed; boundary="/m);
    expect(m.headers).toMatch(/^To: contacto@contoso-services\.example$/m);
    expect(m.parts).toHaveLength(2);
    expect(m.parts[0].headers).toMatch(/^Content-Type: text\/plain; charset=UTF-8$/m);
    expect(m.parts[1].headers).toMatch(/^Content-Type: text\/markdown; charset=UTF-8; name="transcript-Juan-Perez-2026-10-15\.md"$/m);
    expect(m.parts[1].headers).toMatch(/^Content-Disposition: attachment; filename="transcript-Juan-Perez-2026-10-15\.md"$/m);
    expect(m.parts[1].body).toBe(transcript);
  });

  it('over 1 MB: the last 1 MB from a line start is attached, and the body says so', async () => {
    const line = (i) => `- line ${String(i).padStart(7, '0')} ${'x'.repeat(80)}\n`;
    const transcript = Array.from({ length: 15000 }, (_, i) => line(i)).join('');
    const { mail, calls } = build({ transcript });
    await mail.email({ type: 'email', text: 'Lead' }, EV, 'b');
    const m = decode(calls[0]);
    const att = m.parts[1].body;
    expect(Buffer.byteLength(att)).toBeLessThanOrEqual(1024 * 1024);
    expect(transcript.endsWith(att)).toBe(true);
    expect(att.startsWith('- line ')).toBe(true);
    expect(m.parts[0].body).toContain(`The transcript is ${Buffer.byteLength(transcript)} bytes; attached are its last ${Buffer.byteLength(att)} bytes.`);
  });

  it('no transcript: still sent, no attachment, the body says so', async () => {
    const { mail, calls } = build({ transcript: null });
    expect(await mail.email({ type: 'email', text: 'Lead' }, EV, 'b')).toEqual({ outcome: 'sent' });
    const m = decode(calls[0]);
    expect(m.parts).toHaveLength(1);
    expect(m.parts[0].body).toContain('No transcript was found for this conversation.');
  });
});
