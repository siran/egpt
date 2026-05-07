// tools/cdp.mjs — shared CDP plumbing for browser-driven brains and tools.
//
// Browser-portable. In Node, the default host getter reads the cdp-token
// from ~/.egpt/cdp-token (or honors $EGPT_CDP_HOST) on every call so the
// token can appear after boot via manual proxy start. In a browser/
// extension bundle the dynamic node: imports below fail to resolve at
// runtime (string-var hide keeps esbuild from trying to bundle them);
// the extension instead calls setCdpHostGetter() at boot to read the
// host from chrome.storage (or whatever it likes).

let _hostGetter = null;

const _isNode = typeof process !== 'undefined' && !!process.versions?.node;
if (_isNode) {
  try {
    // String-variable indirection — esbuild's static analysis treats this
    // as an unknown specifier and leaves it alone. At Node runtime the
    // dynamic import succeeds; in browser bundles it throws and we fall
    // back to the no-op default until setCdpHostGetter() is called.
    const fsName   = 'node:fs';
    const pathName = 'node:path';
    const osName   = 'node:os';
    const _fs   = await import(fsName);
    const _path = await import(pathName);
    const _os   = await import(osName);
    _hostGetter = () => {
      if (process.env.EGPT_CDP_HOST) return process.env.EGPT_CDP_HOST;
      const tokenFile = _path.join(_os.homedir(), '.egpt', 'cdp-token');
      if (_fs.existsSync(tokenFile)) {
        const token = _fs.readFileSync(tokenFile, 'utf8').trim();
        return `localhost:9222/${token}`;
      }
      return 'localhost:9222';
    };
  } catch (_) { /* not reachable in Node; in browser we never enter this branch */ }
}

/** Override the default host getter (Node reads disk; browser reads
 *  chrome.storage). The getter may return a string or Promise<string>. */
export function setCdpHostGetter(fn) { _hostGetter = fn; }

/** Resolve the CDP host on every call. Always async to accommodate
 *  storage-backed getters; synchronous getters resolve immediately. */
export async function cdpHost() {
  return _hostGetter ? await _hostGetter() : 'localhost:9222';
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

/**
 * Open a new tab, navigate to url, wait for the page text to settle, return
 * { targetId, title, url, text }. Does NOT close the tab — caller decides.
 */
export async function browseTab(url, { maxChars = 60000, timeoutMs = 30000, onProgress } = {}) {
  const targetId = await openTab(url);

  // Wait for the tab to show up in /json (usually < 300ms)
  let tab = null;
  const deadline = Date.now() + 6000;
  while (!tab && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 150));
    const tabs = await listTabs();
    tab = tabs.find(t => t.id === targetId);
  }
  if (!tab) throw new Error('Newly opened tab did not appear in Chrome tab list');

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    let msgId = 0;
    const pending = new Map();
    let pollHandle = null;
    let settled = false;

    const cleanup = () => {
      if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
      try { ws.close(); } catch {}
    };
    const fail = (err) => { if (!settled) { settled = true; cleanup(); reject(err); } };
    const done = (v)   => { if (!settled) { settled = true; cleanup(); resolve(v); } };

    const cdpSend = (method, params = {}) => {
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
    ws.addEventListener('error', () => fail(new Error('CDP WebSocket error during browse')));

    // Prefer semantic content areas; fall back to body.
    const SNAPSHOT = `(() => {
      const ready = document.readyState;
      const title = document.title ?? '';
      const href = location.href;
      const el = document.querySelector(
        'main, article, [role="main"], #main-content, #content, .main-content'
      ) || document.body;
      if (!el) return { ready, len: 0, title, href, text: '' };
      const text = el.innerText ?? '';
      return { ready, len: text.length, title, href, text: text.slice(0, ${maxChars}) };
    })()`;

    ws.addEventListener('open', async () => {
      let stableTicks = 0, lastLen = -1;
      const startMs = Date.now();
      try {
        pollHandle = setInterval(async () => {
          try {
            const r = await cdpSend('Runtime.evaluate', { expression: SNAPSHOT, returnByValue: true });
            const v = r?.result?.value;
            if (!v) return;
            onProgress?.(v.href, v.len, v.ready);
            if (v.len !== lastLen) { stableTicks = 0; lastLen = v.len; }
            else if (v.ready === 'complete') stableTicks++;
            if (v.ready === 'complete' && stableTicks >= 6 && v.len > 0) {
              done({ targetId, title: v.title, url: v.href, text: v.text });
            } else if (Date.now() - startMs >= timeoutMs) {
              if (v.len > 0) done({ targetId, title: v.title, url: v.href, text: v.text });
              else fail(new Error(`browse: timed out waiting for page (${url})`));
            }
          } catch { /* tab still loading, ignore transient errors */ }
        }, 250);
      } catch (e) { fail(e); }
    });
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
