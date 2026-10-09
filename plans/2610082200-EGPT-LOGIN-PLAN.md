# eGPT auto-login — plan (operator 2026-10-08)

## Goal
When an eGPT being hits a login wall on the brain Chrome profile, log in using
**Chrome's OWN saved password** — without the being, the spine, or the model ever
reading the credential. The browser holds the secret; we only trigger the submit.

## Approach: (ii) spine-driven over the existing CDP — NOT an extension, NOT DPAPI
Three options were weighed:
- **limb + DPAPI decrypt** — the spine would hold plaintext. REJECTED.
- **browser extension** — inside-page power + an own-store fallback, but needs
  packaging, a native-messaging host, and credential provisioning. More infra.
- **(ii) injected script, spine-driven** — reuses the CDP the spine already holds
  on the brain profile. An injected generic script finds the login form; the
  **spine** dispatches the one trusted gesture (the click) over CDP. CHOSEN:
  lightest, no new infra, and the secret boundary is **Chrome-enforced** (see below).

## The secret boundary (the invariant — do not violate)
- The password is Chrome's. It is NEVER read — Chrome **masks an autofilled
  password's value from page scripts until a user gesture**, so the injected
  script literally cannot read it; it only locates the form. The spine/being/model
  never hold it.
- The limb's ONLY outputs are an outcome token — `logged-in` / `needs-2fa` /
  `captcha-posted` / `failed` / `no-autofill`. Never a credential. Never into a
  being's context/transcript, Beeper, `beeper.log`, or the daemon log.
- The 2FA OTP is read by the limb from the GV/Gmail tab and entered; it too stays
  inside the limb (ephemeral), never surfaced.

## Trigger
- `/login <site>` (operator command, `isCommand`-gated), AND a being-facing
  `requestLogin(domain)` the spine exposes ("egpt can request to log in").
- Safety does NOT rest on the trigger. It rests on (a) Chrome holding + masking the
  secret and (b) Chrome's **domain-binding** — it only autofills domain X on domain
  X — so an auto-request can neither exfiltrate nor cross-fill to a phishing origin.

## Flow (the spine login limb, over CDP on the brain profile)
1. Resolve domain + login URL for `<site>`.
2. Open/focus the login page in the brain profile (CDP target).
3. Inject a **generic** detect script (`Page.addScriptToEvaluateOnNewDocument` or
   `Runtime.evaluate`): find a password `<input>`, its form, and the submit control;
   report a stable selector + bounding box. Agnostic heuristics first; per-site
   overrides later.
4. Wait for Chrome auto-sign-in to populate the fields — detect via field STATE,
   not value (the value is masked). Prereq: Chrome "auto sign-in" ON for the brain
   profile.
5. The **spine** dispatches a **trusted** `Input.dispatchMouseEvent` click on the
   submit control (CDP input carries user-activation → Chrome commits the autofilled
   password and submits).
6. Detect the outcome:
   - **2FA**: open the GV (`voice.google.com`) or Gmail tab, read the latest code
     from the DOM, fill the OTP field, trusted-submit.
   - **CAPTCHA**: CDP screenshot → post to the admin channel
     (`noticeToChannel` / `admin_channel`) → return `captcha-posted`; poll the page
     and resume when the operator has solved it.
   - logged-in → `logged-in`; else → `failed`.

## PHASE 0 — validate the core mechanism LIVE before building the full flow
Two facts can only be confirmed on the live brain profile, not in a unit test:
- **(A)** Chrome auto-sign-in actually autofills the login form on load.
- **(B)** a CDP trusted click COMMITS that autofilled credential on submit.
A minimal live probe against ONE real site (saved credential + expired session)
confirms (A)+(B). **If either fails, PIVOT to the extension's own-store approach**
(credential lives in the extension, not Chrome). Do not ship the full feature until
(A)+(B) hold on the brain profile.

## Files (proposed)
- `src/spine/login.mjs` — the limb: the flow above, with the CDP + bridge as
  injected seams so it is unit-testable without a live browser.
- wire into `boot.mjs` like the other limbs; it drives the brain-profile CDP handle.
- `src/spine/commands.mjs` — `/login <site>` (isCommand-gated) → `requestLogin`.
- config `login: { otp_sources: [gmail, google_voice], captcha_channel: <admin_channel>,
  autofill_wait_ms, submit_overrides: {} }`.
- a generic form-detector (the injected JS), one module/string.
- tests: unit-test the limb's STATE MACHINE with a mocked CDP + bridge
  (detect → wait → trusted-click → outcome; the 2FA branch; the captcha branch;
  and that no credential/OTP ever appears in an output or a log). The live A/B
  behavior is validated in Phase 0, not unit-tested.

## Caveats (unvarnished)
- **No own-store fallback** (that's the extension's job) → fully dependent on
  Chrome's autofill firing. A site that defeats autofill returns `no-autofill` and
  bounces to the operator.
- **Form-detection drifts** per site → generic first, add `submit_overrides` as needed.
- Chrome "auto sign-in" must be ON for the brain profile.
- No DPAPI, so the S0/S1 profile-decrypt constraint does NOT apply here — the spine
  only drives CDP and reads tabs.
