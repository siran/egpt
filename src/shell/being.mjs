// src/shell/being.mjs — THE BEING WIRE: the ONE definition of what a BOXED BEING may say to its
// spine, and of the three environment variables it is handed to say it with. Both ends read this
// file — the spine's console limb (src/bridges/shell-port.mjs) and the being's client
// (src/tools/ask-spine.mjs) — and neither may grow a second copy of the shape. Its one import is
// the dial-path match every role on the port shares (src/shell/mouth.mjs).
//
// WHY IT EXISTS (operator 2026-09-26). The brain Chrome — CDP :9221, config `chrome.profile_dir`,
// the ChatGPT login sealed by DPAPI to the operator's account `an` — died at a reboot, and being E
// could not bring it back. E is BOXED: it runs as a leased pool account (egpt-sbx-NN), so a
// chrome.exe it started itself would run as the wrong user against that profile and come up logged
// out, and /chrome, which launches the right one, is the operator's. The ruling, verbatim: "granting
// a sandbox being to execute any arbitrary command through the spine (operator's account) defeats
// the purpose of the sandbox. so it seems for now only the browser."
//
// SO THE VOCABULARY IS CLOSED AND THE REQUEST CARRIES NOTHING. A being names a thing (`ask`) and
// what to do to it (`action`), and that is the whole frame. There is no executable, no flag, no
// port, no profile and no URL anywhere in it — the spine alone decides what is launched, from its
// own config — and a frame that carries ANY other field is refused, never ignored, so a being that
// tries to hand one over learns on the spot that it cannot (src/spine/being-link.mjs).
//
// `browser` + `start` is step 1 of the operator's 2026-09-22 browser design (a Chrome per
// conversation-group profile, launched by the spine as `an`, reached by beings only THROUGH the
// spine — HANDOFF.2009.disposable.md). The later actions (open/read/close) join THIS channel as
// more (ask, action) pairs; they are not built here.
//
// ROLE IS THE DIAL PATH, exactly as it is for the mouth (src/shell/mouth.mjs): `/being`, read off
// the upgrade request before a byte is exchanged, so a being neither takes nor is refused by the
// operator's single console seat. AUTHENTICATION IS NOT RELAXED: the being answers the SAME nonce
// challenge (src/shell/auth.mjs), keyed not by the node's shell token — handing that to a being
// would hand every boxed being the operator's console — but by a secret the spine minted for that
// one session and revokes when the session closes.
import { dialsPath } from './mouth.mjs';

// The dial path that means "I am a boxed being asking my spine for something".
export const BEING_PATH = '/being';
export function isBeingDial(req) { return dialsPath(req, BEING_PATH); }

// THE THREE VARIABLES the spine hands a boxed session through the launcher's one -SetEnv element
// (src/sandbox-cli-session.mjs). Named here, beside the frames, because the being's client reads
// exactly these names and a spelling that drifted on one side would fail as "not a boxed session".
//   EGPT_SPINE_PORT   the console port to dial on 127.0.0.1 (config shell.port)
//   EGPT_BEING_TOKEN  THIS session's own secret — never the node's shell token
//   EGPT_ASK_SPINE    the client script, so the command a being is told is the same on every node
export const SPINE_PORT_ENV = 'EGPT_SPINE_PORT';
export const BEING_TOKEN_ENV = 'EGPT_BEING_TOKEN';
export const ASK_SPINE_ENV = 'EGPT_ASK_SPINE';

/** THE REQUEST. Two fields, and a frame with any third is refused (module header). */
export function askFrame({ ask, action }) {
  return JSON.stringify({ ask: String(ask ?? ''), action: String(action ?? '') });
}

/**
 * THE ANSWER — always sent, on the socket the request arrived on.
 * @param {object} r
 * @param {boolean} r.ok
 * @param {boolean} [r.launched]        the spine started it on this request
 * @param {boolean} [r.alreadyRunning]  it was already answering; nothing was launched
 * @param {string}  [r.reason]          on refusal/failure: bad-request | unknown | launch-failed
 * @param {string}  [r.detail]          a human line; never parsed
 */
export function askResultFrame({ ok, launched = false, alreadyRunning = false, reason = '', detail = '' }) {
  const f = { ask: 'result', ok: !!ok };
  if (launched) f.launched = true;
  if (alreadyRunning) f.alreadyRunning = true;
  if (reason) f.reason = String(reason);
  if (detail) f.detail = String(detail);
  return JSON.stringify(f);
}

// Is this raw frame a BEING frame? Returns the normalized frame, or null for anything that is not a
// JSON object carrying a string `ask`. `extra` lists the NAMES of any other fields a request
// carried — names only, never their values, because a value a being put there is exactly what must
// not travel any further (src/spine/being-link.mjs refuses the frame and logs these names).
export function parseAskFrame(raw) {
  const s = (typeof raw === 'string') ? raw : (raw?.toString?.() ?? '');
  try {
    const j = JSON.parse(s);
    if (!j || typeof j !== 'object' || Array.isArray(j) || typeof j.ask !== 'string') return null;
    if (j.ask === 'result') {
      return {
        ask: 'result',
        ok: !!j.ok,
        launched: j.launched === true,
        alreadyRunning: j.alreadyRunning === true,
        reason: j.reason ? String(j.reason) : '',
        detail: j.detail ? String(j.detail) : '',
      };
    }
    return {
      ask: j.ask,
      action: typeof j.action === 'string' ? j.action : '',
      extra: Object.keys(j).filter((k) => k !== 'ask' && k !== 'action'),
    };
  } catch { /* not JSON → not a being frame */ }
  return null;
}
