// ear-probe.mjs — THE DEAF-BRIDGE DETECTOR (operator 2026-07-07; redesigned by the
// operator 2026-07-26: "a deaf-bridge detection (beeper) could be done using telegram api
// and self sending a message to spine").
//
// WHY IT EXISTS — a MEASURED outage, 2026-07-07: the Beeper limb was DEAF for ~8.5 HOURS.
// The process was alive, the spine tick was beating, the WebSocket reported "open", the
// machine was confirmed not asleep — and ZERO inbound arrived on real traffic, so operator
// commands were silently unheard. Nothing in the system could see it: the daemon's deadman
// (src/daemon-runtime.mjs checkLiveness) only proves the LOOP runs, and the bridge's own
// isAlive() IS that "open" flag — the one thing that stays true through this exact failure.
// So this probe never reads it. A detector built on the liar detects nothing.
//
// A PASSIVE last-inbound-age check was REJECTED by the operator: it false-alarms on a quiet
// night AND a draining backlog masks real deafness (lines scroll while the ear is broken —
// both happened that day). The check is ACTIVE: put a message into the chat network and
// require it to come back through the bridge.
//
// THE SENDER IS OUT OF BAND. The message is injected with TELEGRAM'S OWN API, not through
// Beeper. That is the whole design: send and receive must not share machinery. A self-echo
// probe (post through Beeper, wait for Beeper to hand it back) drags in own-send semantics —
// wasSentByUs / the sent-id set / the isSender handling that has already caused two separate
// bugs in this codebase's history — and it tests a path no human message takes. An
// independent sender means NOTHING about the probe message is "ours" as far as the bridge is
// concerned: it travels the ORDINARY inbound path, which is precisely the path the outage
// broke and precisely what _wsReady lies about.
//
// NO MARKER IN THE BODY. The correlation is not a sentinel token classifying other people's
// traffic (the shape this codebase has removed twice — see the 👂 coverage history, ROADMAP
// §0). We know the EXACT string we injected, because we injected it: the match is string
// EQUALITY against that one nonce, consulted only while a probe is in flight, and it decides
// nothing about any other message. `normalize` exists solely to undo the transport's known
// lossy encoding (Beeper delivers text as HTML) before that equality — it is not resemblance
// matching and there is no threshold.
//
// IT CANNOT STORM. One probe in flight at a time (a tick that finds one running is dropped,
// not queued) and one tick per `everyMs`, so the outbound is structurally bounded to at most
// one message per window no matter what. NOTE for the operator: this send does NOT pass
// through the node's lasso (src/lasso.mjs) — the lasso regulates what the SPINE emits to its
// limbs, and this leaves via Telegram, below/beside every limb. The bound above is the whole
// bound, which is why the cadence is minutes and the non-overlap rule is structural.
//
// FAIL CLOSED, NEVER FATAL: no token, no chat id, or a non-positive cadence and the probe is
// simply OFF — no boot error, and never a fallback to some other transport. An injection that
// FAILS (Telegram unreachable, bot not in the chat, HTTP error) is INCONCLUSIVE, never
// "deaf": a broken sender must not be able to restart the bridge.

const TELEGRAM_API = 'https://api.telegram.org';

/**
 * The out-of-band injector: ONE Telegram Bot API sendMessage. Nothing here touches Beeper.
 * `apiBase` is injectable so tests point it at a local fake instead of the real API.
 * Throws on a non-2xx — the caller reads a throw as INCONCLUSIVE.
 */
export async function injectViaTelegram({ token, chatId, text, apiBase = TELEGRAM_API, fetchFn = fetch }) {
  const res = await fetchFn(`${apiBase}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) throw new Error(`telegram sendMessage → ${res.status} ${String(await res.text()).slice(0, 160)}`);
  return true;
}

/**
 * @param {object} o
 * @param {(text: string) => Promise<any>} [o.inject]  put `text` into the chat network out of
 *   band (default: none → the probe is OFF). Beeper's limb wires injectViaTelegram here.
 * @param {(why: string) => void} o.restart            what to do when the message never arrives.
 * @param {number} o.everyMs                           cadence; <= 0 = OFF.
 * @param {number} o.timeoutMs                         how long the injected message may take to
 *   come back through the bridge before the ear is called deaf.
 * @param {number} [o.firstMs]                         delay before the FIRST probe — short on
 *   purpose, so every deploy/respawn gets a real end-to-end check within seconds instead of a
 *   full cadence later (the post-deploy smoke, for free).
 * @param {{set:Function, clear:Function}} o.scheduler timer seam (tests drive a fake clock).
 * @param {(s: any) => string} [o.normalize]           undo the transport's lossy encoding before
 *   the equality compare (Beeper delivers HTML).
 * @param {(m: string) => void} [o.onLog]
 * @param {() => number} [o.now]
 */
export function createEarProbe({
  inject = null,
  restart,
  everyMs = 0,
  timeoutMs = 45_000,
  firstMs = 20_000,
  scheduler,
  normalize = (s) => String(s ?? '').trim(),
  onLog = () => {},
  now = () => Date.now(),
} = {}) {
  const enabled = everyMs > 0 && typeof inject === 'function';
  let waiting = null;   // { want, timer } while a probe is in flight
  let tick = null, stopped = false;

  // Every inbound body the bridge delivers, while a probe is in flight. A null check on the
  // hot path when there is none — which is almost always.
  function heard(text) {
    const w = waiting;
    if (!w) return;
    if (normalize(text) !== w.want) return;
    verdict(true);
  }

  function verdict(arrived) {
    const w = waiting;
    if (!w) return;
    waiting = null;
    if (w.timer) { try { scheduler.clear(w.timer); } catch { /* already fired */ } }
    if (arrived) { onLog('ear probe OK — the out-of-band message came back through the bridge'); return; }
    const why = `an out-of-band message injected ${Math.round(timeoutMs / 1000)}s ago never arrived through the bridge`;
    onLog(`EAR DEAF — ${why}`);
    try { restart(why); } catch (e) { onLog(`ear probe: restart threw — ${e?.message ?? e}`); }
  }

  async function run() {
    if (waiting || stopped) return;   // never overlap: a tick during a probe is DROPPED, not queued
    // The nonce IS the correlation key — a string only this probe knows, matched by equality.
    // No dots (a domain-like token gets auto-linkified in transit and would not compare equal).
    const text = `egpt ear check ${now()} ${Math.random().toString(36).slice(2, 8)}`;
    const w = { want: normalize(text), timer: null };
    // The LISTENER is armed before the injection — delivery through Beeper can beat the
    // Telegram HTTP response — but the CLOCK is not. A slow or hanging sender must never be
    // able to run out the arrival window and be scored as deafness; the window measures how
    // long the message takes to come back AFTER Telegram accepted it, nothing else.
    waiting = w;
    try {
      await inject(text);
    } catch (e) {
      if (waiting === w) {
        waiting = null;
        onLog(`ear probe INCONCLUSIVE — the injection failed (${e?.message ?? e}); NOT calling the ear deaf`);
      }
      return;
    }
    if (waiting !== w) return;   // it already arrived (verdict settled), or we were stopped
    w.timer = scheduler.set(() => verdict(false), timeoutMs);
  }

  function arm(delay) {
    if (!enabled || stopped) return;
    tick = scheduler.set(() => {
      run().catch((e) => onLog(`ear probe failed — ${e?.message ?? e}`));
      arm(everyMs);
    }, delay);
  }
  if (enabled) arm(firstMs);

  return {
    enabled,
    heard,
    stop() {
      stopped = true;
      if (tick) { try { scheduler.clear(tick); } catch { /* already fired */ } }
      if (waiting?.timer) { try { scheduler.clear(waiting.timer); } catch { /* already fired */ } }
      waiting = null;
    },
  };
}
