// successor-announce.mjs — THE SESSION 1 SPINE'S ANNOUNCE (chunk 3 of
// plans/2609061200-SESSION-0-TO-1-HANDOVER-PLAN.md).
//
// setup/register-session1-autostart.ps1 starts a spine at LOGON with EGPT_SESSION1=1. That spine
// is the SUCCESSOR: it wants the profile the Session 0 spine is already holding. Both share one
// EGPT_HOME, so exactly one may hold it, and the plan's one unrecoverable failure is both holding
// it at once. This module is how the successor asks — nothing more.
//
// ── WHY THE ANNOUNCE DIALS THE CONSOLE PORT, AND NOT THE INGEST BOX ────────────────────────────
// The obvious implementation is "write /standdown into EGPT_HOME/state/ingest/". Three findings,
// in the order they mattered, say no:
//
//  1. THE SUCCESSOR WATCHES THAT SAME BOX. boot.mjs starts createIngest on the SHARED
//     EGPT_HOME/state/ingest for every real node, successor included, so a token dropped there is
//     read by whichever of the two spines sweeps first. The plan's own hazard table already names
//     this: "state/ingest/ — both consume, one wins the race". Announcing through the box means
//     announcing through the one channel the plan says two live spines cannot share. Losing that
//     race is not a degraded handover — it is the incumbent never hearing, the successor never
//     binding, and two spines on one profile until somebody notices.
//  2. "THE WATCHER BELONGS TO WHOEVER HOLDS THE PORT" IS NOT TRUE TODAY, and making it true is a
//     bigger change than this chunk. Measured in boot.mjs: `if (ingest) shellPort.start();` (:1893)
//     runs BEFORE `if (ingest) { … await ingestWatcher.start(); }` (:1929-1951) and both are gated
//     on the same `ingest` flag — so the two are ORDERED but not CONDITIONED on each other.
//     start() only *begins* the bind: `_listening` is set later, by the 'listening' event, and a
//     failed bind just schedules a re-listen. The watcher starts either way. Gating it on
//     `_listening` would need a new "am I serving yet" callback out of shell-port plus start/stop
//     of the watcher as the port comes and goes — a state machine — and it would take the
//     operator's `/restart` away from a spine whose bind failed, which is exactly the recovery
//     path the deferred stand-down deliberately kept exempt (spine.mjs's standingDown gate).
//  3. A DIAL IS SELF-LIMITING; A FILE IS NOT. No incumbent ⇒ ECONNREFUSED ⇒ nothing was written
//     anywhere ⇒ nothing to clean up and nothing to poison the next boot. A token written into the
//     box when nobody is listening is a live grenade sitting in the profile.
//
// AND IT NEEDS NO NEW WIRE VERB. The incumbent is already serving its console port with the
// nonce/HMAC handshake (src/shell/auth.mjs), and the successor holds the SAME `shell.token`
// because it reads the SAME config — that is what sharing one EGPT_HOME means. So the announce is
// an ORDINARY CONSOLE FRAME carrying an ordinary operator command, `/standdown <port>`: the exact
// bytes the operator's editor sends when they type it. shell-port stamps `authorized: true` on it
// (earned by the handshake, not assumed from loopback), the spine's chokepoint exempts lifecycle
// commands, commands.mjs hands it to lifecycleExit, and boot's announceAndExit(45) runs the
// deferred drain. Not one line of new protocol, and no entry added to shell-port's verb table —
// which is deliberate about what it exposes ("`gone` is NOT a wire verb … no frame can reach it").
// The mouth link's `open`/`opened`/`update`/`finish` were the right precedent for a NEW capability;
// this one already exists.
//
// THE COST, STATED: the console is a SINGLE SEAT, incumbent-holds (shell-port.mjs onConnection).
// If the operator's editor is seated on the incumbent at the instant the successor dials, the dial
// is closed before the challenge and the announce comes back `refused`. At LOGON — the only moment
// this runs — an editor from the previous session died with that session, so the seat is free; but
// it is a real hole and it is reported rather than hidden: `refused` is logged loudly, the
// successor waits on the port (it never evicts, see boot's reap guard), and the operator can type
// `/standdown` in the editor they are already sitting at.
import { WebSocket as WS } from 'ws';
// The handshake, imported, never re-implemented — the same module the editor's client answers with
// and the same one shell-port challenges with.
import { parseAuthFrame, responseFrame } from '../shell/auth.mjs';

// The environment variable setup/session1-logon-launcher.vbs sets. NOT a config key, and it cannot
// be one: both spines read the SAME config file (that is the point of sharing a profile), so the
// successor flag has to travel per-process — see the WHY EGPT_SESSION1=1 block in
// setup/register-session1-autostart.ps1.
export const SESSION1_ENV = 'EGPT_SESSION1';

// TRIMMED, NOT `=== '1'`. Measured on reve 2026-09-06 (dcf302c): `cmd /c set A=1 && …` yields
// "1 " — cmd takes everything between the `=` and the `&&` as the value, trailing space included.
// The shim uses the quoted `set "A=1"` form for exactly that reason, but a spine that trusts an
// exact match is one shell quirk away from silently deciding it is NOT the successor and booting
// as a second spine on a shared profile. Compare defensively; the shim's fix and this one are
// belt and braces on the failure the plan calls unrecoverable.
export function isSession1Successor(env = process.env) {
  return String(env?.[SESSION1_ENV] ?? '').trim() === '1';
}

// One bounded round trip on loopback (peer-mouth.mjs measures dial→open at 8ms and open→challenge
// at 1ms). Bounded rather than open-ended because an incumbent that accepted the TCP connection and
// then went catatonic must not hold the successor's boot forever.
export const ANNOUNCE_TIMEOUT_MS = 5_000;

// AFTER the line is written, hold the socket open this long before calling it delivered. The
// console protocol acknowledges a text frame with nothing at all (it is chat, not RPC), so "the
// incumbent took it" cannot be read off an answer — but a REFUSAL is loud: a wrong shell token
// makes shell-port close the connection the instant it reads the bad MAC, in the same breath. So
// the two are told apart by WHEN the close arrives, and this is the window that separates them.
// It costs a quarter second of a logon and buys the difference between "asked" and "shouted at a
// door that was already shut".
export const ANNOUNCE_GRACE_MS = 250;

// The line on the wire. The port is named EXPLICITLY even though it is this profile's own port and
// the daemon would fall back to it anyway (daemon-runtime.mjs standdownPort): the successor is
// stating which port it will hold, which is the one fact the departing spine's daemon needs, and
// saying it out loud beats relying on a fallback that happens to agree.
export function standdownLine(port) { return `/standdown ${port}`; }

/**
 * Ask whoever holds `port` to stand down, then return. Never throws, never retries, never waits
 * for the incumbent to actually leave — THAT wait is shell-port's own re-listen backoff, which
 * already exists and already does it (boot suppresses the successor's port reap so the bind waits
 * instead of evicting). This function's whole job is to say the one sentence.
 *
 * @returns {Promise<{outcome: string, detail: string}>} outcome ∈
 *   'announced'     the incumbent authenticated us and took the line
 *   'no-incumbent'  nothing is serving that port — an ordinary, quiet startup
 *   'refused'       something is there but closed the dial (the console seat is held, most likely)
 *   'no-token'      this profile configures no shell token, so there is no console and no mutex
 *   'timeout'       it answered the TCP connect and then said nothing
 */
export function announceStanddown({
  port,
  token,
  WebSocket = WS,
  onLog = () => {},
  setTimeout: setTimeoutFn = globalThis.setTimeout,
  clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
  timeoutMs = ANNOUNCE_TIMEOUT_MS,
  graceMs = ANNOUNCE_GRACE_MS,
} = {}) {
  // FAIL LOUD, NOT CLOSED-AND-QUIET. With no shell token neither spine's console limb serves at
  // all (shell-port start()'s fail-closed branch), which means the port is not held by anybody and
  // THE MUTEX DOES NOT EXIST on this node. There is nothing this module can do about that, but a
  // silent return would let the successor come up beside a live incumbent believing it had asked.
  if (!String(token ?? '')) {
    onLog('the successor cannot announce: this profile configures no shell.token, so no spine serves '
      + 'the console port — and the console port IS the mutex on a shared profile. Two spines may now '
      + 'hold this EGPT_HOME at once. Add `shell:` / `  token: <32+ random chars>` to config.yaml.');
    return Promise.resolve({ outcome: 'no-token', detail: 'no shell.token configured' });
  }
  return new Promise((resolve) => {
    let sock = null, settled = false, opened = false, sent = false, timer = null;
    const done = (outcome, detail) => {
      if (settled) return;
      settled = true;
      if (timer != null) { clearTimeoutFn(timer); timer = null; }
      try { sock?.close?.(); } catch { /* closing */ }
      resolve({ outcome, detail });
    };

    try { sock = new WebSocket(`ws://127.0.0.1:${port}`); }
    catch (e) { return done('no-incumbent', `dial threw — ${e?.message ?? e}`); }

    sock.on('open', () => { opened = true; });
    sock.on('message', (buf) => {
      const auth = parseAuthFrame(buf);
      if (!auth || auth.auth !== 'challenge' || !auth.nonce) return;   // pre-auth noise, dropped
      try {
        sock.send(responseFrame(token, auth.nonce));
        // The console frame's minimal shape ({ text }): no chatId, so it lands on the incumbent's
        // own console seat exactly as a bare editor line does. Ordered after the response on the
        // same socket, so it arrives on an already-verified connection — and the socket is not
        // closed here at all, but at the end of the grace window below, by done().
        sock.send(JSON.stringify({ text: standdownLine(port) }));
      } catch (e) { return done('refused', `could not write the announce — ${e?.message ?? e}`); }
      // Written, not yet known-delivered: re-arm the deadline as the GRACE window above. Silence
      // for that long means the incumbent kept the connection, i.e. it accepted both frames.
      sent = true;
      if (timer != null) clearTimeoutFn(timer);
      timer = setTimeoutFn(() => done('announced', `asked the incumbent on 127.0.0.1:${port} to stand down`), graceMs);
      timer?.unref?.();
    });
    // WHEN THE CLOSE ARRIVES IS THE WHOLE SIGNAL. Before we ever saw the challenge, it is the
    // single-seat rule (an editor is at the console) or some other refusal — a stranger is told
    // nothing before it authenticates, so every refusal looks like a silent close from here.
    // Within the grace window AFTER we answered, it is a rejected MAC: this node's shell.token
    // disagrees with the incumbent's, which on a shared profile should be impossible and is worth
    // saying out loud. Never a false 'refused' for a spine that simply left: it drains first.
    sock.on('close', () => done(opened ? 'refused' : 'no-incumbent',
      sent ? 'it closed the moment it read our answer — the shell token this spine holds is not the one the incumbent challenged with'
        : (opened ? 'it closed the dial without challenging — the console seat is most likely held by the operator\'s editor' : 'nothing answered')));
    // ECONNREFUSED before 'open' is the ordinary no-incumbent case, not an error.
    sock.on('error', (e) => done(opened ? 'refused' : 'no-incumbent', `${e?.code ?? ''} ${e?.message ?? e}`.trim()));

    timer = setTimeoutFn(() => done('timeout', `no answer within ${timeoutMs}ms`), timeoutMs);
    timer?.unref?.();
  });
}
