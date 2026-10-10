// tools/cdp.mjs — shared CDP plumbing for browser-driven brains and tools.
//
// Default target is Chrome's own remote-debugging port localhost:9221.
// That port is bound to 127.0.0.1 by Chromium itself (not a flag — a
// hardwired safety in the C++) so it's only reachable by processes
// on the same machine. We trust same-machine processes; no token,
// no proxy, no TLS needed. Cross-host coordination would re-introduce
// the proxy + tokens + TLS, but that's a future axis we're not on.
//
// Browser-portable: in Node the default getter returns localhost:9221
// (override via $EGPT_CDP_HOST); the extension overrides at boot via
// setCdpHostGetter to read its own chrome.storage.
//
// ── TRANSPORT vs OPS (chunk 3a) ──────────────────────────────────────
// The high-level ops (listTabs/openTab/evaluate/streamFromTab/…) are the
// SAME CDP methods regardless of how bytes reach Chrome. What differs is
// the TRANSPORT. Two live here:
//   • the WS-over-port transport (createPortTransport) — HTTP /json/* for
//     discovery + one WebSocket per endpoint, to localhost:9221. THE DEFAULT;
//     every existing caller keeps this path byte-for-byte.
//   • the pipe transport (createPipeTransport) — \0-delimited JSON over the
//     two inherited fds (3 client→Chrome, 4 Chrome→client) of a Chrome
//     launched with --remote-debugging-pipe; NO port, NO HTTP. Target
//     discovery/addressing via the Target domain (flat protocol, sessionId).
// createCdpClient(transport) binds the ops to a chosen transport. The
// module-level exports are a default client over the port transport, so
// nothing downstream changes. Chunk 3b hands createPipeTransport the two fd
// streams and routes a dedicated Chrome's client to it.

let _hostGetter = null;

const _isNode = typeof process !== 'undefined' && !!process.versions?.node;
if (_isNode) {
  _hostGetter = () => process.env.EGPT_CDP_HOST || 'localhost:9221';
}

/** Override the default host getter (Node uses env var; browser reads
 *  chrome.storage). The getter may return a string or Promise<string>. */
export function setCdpHostGetter(fn) { _hostGetter = fn; }

/** Resolve the CDP host on every call. Always async to accommodate
 *  storage-backed getters; synchronous getters resolve immediately. */
export async function cdpHost() {
  return _hostGetter ? await _hostGetter() : 'localhost:9221';
}

// Deadline for a CDP HTTP probe. These are loopback calls to Chrome's own
// debugging port — a live Chrome answers /json in single-digit ms, so 3s is
// generous slack for scheduler jitter while still short enough that a hung
// chat command fails fast instead of blocking forever. Without this, a dead
// Chrome whose port is still LISTENING (held open by the zombie PID) accepts
// the TCP connect and then never answers — a bare `fetch` with no deadline
// waits on that forever (Node's fetch has no default timeout).
const FETCH_TIMEOUT_MS = 3000;

async function fetchJson(path) {
  const host = await cdpHost();
  // A manual AbortController (rather than AbortSignal.timeout) so the deadline
  // is driven by setTimeout — fake-timer friendly for tests, and the aborted
  // flag tells us plainly whether OUR deadline fired vs. some other fetch failure.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let res;
  try { res = await fetch(`http://${host}${path}`, { signal: ac.signal }); }
  catch (e) {
    // A timeout means the port ANSWERED THE CONNECT but never answered the
    // request — a zombie (Chrome died, OS hasn't freed the port yet). That's
    // a different remedy than an unreachable port (nothing listening), so it
    // gets its own message rather than the misleading "cannot reach".
    if (ac.signal.aborted) {
      throw new Error(
        `Chrome at ${host} accepted the connection but didn't answer within ${FETCH_TIMEOUT_MS}ms — ` +
        `likely a zombie Chrome (process died, port still held). Close it and run /chrome to relaunch.`
      );
    }
    throw new Error(
      `Cannot reach Chrome at ${host}. ` +
      `Run /chrome inside egpt to launch one with the extension, or start Chrome yourself with --remote-debugging-port=${host.split(':')[1]}.`
    );
  }
  finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`Chrome ${path} returned ${res.status}`);
  return res.json();
}

// ── small shared helpers ─────────────────────────────────────────────
const delay = (ms) => new Promise(r => setTimeout(r, ms));

/** Race a promise against a deadline, rejecting with `message` if it wins. */
function withDeadline(promise, ms, message = 'CDP timeout') {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// ── TRANSPORT: WS-over-port (the default) ─────────────────────────────
//
// A "session" is the uniform handle the ops drive, whatever the transport:
//   send(method, params) → Promise<result>   (rejects on a CDP error)
//   onEvent(cb)   — cb(method, params) for unsolicited protocol events
//   onClose(cb)   — cb(err) when the underlying channel drops (fires at most once)
//   close()       — release this session
// In port mode a browser-level session is a WebSocket to /json/version's
// webSocketDebuggerUrl; a target session is a WebSocket to the tab's own
// webSocketDebuggerUrl. Each is its own socket, correlated by the integer id.

/** Open a WebSocket, wire id-correlation + events, resolve a session handle
 *  once the socket is open. Mirrors the per-socket machinery the ops used
 *  inline before — byte-for-byte the same behavior on the port path. */
function openWsSession(url) {
  const ws = new WebSocket(url);
  let msgId = 0;
  const pending = new Map();
  let eventCb = null;
  let closeCb = null;
  let closed = false;
  let closeErr = null;
  const drop = (err) => {
    if (closed) return;
    closed = true; closeErr = err;
    for (const { rej } of pending.values()) rej(err);
    pending.clear();
    if (closeCb) closeCb(err);
  };
  ws.addEventListener('message', e => {
    let data;
    try { data = JSON.parse(e.data.toString()); } catch { return; }
    if (data.id && pending.has(data.id)) {
      const { res, rej } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) rej(new Error(data.error.message)); else res(data.result);
    } else if (data.method && eventCb) {
      eventCb(data.method, data.params);
    }
  });
  ws.addEventListener('error', () => drop(new Error('CDP WebSocket error')));
  const handle = {
    send(method, params = {}) {
      const id = ++msgId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((res, rej) => pending.set(id, { res, rej }));
    },
    onEvent(cb) { eventCb = cb; },
    onClose(cb) { if (closed) cb(closeErr); else closeCb = cb; },
    close() { try { ws.close(); } catch {} },
  };
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(handle));
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket error')));
  });
}

/** The default transport: Chrome's own remote-debugging port. HTTP /json/*
 *  for discovery, a fresh WebSocket per session. Stateless — it resolves the
 *  host live on each call, so setCdpHostGetter keeps steering it at runtime. */
export function createPortTransport() {
  return {
    isRunning: async () => {
      try { await fetchJson('/json/version'); return true; } catch { return false; }
    },
    listTargets: async () => fetchJson('/json'),
    openBrowserSession: async () => {
      const v = await fetchJson('/json/version');
      return openWsSession(v.webSocketDebuggerUrl);
    },
    openTargetSession: async (targetId) => {
      const tab = (await fetchJson('/json'))
        .filter(t => t.type === 'page')
        .find(t => t.id === targetId);
      if (!tab) throw new Error(`No tab with targetId "${targetId}" — opened then closed?`);
      return openWsSession(tab.webSocketDebuggerUrl);
    },
  };
}

// ── TRANSPORT: --remote-debugging-pipe (chunk 3a) ─────────────────────
//
// One persistent connection over the inherited fd pair, modeled on
// Puppeteer's pipe mode. Framing: each CDP message is ASCII JSON followed by
// a single \0 byte. We write command JSON + \0 to fd3 (writable) and split
// the fd4 stream (readable) on \0. No /json HTTP: targets are discovered and
// addressed through the Target domain (flat protocol — Target.attachToTarget
// {flatten:true} yields a sessionId that per-target commands carry). Responses
// correlate by the integer id (one id space for the whole connection);
// unsolicited `method` messages dispatch as events, routed to the owning
// session by sessionId. When fd4 ends (Chrome exits) every in-flight call
// fails cleanly and sessions see onClose — a normal disconnect never throws.
//
// 3b hands this { writable, readable } = child.stdio[3], child.stdio[4] of a
// Chrome it direct-spawned with stdio ['inherit','inherit','inherit','pipe','pipe'].
export function createPipeTransport({ writable, readable }) {
  let nextId = 0;
  const pending = new Map();          // id → { resolve, reject }
  const sessions = new Map();         // sessionId → target-session internals
  const browserCloseCbs = new Set();  // browser-session onClose callbacks
  const browserEventCbs = new Set();  // browser-scope event callbacks
  let closed = false;
  let closeErr = null;
  let buf = Buffer.alloc(0);

  const failAll = (err) => {
    if (closed) return;
    closed = true; closeErr = err;
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
    for (const s of sessions.values()) s.drop(err);
    for (const cb of browserCloseCbs) cb(err);
  };

  const dispatch = (msg) => {
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      return;
    }
    if (msg.method) {
      if (msg.sessionId && sessions.has(msg.sessionId)) sessions.get(msg.sessionId).emit(msg.method, msg.params);
      else for (const cb of browserEventCbs) cb(msg.method, msg.params);
    }
  };

  readable.on('data', (chunk) => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let i;
    while ((i = buf.indexOf(0)) !== -1) {
      const frame = buf.subarray(0, i);
      buf = buf.subarray(i + 1);
      if (frame.length === 0) continue;
      let msg;
      try { msg = JSON.parse(frame.toString('utf8')); } catch { continue; }
      dispatch(msg);
    }
  });
  readable.on('end', () => failAll(new Error('CDP pipe closed (Chrome exited)')));
  readable.on('close', () => failAll(new Error('CDP pipe closed (Chrome exited)')));
  readable.on('error', (e) => failAll(new Error(`CDP pipe error: ${e?.message ?? e}`)));

  const rawSend = (message) => {
    if (closed) return Promise.reject(closeErr ?? new Error('CDP pipe closed'));
    const id = ++nextId;
    // Register the pending handler BEFORE writing: a response can arrive before
    // write() returns (an in-memory peer answers synchronously; a real fd pipe
    // is async but this ordering is correct either way).
    const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    writable.write(JSON.stringify({ ...message, id }) + '\0');
    return p;
  };

  return {
    // The connection is live until fd4 ends; no round-trip needed to know it.
    isRunning: async () => !closed,
    listTargets: async () => {
      const r = await rawSend({ method: 'Target.getTargets' });
      // Shape-match the port path's /json entries so the ops stay transport-agnostic.
      return (r?.targetInfos ?? []).map(t => ({ id: t.targetId, type: t.type, url: t.url, title: t.title }));
    },
    openBrowserSession: async () => {
      let eventCb = null;
      let closeCb = null;
      const browserCb = (err) => { if (closeCb) closeCb(err); };
      return {
        send: (method, params = {}) => rawSend({ method, params }),
        onEvent(cb) { if (eventCb) browserEventCbs.delete(eventCb); eventCb = cb; browserEventCbs.add(cb); },
        onClose(cb) { if (closed) { cb(closeErr); return; } closeCb = cb; browserCloseCbs.add(browserCb); },
        close() { if (eventCb) browserEventCbs.delete(eventCb); browserCloseCbs.delete(browserCb); },
      };
    },
    openTargetSession: async (targetId) => {
      const r = await rawSend({ method: 'Target.attachToTarget', params: { targetId, flatten: true } });
      const sessionId = r.sessionId;
      let eventCb = null;
      let closeCb = null;
      const internals = {
        emit: (m, p) => { if (eventCb) eventCb(m, p); },
        drop: (err) => { if (closeCb) closeCb(err); },
      };
      sessions.set(sessionId, internals);
      return {
        send: (method, params = {}) => rawSend({ sessionId, method, params }),
        onEvent(cb) { eventCb = cb; },
        onClose(cb) { if (closed) cb(closeErr); else closeCb = cb; },
        close() {
          sessions.delete(sessionId);
          if (!closed) rawSend({ method: 'Target.detachFromTarget', params: { sessionId } }).catch(() => {});
        },
      };
    },
  };
}

// ── OPS: transport-agnostic CDP methods ───────────────────────────────

/**
 * Open a per-target session, run `fn(send)` where `send(method, params)` returns a
 * Promise of that command's result, then close. The one-shot helpers below are built
 * on it; `fn` may issue several commands on the one session (a trusted click is three
 * Input events in a row) before it resolves. Transport-agnostic: the session is a
 * per-tab WebSocket on the port path, an attached Target session on the pipe path.
 */
async function withTabSession(transport, targetId, fn, timeoutMs = 5000) {
  const session = await transport.openTargetSession(targetId);
  return new Promise((resolve, reject) => {
    let settled = false;
    const tmo = setTimeout(() => finish(reject, new Error('CDP session timeout')), timeoutMs);
    function finish(cb, arg) { if (settled) return; settled = true; clearTimeout(tmo); session.close(); cb(arg); }
    session.onClose(() => finish(reject, new Error('CDP WebSocket error')));
    (async () => {
      try { const out = await fn(session.send); finish(resolve, out); }
      catch (err) { finish(reject, err); }
    })();
  });
}

/**
 * Open a CDP session against a tab, inject text + submit, then poll DOM until
 * the streamed reply stabilizes. Brain-specific knowledge is in the two scripts.
 * The connection comes from the transport (a per-tab WS on a port, an attached
 * Target session over a pipe); the stabilization logic below is unchanged.
 */
function _streamFromTab(transport, {
  targetId,
  injectScript,
  pollScript,
  onUpdate,
  timeoutMs = 180000,
  // A reply visibly under way - its message is on the page - is waited for, timeoutMs at a time,
  // up to this cap instead of ending at timeoutMs: a model still reasoning with no text yet (kg,
  // 2026-09-24: a reasoning phase can outlast timeoutMs), or one still writing - a long answer
  // used to be cut at timeoutMs with whatever it had so far. A send that never produced a message
  // still fails at timeoutMs, exactly as before. At the cap, text so far is kept and logged.
  reasoningCapMs = 900000,
  // THE FALLBACKS WHEN A PAGE REPORTS A "FINISHED" MARKER (`copyShown`, chatgpt-cdp) BUT THE
  // REPLY NEVER SHOWS IT - a page whose markup moved on. Minutes, not seconds (operator
  // 2026-09-25: "just make sure no text is lost on replies"): ChatGPT pauses mid-answer to
  // search the web or run code for tens of seconds with half its reply written, and the 5s rule
  // these replace ended the capture right there. Quiet = no text change and nothing streaming;
  // stuck = no text change while the stop signal still shows (a selector that overmatches).
  quietFallbackMs = 120000,
  stuckFallbackMs = 300000,
  // (replyId) => a page expression resolving { text } with the reply's SOURCE - the adapter's
  // own copy action (chatgpt-cdp.mjs copyScript). Run once, when the reply is done; without it,
  // or when it cannot give the source, the rendered text the poll read is the reply.
  copyScript = null,
  onLog = () => {},
}) {
  return new Promise((resolve, reject) => {
    let session = null;
    let pollHandle = null, timeoutHandle = null;
    let settled = false;

    const cleanup = () => {
      if (pollHandle) clearInterval(pollHandle);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      try { session?.close(); } catch {}
    };
    const fail = err => { if (!settled) { settled = true; cleanup(); reject(err); } };
    const done = text => { if (!settled) { settled = true; cleanup(); resolve(text); } };

    (async () => {
      try { session = await transport.openTargetSession(targetId); }
      catch (e) { return reject(e); }
      session.onClose(() => fail(new Error('CDP WebSocket error')));
      const cdp = (method, params = {}) => session.send(method, params);

      try {
        const initial = await cdp('Runtime.evaluate', { expression: pollScript, returnByValue: true });
        const initialId = initial?.result?.value?.id ?? null;
        // EVERY message already on the page before the send is NOT the reply (kg, 2026-09-25,
        // room tpoef): once one new id had been seen, whatever was last used to be read, and a
        // moment in which the previous answer was last again made it the reply. A poll that
        // reports all ids (`ids`) names them all; one that does not still names its last.
        const before = new Set([...(initial?.result?.value?.ids ?? []), ...(initialId ? [initialId] : [])]);

        const sent = await cdp('Runtime.evaluate', { expression: injectScript, returnByValue: true });
        if (!sent?.result?.value) {
          return fail(new Error('Inject script returned falsy — the composer was not found, or the tab is still answering (its Stop control is showing), so nothing was sent.'));
        }

        let lastText = '';
        let lastChangeAt = Date.now();
        let textStable = 0;
        let noStreamingCount = 0;
        let sawNew = false;
        let replyId = null;
        let pollErrs = 0;
        let finishing = false;
        const pollStartMs = Date.now();
        // DONE, VERBATIM WHEN IT CAN BE (operator 2026-09-25: "you should copy back verbatim").
        // The poll reads the page's rendering; the adapter's copyScript reads the reply's source
        // through its own copy action. Polling stops first so no tick lands mid-copy; anything
        // short of a source - no copy script, no button, nothing written, ~2s gone - keeps the
        // rendered text and says why in the log.
        const finish = async (rendered) => {
          if (finishing || settled) return;
          finishing = true;
          if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
          let text = rendered;
          if (typeof copyScript === 'function' && replyId) {
            try {
              const r = await Promise.race([
                cdp('Runtime.evaluate', { expression: copyScript(replyId), awaitPromise: true, returnByValue: true, userGesture: true }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('no answer within 2.5s')), 2500)),
              ]);
              const v = r?.result?.value;
              if (typeof v?.text === 'string' && v.text.trim()) text = v.text;
              else onLog(`reply ${replyId}: not verbatim, kept the rendered text - ${v?.error ?? 'the copy gave nothing'}`);
            } catch (e) {
              onLog(`reply ${replyId}: not verbatim, kept the rendered text - ${e?.message ?? e}`);
            }
          }
          done(text);
        };
        // Text held ~1s: the guard on a page's finished marker, and - on a page with NO such
        // marker (claude-cdp) - the primary rule with no-streaming, both signals agreeing for ~1s.
        // This dampens false "done" during latex/code rendering pauses.
        const STABLE_TICKS = 4;
        // Safety net (a page with no finished marker only): if text is dead-stable for 5s AND polling has run >= 10s,
        // finalize even if the stop-button selector is broken (e.g. a locale we
        // don't recognize, or a selector that overmatches and stays "true"
        // forever). Without this, a misconfigured selector means infinite hang.
        const TEXT_STALE_FALLBACK_TICKS = 20; // 5s at 250ms/tick
        const MIN_POLL_MS = 10000;

        pollHandle = setInterval(async () => {
          try {
            const r = await cdp('Runtime.evaluate', { expression: pollScript, returnByValue: true });
            pollErrs = 0;
            const v = r?.result?.value;
            if (!v || finishing) return;
            // Only a message that was NOT on the page before the send can be the reply. A tick
            // whose last message is one of those - or has no id yet - says nothing about the
            // reply, so it moves no text and no counter. The newest new message is the reply:
            // a reasoning block and then its answer, as two new messages, ends on the answer.
            if (!v.id || before.has(v.id)) return;
            sawNew = true;
            replyId = v.id;
            if (v.text !== lastText) {
              lastText = v.text;
              lastChangeAt = Date.now();
              onUpdate(lastText);
              textStable = 0;
            } else if (lastText) {
              textStable++;
            }
            if (!v.streaming) noStreamingCount++;
            else noStreamingCount = 0;
            // THE REPLY'S OWN "FINISHED" MARKER, when the page reports one (chatgpt-cdp
            // `copyShown`): done when its turn shows it and the text has held ~1s - a guard for a
            // marker that shows a moment before the last words land. A pause, quiet text or the
            // stop button end nothing here; a page that never shows the marker ends on the
            // minute-scale fallbacks, and the log says so.
            if ('copyShown' in v) {
              if (v.copyShown && textStable >= STABLE_TICKS && lastText) { finish(lastText); return; }
              const still = Date.now() - lastChangeAt;
              if (lastText && !v.streaming && still >= quietFallbackMs) {
                onLog(`reply ${replyId}: done without its finished marker - no change and nothing streaming for ${Math.round(still / 1000)}s`);
                finish(lastText);
              } else if (lastText && still >= stuckFallbackMs) {
                onLog(`reply ${replyId}: done without its finished marker - no change for ${Math.round(still / 1000)}s while the stop signal still showed`);
                finish(lastText);
              }
              return;
            }
            // A page with no such marker (claude-cdp): the two signals it has, as before.
            if (noStreamingCount >= STABLE_TICKS && textStable >= STABLE_TICKS && lastText) {
              finish(lastText);
              return;
            }
            // Fallback: text dead-stable for a long time despite the
            // streaming flag. Likely the stop-button selector is misbehaving.
            if (textStable >= TEXT_STALE_FALLBACK_TICKS &&
                lastText &&
                (Date.now() - pollStartMs) >= MIN_POLL_MS) {
              finish(lastText);
            }
          } catch {
            pollErrs++;
            if (pollErrs > 5) fail(new Error('Repeated poll failures'));
          }
        }, 250);

        const onTimeout = () => {
          if (finishing || settled) return;
          const left = reasoningCapMs - (Date.now() - pollStartMs);
          if (sawNew && left > 0) { timeoutHandle = setTimeout(onTimeout, Math.min(timeoutMs, left)); return; }
          if (lastText) {
            onLog(`reply ${replyId}: not finished after ${Math.round((Date.now() - pollStartMs) / 1000)}s - kept the text so far, which may be incomplete`);
            return finish(lastText);
          }
          fail(new Error(sawNew
            ? `Timed out waiting for response: the reply was still reasoning after ${Math.round((Date.now() - pollStartMs) / 1000)}s`
            : `Timed out waiting for response (${timeoutMs}ms)`));
        };
        timeoutHandle = setTimeout(onTimeout, timeoutMs);
      } catch (e) {
        fail(e);
      }
    })();
  });
}

/**
 * Bind the CDP ops to a transport. The returned object exposes the same ops
 * the module has always exported; each is a CDP method sequence that reads the
 * same whether the bytes ride a port WebSocket or a pipe. 3b/3c build one of
 * these per dedicated Chrome over a pipe transport.
 */
export function createCdpClient(transport) {
  const client = {
    isRunning: () => transport.isRunning(),

    listTabs: async (filterRegex = null) => {
      const all = await transport.listTargets();
      return all
        .filter(t => t.type === 'page')
        .filter(t => !filterRegex || filterRegex.test(t.url));
    },

    findTab: async (targetId) => {
      const tabs = await client.listTabs();
      return tabs.find(t => t.id === targetId);
    },

    openTab: async (url) => {
      const s = await transport.openBrowserSession();
      try {
        const r = await withDeadline(s.send('Target.createTarget', { url }), 10000, 'Timed out opening tab');
        return r.targetId;
      } finally { s.close(); }
    },

    /** Close a tab by its CDP targetId. Best-effort. */
    closeTab: async (targetId) => {
      const s = await transport.openBrowserSession();
      try { await withDeadline(s.send('Target.closeTarget', { targetId }), 2000); } catch {} finally { s.close(); }
    },

    closeBrowser: async () => {
      if (!(await client.isRunning())) throw new Error('Brain is not running');
      const s = await transport.openBrowserSession();
      try { await withDeadline(s.send('Browser.close'), 3000); } catch {} finally { s.close(); }
      // wait until the browser stops answering
      for (let i = 0; i < 10; i++) {
        if (!(await client.isRunning())) return;
        await delay(250);
      }
    },

    /**
     * Activate (focus) a tab via CDP — brings both the tab and its Chrome
     * window to the foreground. Uses TWO CDP calls because Target.
     * activateTarget alone reliably makes the tab the active one within
     * Chrome but doesn't always bring the OS window forward (Windows
     * SetForegroundWindow restrictions, X11 focus stealing prevention).
     * Page.bringToFront is the per-page request to surface the renderer's
     * window; together they're as aggressive as CDP gets.
     *
     * Best-effort: silently returns if Chrome isn't reachable or the
     * target is gone, so callers don't need to catch.
     */
    activateTarget: async (targetId) => {
      if (!targetId) return;
      if (!(await client.isRunning())) return;
      // (1) Target.activateTarget at browser scope — selects the tab.
      try {
        const s = await transport.openBrowserSession();
        try { await withDeadline(s.send('Target.activateTarget', { targetId }), 1500); } catch {} finally { s.close(); }
      } catch {}
      // (2) Page.bringToFront on the target — tells Chrome to surface this
      // renderer's window. Skipped silently if the target can't be attached.
      try {
        const s = await transport.openTargetSession(targetId);
        try { await withDeadline(s.send('Page.bringToFront'), 1500); } catch {} finally { s.close(); }
      } catch {}
    },

    /**
     * Run pollScript once against a tab and return the .text it reports.
     * Used by /refresh — pulls the current assistant message text without sending anything.
     */
    peekTab: (targetId, pollScript) =>
      withTabSession(transport, targetId, async (send) => {
        const r = await send('Runtime.evaluate', { expression: pollScript, returnByValue: true });
        return r?.result?.value?.text ?? '';
      }),

    /**
     * Evaluate `expression` in a tab and return its value by value (the whole value, not just
     * `.text` as peekTab does). `userGesture`/`awaitPromise` are passed through for the cases that
     * need them (a value a page only yields under activation, a promise result).
     */
    evaluate: (targetId, expression, { awaitPromise = false, userGesture = false } = {}) =>
      withTabSession(transport, targetId, async (send) => {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture });
        return r?.result?.value ?? null;
      }),

    /**
     * Dispatch a TRUSTED left click at viewport (x, y): the moved → pressed → released triple over
     * the tab's own session. A CDP Input event carries user activation, which is what lets Chrome
     * commit an autofilled credential on the submit it triggers.
     */
    dispatchClick: (targetId, x, y) =>
      withTabSession(transport, targetId, async (send) => {
        const base = { x, y, button: 'left' };
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, clickCount: 0 });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, clickCount: 1 });
        return true;
      }),

    /**
     * Screenshot a tab, returning base64 PNG `data` (CAPTCHA branch — the operator needs to SEE it).
     * Page.captureScreenshot on the per-tab session; no Page.enable needed for a single capture.
     */
    captureScreenshot: (targetId, { format = 'png' } = {}) =>
      withTabSession(transport, targetId, async (send) => {
        const r = await send('Page.captureScreenshot', { format });
        return r?.data ?? null;
      }),

    streamFromTab: (opts) => _streamFromTab(transport, opts),
  };
  return client;
}

// ── Default client: the WS-over-port transport ────────────────────────
// The module-level named exports delegate to one default client so every
// existing caller (`import * as cdp` / named imports) is unchanged. The port
// transport resolves the host live, so setCdpHostGetter still steers it.
const _default = createCdpClient(createPortTransport());

export const isRunning = (...a) => _default.isRunning(...a);
export const listTabs = (...a) => _default.listTabs(...a);
export const findTab = (...a) => _default.findTab(...a);
export const openTab = (...a) => _default.openTab(...a);
export const closeTab = (...a) => _default.closeTab(...a);
export const closeBrowser = (...a) => _default.closeBrowser(...a);
export const activateTarget = (...a) => _default.activateTarget(...a);
export const peekTab = (...a) => _default.peekTab(...a);
export const evaluate = (...a) => _default.evaluate(...a);
export const dispatchClick = (...a) => _default.dispatchClick(...a);
export const captureScreenshot = (...a) => _default.captureScreenshot(...a);
export const streamFromTab = (...a) => _default.streamFromTab(...a);
