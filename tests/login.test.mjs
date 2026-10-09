// tests/login.test.mjs — the auto-login limb's STATE MACHINE, with the CDP driver and the admin
// poster MOCKED (plan plans/2610082200-EGPT-LOGIN-PLAN.md). The live facts the plan's Phase 0
// checks — that Chrome autofill fires, and that a CDP trusted click COMMITS the autofilled
// password — are deliberately NOT exercised here (they need a real brain profile); the seams are
// mocked so every branch runs with no browser.
//
// The secret boundary is the point: the password is Chrome's and is never read; the OTP is read +
// entered inside the limb and never surfaced. The last test proves neither a (simulated) field
// value nor the OTP ever reaches a returned token, a log line, or an admin post body.

import { describe, it, expect } from 'vitest';
import { createLoginLimb } from '../src/spine/login.mjs';

// A sentinel a buggy detect script MIGHT leak as a field value. The limb must ignore it: it reads
// selectors + boxes, never `.value`. Present only to prove the limb never echoes it.
const PW_SENTINEL = 'PWSECRET-should-never-surface';
// The OTP the mocked Gmail/GV DOM carries. The limb reads + enters it, and must never surface it.
const OTP_SENTINEL = '424242';

const SUBMIT_BOX = { x: 10, y: 20, width: 100, height: 40 };
const OTP_BOX = { x: 5, y: 5, width: 50, height: 20 };

// A scripted value source: returns queued values, repeating the last once drained.
function queue(values) {
  const q = [...values];
  return () => (q.length > 1 ? q.shift() : q[0]);
}

// Build the limb with a fully mocked CDP + bridge. `scripts` supplies what each injected script
// resolves to; `classify` is a queue so a branch can see e.g. '2fa' then 'logged-in'.
function makeLimb({ classify = ['logged-in'], autofillFilled = true, otpField = { ok: true, selector: '#otp', submit: { selector: '#otpsubmit', box: OTP_BOX } }, otpCode = OTP_SENTINEL, config = {} } = {}) {
  const logs = [];
  const notices = [];
  const calls = { openOrFocus: [], evaluate: [], click: [], fill: [], screenshot: 0 };
  const classifyNext = queue(classify);

  const cdp = {
    openOrFocus: async (url) => { calls.openOrFocus.push(url); return { targetId: `T:${url}` }; },
    evaluate: async (targetId, expr) => {
      calls.evaluate.push({ targetId, expr });
      if (expr.includes('no-password-input')) {
        // DETECT — returns selectors + box. The extra `value` field simulates a script that
        // leaked the credential; the limb must ignore it entirely.
        return { ok: true, password: { selector: '#pw', value: PW_SENTINEL }, form: { selector: '#f' }, submit: { selector: '#s', box: SUBMIT_BOX } };
      }
      if (expr.includes('-internal-autofill-selected')) return { ok: true, filled: autofillFilled };
      if (expr.includes('recaptcha')) return classifyNext();
      if (expr.includes('cssPath(el)')) return otpField;          // OTP_FIELD_SCRIPT
      if (expr.includes('innerText')) return otpCode;              // OTP_READ_SCRIPT (a mocked Gmail/GV DOM)
      return null;
    },
    click: async (targetId, x, y) => { calls.click.push({ targetId, x, y }); },
    fill: async (targetId, selector, value) => { calls.fill.push({ targetId, selector, value }); },
    screenshot: async () => { calls.screenshot++; return `PNG(${OTP_SENTINEL}${PW_SENTINEL})`; },  // bytes only; the string is sentinel-laden on purpose
  };
  const bridge = { noticeToChannel: async (n) => { notices.push(n); return true; } };
  const limb = createLoginLimb({ cdp, bridge, getConfig: () => ({ login: config }), log: (l) => logs.push(l), sleep: () => Promise.resolve() });
  return { limb, logs, notices, calls };
}

describe('login limb — the happy path', () => {
  it('detect → autofill-detected → trusted click → logged-in', async () => {
    const { limb, calls } = makeLimb({ classify: ['logged-in'] });
    const out = await limb.requestLogin('example.com');
    expect(out).toBe('logged-in');
    // It clicked the detected submit control's CENTER (the one trusted gesture).
    expect(calls.click).toHaveLength(1);
    expect(calls.click[0].x).toBe(SUBMIT_BOX.x + SUBMIT_BOX.width / 2);
    expect(calls.click[0].y).toBe(SUBMIT_BOX.y + SUBMIT_BOX.height / 2);
    // It never typed anything — no 2FA on this path.
    expect(calls.fill).toHaveLength(0);
    // It opened the resolved login URL.
    expect(calls.openOrFocus[0]).toBe('https://example.com/');
  });
});

describe('login limb — the 2FA branch', () => {
  it('reads the OTP from a mocked GV/Gmail DOM, fills it, submits, reaches logged-in', async () => {
    const { limb, calls } = makeLimb({ classify: ['2fa', 'logged-in'], otpCode: OTP_SENTINEL });
    const out = await limb.requestLogin('example.com');
    expect(out).toBe('logged-in');
    // The OTP was ENTERED exactly once, into the OTP field (entering it is allowed; surfacing it is not).
    expect(calls.fill).toHaveLength(1);
    expect(calls.fill[0].selector).toBe('#otp');
    expect(calls.fill[0].value).toBe(OTP_SENTINEL);
    // Two trusted clicks: the login submit, then the OTP submit.
    expect(calls.click).toHaveLength(2);
    // It opened an OTP source (gmail is first in the default otp_sources).
    expect(calls.openOrFocus).toContain('https://mail.google.com/');
  });

  it('no source yields a usable code → needs-2fa (and nothing is filled)', async () => {
    const { limb, calls } = makeLimb({ classify: ['2fa', '2fa'], otpCode: null });
    const out = await limb.requestLogin('example.com');
    expect(out).toBe('needs-2fa');
    expect(calls.fill).toHaveLength(0);
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

describe('login limb — no-autofill', () => {
  it('autofill never populates → no-autofill, and it never clicks submit', async () => {
    const { limb, calls } = makeLimb({ autofillFilled: false });
    const out = await limb.requestLogin('example.com');
    expect(out).toBe('no-autofill');
    expect(calls.click).toHaveLength(0);   // bounced before the trusted gesture
  });

  it('no login form on the page → failed', async () => {
    const out = await createLoginLimbNoForm().requestLogin('example.com');
    expect(out).toBe('failed');
  });
});

// A limb whose DETECT reports no password field — isolated so the no-form path is explicit.
function createLoginLimbNoForm() {
  const cdp = {
    openOrFocus: async () => ({ targetId: 't' }),
    evaluate: async (_t, expr) => (expr.includes('no-password-input') ? { ok: false, reason: 'no-password-input' } : null),
    click: async () => {}, fill: async () => {}, screenshot: async () => null,
  };
  return createLoginLimb({ cdp, bridge: { noticeToChannel: async () => true }, getConfig: () => ({}), log: () => {}, sleep: () => Promise.resolve() });
}

describe('login limb — the SECRET boundary (the invariant)', () => {
  // Across EVERY branch, neither a (simulated) field value nor the OTP may appear in the returned
  // token, any emitted log line, or any admin post body. The screenshot bytes the captcha branch
  // handles are sentinel-laden on purpose, to prove the notice carries only a SIZE, not the content.
  const branches = [
    { name: 'logged-in', opts: { classify: ['logged-in'] } },
    { name: '2fa → logged-in', opts: { classify: ['2fa', 'logged-in'], otpCode: OTP_SENTINEL } },
    { name: 'needs-2fa', opts: { classify: ['2fa', '2fa'], otpCode: OTP_SENTINEL } },
    { name: 'captcha-posted', opts: { classify: ['captcha'] } },
    { name: 'no-autofill', opts: { autofillFilled: false } },
    { name: 'failed', opts: { classify: ['login'] } },
  ];

  for (const b of branches) {
    it(`${b.name}: no credential or OTP in the return, the logs, or the admin posts`, async () => {
      const { limb, logs, notices } = makeLimb(b.opts);
      const out = await limb.requestLogin('example.com');

      const haystack = [out, ...logs, ...notices.map((n) => `${n.configKey} ${n.text}`)].join('\n');
      expect(haystack).not.toContain(PW_SENTINEL);
      expect(haystack).not.toContain(OTP_SENTINEL);
      // The return is always exactly one of the outcome tokens.
      expect(['logged-in', 'needs-2fa', 'captcha-posted', 'failed', 'no-autofill']).toContain(out);
    });
  }

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
