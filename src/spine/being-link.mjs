// src/spine/being-link.mjs — WHO MAY ASK THE SPINE FOR WHAT: the per-session credentials a boxed
// being is handed, and the ONE request it may make with one (operator 2026-09-26: "for now only the
// browser"). The wire is src/shell/being.mjs; the limb that carries it is src/bridges/shell-port.mjs;
// this module owns every decision in between.
//
// A CREDENTIAL PER SESSION, NEVER THE NODE'S. The console already authenticates with the node's
// shell token, and handing that to a boxed being would hand every boxed being the operator's
// console — `/upgrade` and all (src/shell/auth.mjs header). So the spine mints 32 random bytes
// when it opens a BOXED session (src/sandbox-cli-session.mjs asks, through the handle brainpool
// hands it), registers them against WHO that session is — being, surface, slug — and forgets them
// when the session closes. The warm pool closes a session on every eviction (src/warm-sessions.mjs
// _evict), so a secret lives exactly as long as the process it was handed to, and a background
// process a being left running with that environment is refused from the moment its session goes.
//
// THE SECRET NEVER CROSSES THE WIRE. The being answers the SAME nonce challenge the operator's
// editor answers (auth.mjs's authMac, macMatches — imported, never re-implemented), keyed by its
// own secret, and `identify` below finds which live credential produced the answer. That is one
// HMAC per live boxed session per dial — the warm pool's `max`, single digits — and it means the
// wire carries no session id either, so there is nothing on it to replay or to guess at.
// Loopback is not an authenticator (a pool account dials 127.0.0.1 as freely as anyone): an answer
// no live credential produced is refused, and the limb says so in the log.
//
// ONE REQUEST, NO ARGUMENTS. The table below is the routing table AND the allowlist, the shape
// shell-port's MOUTH_ANSWER already uses: a pair not in it is refused, and a frame carrying ANY
// field besides `ask` and `action` is refused before the table is even consulted — the being
// chooses nothing about what runs as the operator (src/shell/being.mjs header). There is no
// access_level gate, deliberately: a being that can only ask the spine to start the browser the
// spine configures is asking for nothing it could misuse, and every boxed being may.
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { authMac, macMatches } from '../shell/auth.mjs';
import { SPINE_PORT_ENV, BEING_TOKEN_ENV, ASK_SPINE_ENV } from '../shell/being.mjs';

// WHERE THE CLIENT IS, AS A POOL ACCOUNT CAN RUN IT: the copy in the eGPT CHECKOUT (~\src\egpt),
// not the running tree this spine was started from (~\bin\egpt), and the difference is measured,
// not preferred. Both trees carry a standing ReadAndExecute for the pool group
// (setup/provision-sandbox-account.ps1), but Node realpaths a script before it runs it, and that
// walk opens EVERY ancestor directory as an object — which a pool account may do only where it
// holds (X,RA,RC,S). The provisioner grants that chain for ~ and ~\src; it grants nothing on ~\bin
// (setup/SANDBOX.md, "The traverse chain": realpathSync through an ungranted ancestor EPERMs,
// measured as a real pool account 2026-09-13). So `node ~\bin\egpt\...` would die before the
// client's first line, and ~\src\egpt is the tree every pool profile already mounts as `src`.
// The same ~\src\egpt the launcher's $repoRoot and the provisioner's $repoDir name — a third
// spelling of one path, because PowerShell cannot import this one; change all three together.
// The being never types it: it arrives in ASK_SPINE_ENV, so the card names a variable, not a
// directory under the operator's profile (the disclosure the 2026-09-23 mount ruling closed).
export function askSpineClientPath(home = homedir()) {
  return join(home, 'src', 'egpt', 'src', 'tools', 'ask-spine.mjs');
}

// A request value quoted into the log. The being wrote it, so it is bounded and JSON-escaped: a
// newline in it cannot forge a second log line, and a long one cannot flood the file.
const quoted = (v) => JSON.stringify(String(v ?? '').slice(0, 40));

/**
 * @param {object} opts
 * @param {number} opts.port                       the console port the being dials (boot's shellPortFrom(cfg))
 * @param {() => Promise<object>} opts.startBrowser the /chrome launch path, shared (commands.startBrowser) — resolves { ok, launched|alreadyRunning, reason?, detail }
 * @param {string} [opts.clientPath]               the client script handed in ASK_SPINE_ENV (default askSpineClientPath())
 * @param {(m: string) => void} [opts.onLog]       the AUDIT line, one per request
 * @param {typeof nodeRandomBytes} [opts.randomBytes]
 */
export function createBeingLink({ port, startBrowser, clientPath = askSpineClientPath(), onLog = () => {}, randomBytes = nodeRandomBytes } = {}) {
  const live = new Map();   // secret -> { being, surface, slug }

  // THE ROUTING TABLE AND THE ALLOWLIST (module header). One entry today; open/read/close join it.
  const ASKS = { browser: { start: () => startBrowser() } };

  function mint(who) {
    const secret = randomBytes(32).toString('hex');
    live.set(secret, { being: String(who?.being ?? ''), surface: String(who?.surface ?? ''), slug: String(who?.slug ?? '') });
    return {
      // NAME=VALUE entries for the launcher's ONE -SetEnv element. The VALUES are never logged:
      // the launcher logs names only, and nothing here logs at all.
      env: [`${SPINE_PORT_ENV}=${port}`, `${BEING_TOKEN_ENV}=${secret}`, `${ASK_SPINE_ENV}=${clientPath}`],
      revoke() { live.delete(secret); },
    };
  }

  // What one request did, as the audit line says it and the being's client prints it.
  function outcomeOf(r) {
    if (r?.ok) return r.launched ? `launched — ${r.detail ?? ''}` : `already running — ${r.detail ?? ''}`;
    return `${r?.reason ?? 'failed'} — ${r?.detail ?? ''}`;
  }

  return {
    // THE HANDLE brainpool hands a boxed session (baseOpts.beingLink): it can mint for THIS being
    // in THIS room and nothing else — sandbox-cli-session never learns who it is minting for.
    forBeing(who) { return { mint: () => mint(who) }; },

    // Which live credential produced this answer to this nonce — or null. The limb's whole
    // question at the handshake; it never sees a secret.
    identify(mac, nonce) {
      for (const [secret, who] of live) if (macMatches(mac, authMac(secret, nonce))) return who;
      return null;
    },

    // ONE request off an authenticated /being connection. Never throws; every path is audited.
    async ask(who, frame) {
      const tag = `${who?.being || '?'} (${who?.surface || '?'}/${who?.slug || '?'})`;
      const refuse = (reason, detail, what) => {
        onLog(`${tag} asked ${what} → REFUSED (${reason}): ${detail}`);
        return { ok: false, reason, detail };
      };
      if (!frame || frame.ask === 'result') return refuse('bad-request', 'that is not a request frame', 'something unreadable');
      const what = `${quoted(frame.ask)} ${quoted(frame.action)}`;
      // ANY OTHER FIELD IS A REFUSAL, NOT AN OMISSION: a being that tries to pass an executable, a
      // flag or a profile is told it cannot, and the log names the FIELDS it tried — never what it
      // put in them.
      if (frame.extra?.length) {
        return refuse('bad-request', `the spine takes no arguments — it alone decides what runs; this request also carried: ${frame.extra.map((k) => quoted(k)).join(', ')}`, what);
      }
      const run = Object.hasOwn(ASKS, frame.ask) && Object.hasOwn(ASKS[frame.ask], frame.action) ? ASKS[frame.ask][frame.action] : null;
      if (!run) return refuse('unknown', 'the spine serves exactly one request: browser start', what);
      let r;
      try { r = await run(); }
      catch (e) { r = { ok: false, reason: 'launch-failed', detail: String(e?.message ?? e) }; }
      onLog(`${tag} asked ${frame.ask} ${frame.action} → ${outcomeOf(r)}`);
      return r;
    },

    get size() { return live.size; },
  };
}
