// tests/login.test.mjs — the auto-login limb's STATE MACHINE, with the CDP driver, the credential
// reader, and the admin poster MOCKED (plan plans/2610082200-EGPT-LOGIN-PLAN.md, approach (2)).
// The live facts — DPAPI unwrapping Chrome's master key, node:sqlite reading the store, AES-GCM
// decrypting the password — are deliberately NOT exercised here (they are Windows + live-only and
// already validated by the operator's probe); readChromeCredential is mocked, so every branch runs
// with no browser and no real decryption.
//
// The secret boundary is the point: the username + password the reader returns are LOCALS that
// reach cdp.fill ONLY, and the OTP the limb reads is entered the same way. The last tests prove
// neither the planted password sentinel nor the OTP ever reaches a returned token, a log line, or
// an admin post body.

import { describe, it, expect } from 'vitest';
import { createLoginLimb } from '../src/spine/login.mjs';

// The decrypted credential the mocked reader returns. The limb must type these through cdp.fill and
// null them — and must NEVER echo them. Present only to prove the limb never surfaces them.
const PW_SENTINEL = 'PWSECRET-should-never-surface';
const USER_SENTINEL = 'USERSECRET-should-never-surface';
// The OTP the mocked Gmail/GV DOM carries. The limb reads + enters it, and must never surface it.
const OTP_SENTINEL = '424242';

const SUBMIT_BOX = { x: 10, y: 20, width: 100, height: 40 };
const OTP_BOX = { x: 5, y: 5, width: 50, height: 20 };

// A scripted value source: returns queued values, repeating the last once drained.
function queue(values) {
  const q = [...values];
  return () => (q.length > 1 ? q.shift() : q[0]);
}

// Build the limb with a fully mocked CDP + reader + bridge. `cred` is what the credential reader
// returns (null = no saved login); `classify` is a queue so a branch can see e.g. '2fa' then
// 'logged-in'; `scripts` supplies what each injected script resolves to.
function makeLimb({ classify = ['logged-in'], cred = { username: USER_SENTINEL, password: PW_SENTINEL }, otpField = { ok: true, selector: '#otp', submit: { selector: '#otpsubmit', box: OTP_BOX } }, otpCode = OTP_SENTINEL, config = {} } = {}) {
  const logs = [];
  const notices = [];
  const calls = { openOrFocus: [], evaluate: [], click: [], fill: [], screenshot: 0, readCredential: [] };
  const classifyNext = queue(classify);

  const cdp = {
    openOrFocus: async (url) => { calls.openOrFocus.push(url); return { targetId: `T:${url}` }; },
    evaluate: async (targetId, expr) => {
      calls.evaluate.push({ targetId, expr });
      // DETECT — selectors + box only (the real script returns no field value). Now also reports
      // the username input's selector.
      if (expr.includes('no-password-input')) {
        return { ok: true, username: { selector: '#user' }, password: { selector: '#pw' }, form: { selector: '#f' }, submit: { selector: '#s', box: SUBMIT_BOX } };
      }
      if (expr.includes('recaptcha')) return classifyNext();     // CLASSIFY_SCRIPT
      if (expr.includes('cssPath(el)')) return otpField;         // OTP_FIELD_SCRIPT
      if (expr.includes('innerText')) return otpCode;            // OTP_READ_SCRIPT (a mocked Gmail/GV DOM)
      return null;
    },
    click: async (targetId, x, y) => { calls.click.push({ targetId, x, y }); },
    fill: async (targetId, selector, value) => { calls.fill.push({ targetId, selector, value }); },
    screenshot: async () => { calls.screenshot++; return `PNG(${OTP_SENTINEL}${PW_SENTINEL})`; },  // bytes only; the string is sentinel-laden on purpose
  };
  const bridge = { noticeToChannel: async (n) => { notices.push(n); return true; } };
  const readCredential = async (domain) => { calls.readCredential.push(domain); return cred ? { ...cred } : null; };
  const limb = createLoginLimb({ cdp, bridge, readCredential, getConfig: () => ({ login: config }), log: (l) => logs.push(l), sleep: async () => {} });
  return { limb, logs, notices, calls };
}

describe('login limb — the happy path', () => {
  it('settles through an SPA post-login navigation (login → logged-in) before the verdict', async () => {
    const { limb } = makeLimb({ classify: ['login', 'logged-in'] });   // still-at-login once, then navigated
    expect(await limb.requestLogin('example.com')).toBe('logged-in');
  });

  it('detect → read credential → type username+password → trusted click → logged-in', async () => {
    const { limb, calls } = makeLimb({ classify: ['logged-in'] });
    const out = await limb.requestLogin('example.com');
    expect(out).toBe('logged-in');
    // It read the credential for the requested site, then typed username then password.
    expect(calls.readCredential).toEqual(['example.com']);
    expect(calls.fill).toHaveLength(2);
    expect(calls.fill[0]).toMatchObject({ selector: '#user', value: USER_SENTINEL });
    expect(calls.fill[1]).toMatchObject({ selector: '#pw', value: PW_SENTINEL });
    // It clicked the detected submit control's CENTER (the one trusted gesture).
    expect(calls.click).toHaveLength(1);
    expect(calls.click[0].x).toBe(SUBMIT_BOX.x + SUBMIT_BOX.width / 2);
    expect(calls.click[0].y).toBe(SUBMIT_BOX.y + SUBMIT_BOX.height / 2);
    // It opened the resolved login URL.
    expect(calls.openOrFocus[0]).toBe('https://example.com/');
  });
});

describe('login limb — password-only page', () => {
  it('username:null in DETECT → types the password only, still clicks submit', async () => {
    const logs = [];
    const calls = { fill: [], click: [] };
    const classifyNext = queue(['logged-in']);
    const cdp = {
      openOrFocus: async () => ({ targetId: 't' }),
      evaluate: async (_t, expr) => {
        if (expr.includes('no-password-input')) return { ok: true, username: null, password: { selector: '#pw' }, form: null, submit: { selector: '#s', box: SUBMIT_BOX } };
        if (expr.includes('recaptcha')) return classifyNext();
        return null;
      },
      click: async (_t, x, y) => { calls.click.push({ x, y }); },
      fill: async (_t, selector, value) => { calls.fill.push({ selector, value }); },
      screenshot: async () => null,
    };
    const limb = createLoginLimb({ cdp, bridge: { noticeToChannel: async () => true }, readCredential: async () => ({ username: USER_SENTINEL, password: PW_SENTINEL }), getConfig: () => ({}), log: (l) => logs.push(l), sleep: async () => {} });
    const out = await limb.requestLogin('example.com');
    expect(out).toBe('logged-in');
    expect(calls.fill).toEqual([{ selector: '#pw', value: PW_SENTINEL }]);  // username skipped
    expect(calls.click).toHaveLength(1);
  });
});

describe('login limb — the 2FA branch', () => {
  it('reads the OTP from a mocked GV/Gmail DOM, fills it, submits, reaches logged-in', async () => {
    const { limb, calls } = makeLimb({ classify: ['2fa', 'logged-in'], otpCode: OTP_SENTINEL });
    const out = await limb.requestLogin('example.com');
    expect(out).toBe('logged-in');
    // username + password typed into the login form, then the OTP into the OTP field (3 fills).
    expect(calls.fill).toHaveLength(3);
    expect(calls.fill[2]).toMatchObject({ selector: '#otp', value: OTP_SENTINEL });
    // Two trusted clicks: the login submit, then the OTP submit.
    expect(calls.click).toHaveLength(2);
    // It opened an OTP source (gmail is first in the default otp_sources).
    expect(calls.openOrFocus).toContain('https://mail.google.com/');
  });

  it('no source yields a usable code → needs-2fa (and no OTP is filled)', async () => {
    const { limb, calls } = makeLimb({ classify: ['2fa', '2fa'], otpCode: null });
    const out = await limb.requestLogin('example.com');
    expect(out).toBe('needs-2fa');
    // The login credential was still typed (2 fills); only the OTP fill is absent.
    expect(calls.fill).toHaveLength(2);
    expect(calls.fill.some((f) => f.selector === '#otp')).toBe(false);
  });
});

describe('login limb — the CAPTCHA branch', () => {
  it('screenshots, posts to the admin channel via noticeToChannel, returns captcha-posted', async () => {
    const { limb, notices, calls } = makeLimb({ classify: ['captcha'] });
    const out = await limb.requestLogin('example.com');
    expect(out).toBe('captcha-posted');
    expect(calls.screenshot).toBe(1);
    // Posted through the EXISTING noticeToChannel, to the admin channel (the default captcha_channel key).
    expect(notices).toHaveLength(1);
    expect(notices[0].configKey).toBe('admin_channel');
  });

  it('captcha_channel override routes the notice to the named config key', async () => {
    const { limb, notices } = makeLimb({ classify: ['captcha'], config: { captcha_channel: 'log_to_group' } });
    await limb.requestLogin('example.com');
    expect(notices[0].configKey).toBe('log_to_group');
  });
});

describe('login limb — no-credential', () => {
  it('no saved login for the site → no-credential, and it never types or clicks submit', async () => {
    const { limb, calls } = makeLimb({ cred: null });
    const out = await limb.requestLogin('example.com');
    expect(out).toBe('no-credential');
    expect(calls.fill).toHaveLength(0);    // nothing to type
    expect(calls.click).toHaveLength(0);   // bounced before the trusted gesture
  });

  it('no login form on the page → failed (and the credential is never even read)', async () => {
    const { limb, calls } = (() => {
      const calls = { readCredential: [] };
      const cdp = {
        openOrFocus: async () => ({ targetId: 't' }),
        evaluate: async (_t, expr) => (expr.includes('no-password-input') ? { ok: false, reason: 'no-password-input' } : null),
        click: async () => {}, fill: async () => {}, screenshot: async () => null,
      };
      const readCredential = async (d) => { calls.readCredential.push(d); return { username: USER_SENTINEL, password: PW_SENTINEL }; };
      const limb = createLoginLimb({ cdp, bridge: { noticeToChannel: async () => true }, readCredential, getConfig: () => ({}), log: () => {} });
      return { limb, calls };
    })();
    const out = await limb.requestLogin('example.com');
    expect(out).toBe('failed');
    expect(calls.readCredential).toHaveLength(0);   // detect fails first → reader never called
  });
});

describe('login limb — the SECRET boundary (the invariant)', () => {
  // Across EVERY branch, neither the planted credential (username/password) nor the OTP may appear
  // in the returned token, any emitted log line, or any admin post body. The screenshot bytes the
  // captcha branch handles are sentinel-laden on purpose, to prove the notice carries only a SIZE.
  const branches = [
    { name: 'logged-in', opts: { classify: ['logged-in'] } },
    { name: '2fa → logged-in', opts: { classify: ['2fa', 'logged-in'], otpCode: OTP_SENTINEL } },
    { name: 'needs-2fa', opts: { classify: ['2fa', '2fa'], otpCode: OTP_SENTINEL } },
    { name: 'captcha-posted', opts: { classify: ['captcha'] } },
    { name: 'no-credential', opts: { cred: null } },
    { name: 'failed', opts: { classify: ['login'] } },
  ];

  for (const b of branches) {
    it(`${b.name}: no credential or OTP in the return, the logs, or the admin posts`, async () => {
      const { limb, logs, notices } = makeLimb(b.opts);
      const out = await limb.requestLogin('example.com');

      const haystack = [out, ...logs, ...notices.map((n) => `${n.configKey} ${n.text}`)].join('\n');
      expect(haystack).not.toContain(PW_SENTINEL);
      expect(haystack).not.toContain(USER_SENTINEL);
      expect(haystack).not.toContain(OTP_SENTINEL);
      // The return is always exactly one of the outcome tokens.
      expect(['logged-in', 'needs-2fa', 'captcha-posted', 'failed', 'no-credential']).toContain(out);
    });
  }

  it('the decrypted password reaches the fill seam (typed) but NOT the log/notice/return', async () => {
    const { limb, logs, notices, calls } = makeLimb({ classify: ['logged-in'] });
    const out = await limb.requestLogin('example.com');
    // Typed into the password field:
    expect(calls.fill.some((f) => f.value === PW_SENTINEL)).toBe(true);
    // Not surfaced anywhere else:
    expect(out).not.toContain(PW_SENTINEL);
    expect(logs.join('\n')).not.toContain(PW_SENTINEL);
    expect(notices.map((n) => n.text).join('\n')).not.toContain(PW_SENTINEL);
  });

  it('the OTP reaches the fill seam (entered) but NOT the log/notice/return', async () => {
    const { limb, logs, notices, calls } = makeLimb({ classify: ['2fa', 'logged-in'], otpCode: OTP_SENTINEL });
    const out = await limb.requestLogin('example.com');
    // Entered:
    expect(calls.fill.some((f) => f.value === OTP_SENTINEL)).toBe(true);
    // Not surfaced:
    expect(out).not.toContain(OTP_SENTINEL);
    expect(logs.join('\n')).not.toContain(OTP_SENTINEL);
    expect(notices.map((n) => n.text).join('\n')).not.toContain(OTP_SENTINEL);
  });
});
