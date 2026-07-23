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

async function fetchJson(path) {
  const host = await cdpHost();
  let res;
  try { res = await fetch(`http://${host}${path}`); }
  catch (e) {
    throw new Error(
      `Cannot reach Chrome at ${host}. ` +
      `Run /chrome inside egpt to launch one with the extension, or start Chrome yourself with --remote-debugging-port=${host.split(':')[1]}.`
    );
  }
  if (!res.ok) throw new Error(`Chrome ${path} returned ${res.status}`);
  return res.json();
}

export async function isRunning() {
  try { await fetchJson('/json/version'); return true; }
  catch { return false; }
}

export async function listTabs(filterRegex = null) {
  const all = await fetchJson('/json');
  return all
    .filter(t => t.type === 'page')
    .filter(t => !filterRegex || filterRegex.test(t.url));
}

export async function closeBrowser() {
  if (!(await isRunning())) throw new Error('Brain is not running');
  const v = await fetchJson('/json/version');
  await new Promise(resolve => {
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    const settle = () => { try { ws.close(); } catch {} ; resolve(); };
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    });
    ws.addEventListener('close', settle);
    ws.addEventListener('error', settle); // browser dying triggers ws error — that's fine
    setTimeout(settle, 3000);
  });
  // wait until /json/version stops answering
  for (let i = 0; i < 10; i++) {
    if (!(await isRunning())) return;
    await new Promise(r => setTimeout(r, 250));
  }
}

export async function findTab(targetId) {
  const tabs = await listTabs();
  return tabs.find(t => t.id === targetId);
}

export async function openTab(url) {
  const v = await fetchJson('/json/version');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    let id = 0;
    const timeout = setTimeout(() => { try { ws.close(); } catch {} ; reject(new Error('Timed out opening tab')); }, 10000);
    ws.addEventListener('open', () => {
      id = 1;
      ws.send(JSON.stringify({ id, method: 'Target.createTarget', params: { url } }));
    });
    ws.addEventListener('message', e => {
      let data;
      try { data = JSON.parse(e.data.toString()); } catch { return; }
      if (data.id === id) {
        clearTimeout(timeout);
        ws.close();
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result.targetId);
      }
    });
    ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('CDP WS error opening tab')); });
  });
}

/** Close a tab by its CDP targetId. */
export async function closeTab(targetId) {
  const v = await fetchJson('/json/version');
  await new Promise(resolve => {
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    const settle = () => { try { ws.close(); } catch {} resolve(); };
    ws.addEventListener('open', () =>
      ws.send(JSON.stringify({ id: 1, method: 'Target.closeTarget', params: { targetId } })));
    ws.addEventListener('message', settle);
    ws.addEventListener('error', settle);
    setTimeout(settle, 2000);
  });
}

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
export async function activateTarget(targetId) {
  if (!targetId) return;
  let v;
  try { v = await fetchJson('/json/version'); } catch { return; }
  // Find the tab's per-page WS so we can issue Page.bringToFront in
  // the same call. The /json list yields webSocketDebuggerUrl on
  // each page entry.
  let pageWs = null;
  try {
    const tabs = await fetchJson('/json');
    pageWs = tabs.find(t => t.id === targetId)?.webSocketDebuggerUrl ?? null;
  } catch {}
  // (1) Target.activateTarget on the BROWSER ws — selects the tab.
  await new Promise(resolve => {
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    const settle = () => { try { ws.close(); } catch {} resolve(); };
    ws.addEventListener('open', () =>
      ws.send(JSON.stringify({ id: 1, method: 'Target.activateTarget', params: { targetId } })));
    ws.addEventListener('message', settle);
    ws.addEventListener('error', settle);
    setTimeout(settle, 1500);
  });
  // (2) Page.bringToFront on the PAGE ws — the additional request
  // that tells Chrome to surface this renderer's window. Skipped
  // silently if we couldn't resolve a page ws.
  if (!pageWs) return;
  await new Promise(resolve => {
    const ws = new WebSocket(pageWs);
    const settle = () => { try { ws.close(); } catch {} resolve(); };
    ws.addEventListener('open', () =>
      ws.send(JSON.stringify({ id: 1, method: 'Page.bringToFront' })));
    ws.addEventListener('message', settle);
    ws.addEventListener('error', settle);
    setTimeout(settle, 1500);
  });
}

/**
 * Run pollScript once against a tab and return the .text it reports.
 * Used by /refresh — pulls the current assistant message text without sending anything.
 */
export async function peekTab(targetId, pollScript) {
  const tab = await findTab(targetId);
  if (!tab) throw new Error(`Tab ${targetId?.slice(0, 8) ?? '?'}… not found`);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    const tmo = setTimeout(() => { try { ws.close(); } catch {} ; reject(new Error('peek timeout')); }, 5000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1, method: 'Runtime.evaluate',
        params: { expression: pollScript, returnByValue: true },
      }));
    });
    ws.addEventListener('message', e => {
      let data;
      try { data = JSON.parse(e.data.toString()); } catch { return; }
      if (data.id === 1) {
        clearTimeout(tmo);
        try { ws.close(); } catch {}
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result?.result?.value?.text ?? '');
      }
    });
    ws.addEventListener('error', () => { clearTimeout(tmo); reject(new Error('CDP error')); });
  });
}

/**
 * Open a CDP session against a tab, inject text + submit, then poll DOM until
 * the streamed reply stabilizes. Brain-specific knowledge is in the two scripts.
 */
export function streamFromTab({
  targetId,
  injectScript,
  pollScript,
  onUpdate,
  timeoutMs = 180000,
}) {
  return new Promise(async (resolve, reject) => {
    let tab;
    try { tab = await findTab(targetId); }
    catch (e) { return reject(e); }
    if (!tab) return reject(new Error(`No tab with targetId "${targetId}" — opened then closed?`));

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    let msgId = 0;
    const pending = new Map();
    let pollHandle = null, timeoutHandle = null;
    let settled = false;

    const cleanup = () => {
      if (pollHandle) clearInterval(pollHandle);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      try { ws.close(); } catch {}
    };
    const fail = err => { if (!settled) { settled = true; cleanup(); reject(err); } };
    const done = text => { if (!settled) { settled = true; cleanup(); resolve(text); } };

    const cdp = (method, params = {}) => {
      const id = ++msgId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((res, rej) => pending.set(id, { res, rej }));
    };

    ws.addEventListener('message', e => {
      let data;
      try { data = JSON.parse(e.data.toString()); } catch { return; }
      if (data.id && pending.has(data.id)) {
        const { res, rej } = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) rej(new Error(data.error.message));
        else res(data.result);
      }
    });
    ws.addEventListener('error', () => fail(new Error('CDP WebSocket error')));

    ws.addEventListener('open', async () => {
      try {
        const initial = await cdp('Runtime.evaluate', { expression: pollScript, returnByValue: true });
        const initialId = initial?.result?.value?.id ?? null;

        const sent = await cdp('Runtime.evaluate', { expression: injectScript, returnByValue: true });
        if (!sent?.result?.value) {
          return fail(new Error('Inject script returned falsy — selectors may not match the current page.'));
        }

        let lastText = '';
        let textStable = 0;
        let noStreamingCount = 0;
        let sawNew = false;
        let pollErrs = 0;
        const pollStartMs = Date.now();
        // Primary: both signals (no-streaming + text-stable) agree for ~1s.
        // This dampens false "done" during latex/code rendering pauses.
        const STABLE_TICKS = 4;
        // Safety net: if text is dead-stable for 5s AND polling has run >= 10s,
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
            if (!v) return;
            if (!sawNew) {
              if (v.id && v.id !== initialId) sawNew = true;
              else return;
            }
            if (v.text !== lastText) {
              lastText = v.text;
              onUpdate(lastText);
              textStable = 0;
            } else if (lastText) {
              textStable++;
            }
            if (!v.streaming) noStreamingCount++;
            else noStreamingCount = 0;
            if (noStreamingCount >= STABLE_TICKS && textStable >= STABLE_TICKS && lastText) {
              done(lastText);
              return;
            }
            // Fallback: text dead-stable for a long time despite the
            // streaming flag. Likely the stop-button selector is misbehaving.
            if (textStable >= TEXT_STALE_FALLBACK_TICKS &&
                lastText &&
                (Date.now() - pollStartMs) >= MIN_POLL_MS) {
              done(lastText);
            }
          } catch {
            pollErrs++;
            if (pollErrs > 5) fail(new Error('Repeated poll failures'));
          }
        }, 250);

        timeoutHandle = setTimeout(() => {
          if (lastText) done(lastText);
          else fail(new Error(`Timed out waiting for response (${timeoutMs}ms)`));
        }, timeoutMs);
      } catch (e) {
        fail(e);
      }
    });
  });
}
