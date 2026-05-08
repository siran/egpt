// extension/src/tools/bus-ext.js — drop-in for tools/bus.mjs in the
// extension context. Same API as the node module; uses chrome.debugger
// + chrome.tabs instead of CDP-over-WebSocket.
//
// Why chrome.debugger instead of raw WebSocket: Chrome rejects WS
// upgrades to /devtools/page/<id> for chrome-extension:// pages
// (privileged, not allowed via --remote-allow-origins=*). Without
// chrome.debugger, the extension would have to fall back to the
// proxy-served http://localhost:9222/bus.html, re-introducing the
// shell dependency. chrome.debugger is the privileged in-process
// API that accepts attach to extension's own pages, so the
// extension can host its bundled bus.html and stand alone.

export const BUS_PATH = '/bus.html';

// The extension hosts its own bus.html (bundled from tools/bus.html
// at build time, exposed via web_accessible_resources). Override
// via chrome.storage.sync.bus_url if you want to point at a remote
// bus tab instead.
async function configuredBusHost() {
  try {
    const got = await chrome.storage.sync.get('bus_url');
    if (typeof got?.bus_url === 'string' && got.bus_url.trim()) return got.bus_url.trim();
  } catch (_) {}
  return chrome.runtime.getURL('bus.html');
}

export async function busUrl() {
  return configuredBusHost();
}

function isBusUrl(url) {
  if (!url) return false;
  return url.endsWith(BUS_PATH) || url.includes(`${BUS_PATH}?`) || url.includes(`${BUS_PATH}#`);
}

export async function findOrOpenBusTab({ open = true } = {}) {
  const tabs = await chrome.tabs.query({});
  const found = tabs.find(t => isBusUrl(t.url));
  if (found) return { targetId: found.id, url: found.url, opened: false };
  if (!open) return null;
  const url = await busUrl();
  const tab = await chrome.tabs.create({ url, active: false });
  return { targetId: tab.id, url, opened: true };
}

const _attached = new Set();
async function ensureAttached(tabId) {
  if (_attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  _attached.add(tabId);
  chrome.debugger.onDetach.addListener(function h(src) {
    if (src.tabId !== tabId) return;
    _attached.delete(tabId);
    chrome.debugger.onDetach.removeListener(h);
  });
}

export async function postEvent(targetId, event) {
  await ensureAttached(targetId);
  const safe = JSON.stringify(event ?? {});
  const expression = `(function(ev){
    if (window.bus && window.bus.post) return window.bus.post(ev);
    var attempts = 0;
    var iv = setInterval(function(){
      if (window.bus && window.bus.post) { clearInterval(iv); window.bus.post(ev); }
      else if (++attempts > 20) clearInterval(iv);
    }, 100);
    return null;
  })(${safe})`;
  await chrome.debugger.sendCommand({ tabId: targetId }, 'Runtime.evaluate', {
    expression, returnByValue: true,
  });
}

export async function subscribeBusEvents(targetId, onEvent) {
  await ensureAttached(targetId);
  await chrome.debugger.sendCommand({ tabId: targetId }, 'Runtime.enable', {});
  // Chrome replays past Runtime.consoleAPICalled events on enable so
  // DevTools can show console history. We don't want that — old bus
  // events would be re-dispatched on every rejoin. Filter by CDP-side
  // timestamp; anything older than subscription time is replay.
  const subscribedAt = Date.now() - 1000;
  const handler = (source, method, params) => {
    if (source.tabId !== targetId) return;
    if (method !== 'Runtime.consoleAPICalled') return;
    const cdpTs = params?.timestamp;
    if (typeof cdpTs === 'number' && cdpTs < subscribedAt) return;
    const args = params?.args ?? [];
    if (args[0]?.value !== 'egpt-bus') return;
    const raw = args[1]?.value;
    if (typeof raw !== 'string') return;
    try { onEvent(JSON.parse(raw)); }
    catch (_) { /* malformed; ignore */ }
  };
  chrome.debugger.onEvent.addListener(handler);
  return {
    stop() {
      try { chrome.debugger.onEvent.removeListener(handler); } catch (_) {}
    },
  };
}
