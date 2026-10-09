// login.mjs — the auto-login limb (plan plans/2610082200-EGPT-LOGIN-PLAN.md, approach (ii)).
//
// When a being hits a login wall on the brain Chrome profile, log in with CHROME'S OWN saved
// password — without the being, the spine, or the model ever reading the credential. Chrome holds
// and masks the secret; the spine only drives the one TRUSTED gesture that makes Chrome commit it.
//
// This file is a STATE MACHINE with the CDP driver and the admin-channel poster as INJECTED SEAMS,
// so it unit-tests with no live browser (tests/login.test.mjs). boot.mjs builds the real seams from
// src/tools/cdp.mjs (the SAME driver /chrome, /tabs, the web-brains and bus.mjs already drive — not
// a second CDP client) and from its own noticeToChannel closure.
//
// THE SECRET BOUNDARY (the invariant — enforced here and locked by the secret test):
//   - The injected detect / field-state scripts report SELECTORS and BOXES only — never a field
//     VALUE. Nothing here ever reads `.value`.
//   - The limb's ONLY outputs are an outcome token: 'logged-in' | 'needs-2fa' | 'captcha-posted' |
//     'failed' | 'no-autofill'. No credential and no OTP is ever returned, logged, posted to the
//     admin channel, or put in a being's context.
//   - The 2FA OTP IS read by the limb from the GV/Gmail tab and entered through cdp.fill — but it
//     stays a local, ephemeral value: it reaches the fill seam and nothing else (never a return, a
//     log line, or a notice body).

export const OUTCOMES = ['logged-in', 'needs-2fa', 'captcha-posted', 'failed', 'no-autofill'];

const DEFAULTS = {
  otp_sources: ['gmail', 'google_voice'],
  captcha_channel: 'admin_channel',   // a config KEY noticeToChannel resolves (default = the admin channel)
  autofill_wait_ms: 4000,
  submit_overrides: {},               // per-domain: { url?, submit? } — login URL / submit selector overrides
};

// Where each OTP source is read from. voice.google.com / Gmail, per the plan.
const OTP_SOURCE_URLS = {
  gmail: 'https://mail.google.com/',
  google_voice: 'https://voice.google.com/',
  gv: 'https://voice.google.com/',
};

// ── the injected GENERIC scripts (run via cdp.evaluate = Runtime.evaluate) ──────────────────────
// Each is a self-contained IIFE. NONE of them read an input's .value: the detectors return a stable
// CSS selector plus (for click targets) a bounding box; the autofill probe reads field STATE via
// the autofill pseudo-classes; the classifier reads which KIND of control is on the page. The only
// value that ever crosses is the OTP, and that goes the OTHER way — into cdp.fill, never out.

const HELPERS = `
  const vis = (el) => { if (!el) return false; try { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; } catch (e) { return false; } };
  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
    const parts = []; let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      const name = node.getAttribute && node.getAttribute('name');
      if (name) { parts.unshift(node.tagName.toLowerCase() + '[name="' + name + '"]'); break; }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) { const idx = [...parent.children].filter((c) => c.tagName === node.tagName).indexOf(node) + 1; part += ':nth-of-type(' + idx + ')'; }
      parts.unshift(part); node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const boxOf = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
  const submitIn = (scope) => [...scope.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])')].find(vis)
      || [...scope.querySelectorAll('button, [role="button"]')].find(vis) || null;
`;

// Find the password input, its form, and the submit control. { ok, password:{selector},
// form:{selector}|null, submit:{selector, box} } — or { ok:false, reason }.
const DETECT_SCRIPT = `(() => {${HELPERS}
  const pw = [...document.querySelectorAll('input[type="password"]')].find(vis);
  if (!pw) return { ok: false, reason: 'no-password-input' };
  const form = pw.form || null;
  const submit = submitIn(form || document);
  if (!submit) return { ok: false, reason: 'no-submit-control' };
  return { ok: true, password: { selector: cssPath(pw) }, form: form ? { selector: cssPath(form) } : null, submit: { selector: cssPath(submit), box: boxOf(submit) } };
})()`;

// Autofill probe — STATE, not value. The autofill pseudo-classes are the only robust signal, and
// the value is masked anyway. `has` tries each independently so an unsupported selector is false,
// not a throw. { ok, filled } | { ok:false, reason:'gone' }.
const autofillScript = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, reason: 'gone' };
  const has = (sel) => { try { return el.matches(sel); } catch (e) { return false; } };
  return { ok: true, filled: has(':autofill') || has(':-webkit-autofill') || has(':-internal-autofill-selected') };
})()`;

// Classify the post-submit page. 'captcha' | '2fa' | 'login' (still at step 1 / rejected) |
// 'logged-in' (no password, no 2FA, no captcha — the plan's acknowledged drift: generic first).
const CLASSIFY_SCRIPT = `(() => {${HELPERS}
  const q = (sel) => { try { return [...document.querySelectorAll(sel)].some(vis); } catch (e) { return false; } };
  if (q('iframe[src*="recaptcha"]') || q('iframe[src*="hcaptcha"]') || q('iframe[title*="captcha" i]') || q('.g-recaptcha') || q('[data-sitekey]') || q('#captcha')) return 'captcha';
  const hasPw = q('input[type="password"]');
  const otp = q('input[autocomplete="one-time-code"]') || q('input[name*="otp" i]') || q('input[id*="otp" i]') || q('input[name*="code" i]') || q('input[name*="totp" i]');
  if (otp && !hasPw) return '2fa';
  if (hasPw) return 'login';
  return 'logged-in';
})()`;

// Locate the OTP input + its nearest submit. Selectors + box only, never the value.
const OTP_FIELD_SCRIPT = `(() => {${HELPERS}
  const el = [...document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="code" i], input[name*="totp" i]')].find(vis);
  if (!el) return { ok: false };
  const submit = submitIn(el.form || document);
  return { ok: true, selector: cssPath(el), submit: submit ? { selector: cssPath(submit), box: boxOf(submit) } : null };
})()`;

// Read the latest verification code from an OTP-source tab's DOM. Best-effort + generic: a 4-8
// digit run next to a verification cue first, else a lone 6-digit group. Returns the code STRING or
// null. The limb treats the return as ephemeral and never surfaces it.
const OTP_READ_SCRIPT = `(() => {
  const text = (document.body && document.body.innerText) || '';
  const near = text.match(/(?:code|verification|verify|otp|g-)[^0-9]{0,24}(\\d{4,8})/i);
  if (near) return near[1];
  const any = text.match(/(?:^|[^\\d])(\\d{6})(?:[^\\d]|$)/);
  return any ? any[1] : null;
})()`;

const centerOf = (box) => ({ x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + (box?.height ?? 0) / 2 });
const isCode = (c) => typeof c === 'string' && /^\d{4,8}$/.test(c);

// Resolve <site> to a login URL. A full URL is used as-is; a bare domain becomes https://<domain>/;
// a submit_overrides[<domain>].url wins. (submit_overrides[<domain>].submit overrides the submit
// selector later.)
function resolveUrl(site, overrides) {
  const s = String(site || '').trim();
  const ov = overrides?.[s] || overrides?.[s.toLowerCase()];
  if (ov?.url) return ov.url;
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s.replace(/^\/+/, '')}/`;
}

/**
 * The limb. All I/O is through the two seams, so the whole machine runs in a test with fakes.
 * @param {object} o
 * @param {object} o.cdp     { openOrFocus(url)->{targetId}, evaluate(id,expr)->value,
 *                             click(id,x,y), fill(id,selector,value), screenshot(id)->base64 }
 * @param {object} o.bridge  { noticeToChannel({configKey, text}) } — boot's EXISTING admin poster
 * @param {function} o.getConfig  () -> the live config (login block read as .login)
 * @param {function} [o.log]       (line) -> daemon log; only ever handed outcome + domain + selector
 * @param {function} [o.sleep]     (ms) -> Promise; injected so the autofill wait is instant in tests
 */
export function createLoginLimb({ cdp, bridge, getConfig = () => ({}), log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const loginCfg = () => ({ ...DEFAULTS, ...(getConfig()?.login || {}) });

  const done = (token, site, note) => {
    log(`[login] ${site || '?'} -> ${token}${note ? ` (${note})` : ''}`);
    return token;
  };

  // Poll the password field's autofill STATE until it is populated or the budget runs out.
  async function waitForAutofill(targetId, selector, waitMs) {
    const pollMs = 150;
    const deadline = Math.max(1, Math.ceil(waitMs / pollMs));
    for (let i = 0; i < deadline; i++) {
      const st = await cdp.evaluate(targetId, autofillScript(selector));
      if (st && st.ok && st.filled) return true;
      await sleep(pollMs);
    }
    return false;
  }

  async function readOtp(source) {
    const url = OTP_SOURCE_URLS[String(source || '').toLowerCase()];
    if (!url) return null;
    try {
      const { targetId } = await cdp.openOrFocus(url);
      const code = await cdp.evaluate(targetId, OTP_READ_SCRIPT);   // local + ephemeral
      return isCode(code) ? code : null;
    } catch { return null; }
  }

  async function captchaBranch(targetId, site, cfg) {
    let bytes = 0;
    try { const png = await cdp.screenshot(targetId); if (typeof png === 'string') bytes = png.length; } catch { /* a missing screenshot never blocks the notice */ }
    // The EXISTING admin poster (noticeToChannel). captcha_channel is a config KEY (default
    // admin_channel). TEXT ONLY — the screenshot image itself is NOT delivered: noticeToChannel has
    // no attachment path (see the report's STOP item). The notice carries only the domain + a size
    // descriptor, never anything read off the page.
    try {
      await bridge.noticeToChannel({
        configKey: cfg.captcha_channel || 'admin_channel',
        text: `login ${site}: a CAPTCHA is blocking sign-in — solve it in the brain Chrome, then re-run /login ${site}. (screenshot ${bytes}B captured; image delivery pending)`,
      });
    } catch { /* fail-closed: a notice that didn't land never changes the outcome */ }
    return done('captcha-posted', site);
  }

  async function twofaBranch(targetId, site, cfg, loginForm) {
    const field = await cdp.evaluate(targetId, OTP_FIELD_SCRIPT);
    if (!field || !field.ok) return done('needs-2fa', site, 'no OTP field found');
    for (const source of cfg.otp_sources || []) {
      const code = await readOtp(source);            // local — never logged / returned / posted
      if (!code) continue;
      await cdp.fill(targetId, field.selector, code); // enter it; the value reaches the fill seam only
      const box = field.submit?.box || loginForm?.submit?.box;
      if (box) await cdp.click(targetId, centerOf(box).x, centerOf(box).y);
      const state = await cdp.evaluate(targetId, CLASSIFY_SCRIPT);
      if (state === 'logged-in') return done('logged-in', site, `2fa via ${source}`);
      if (state === 'captcha') return captchaBranch(targetId, site, cfg);
    }
    return done('needs-2fa', site, 'no source yielded a usable code');
  }

  /**
   * requestLogin(domain) — the limb's one entry point. Returns an OUTCOME token (never throws; an
   * unexpected error classifies as 'failed'). Exposed by the spine and reached by /login <site>.
   */
  async function requestLogin(domain) {
    const cfg = loginCfg();
    const site = String(domain || '').trim();
    if (!site) return done('failed', site, 'no site given');
    try {
      const url = resolveUrl(site, cfg.submit_overrides);
      const { targetId } = await cdp.openOrFocus(url);

      const form = await cdp.evaluate(targetId, DETECT_SCRIPT);
      if (!form || !form.ok || !form.submit) return done('failed', site, form?.reason || 'no login form');

      const filled = await waitForAutofill(targetId, form.password.selector, cfg.autofill_wait_ms);
      if (!filled) return done('no-autofill', site);

      const ov = cfg.submit_overrides?.[site]?.submit;
      const box = ov ? (await cdp.evaluate(targetId, `(() => { const el = document.querySelector(${JSON.stringify(ov)}); if (!el) return null; const b = el.getBoundingClientRect(); return { x:b.x, y:b.y, width:b.width, height:b.height }; })()`)) : form.submit.box;
      if (!box) return done('failed', site, 'submit control not locatable');
      const c = centerOf(box);
      await cdp.click(targetId, c.x, c.y);            // the one TRUSTED gesture — Chrome commits its own password

      const state = await cdp.evaluate(targetId, CLASSIFY_SCRIPT);
      if (state === 'logged-in') return done('logged-in', site);
      if (state === 'captcha') return captchaBranch(targetId, site, cfg);
      if (state === '2fa') return twofaBranch(targetId, site, cfg, form);
      return done('failed', site, `still at ${state}`);
    } catch (e) {
      // e.message is a CDP / navigation error from a seam — never a field value or an OTP (those
      // live only in local vars and the fill seam, which sanitizes its own errors).
      return done('failed', site, e?.message ? String(e.message).slice(0, 120) : 'error');
    }
  }

  return { requestLogin };
}
