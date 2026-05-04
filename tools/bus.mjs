// tools/bus.mjs — node-side helpers for the egpt CDP control-plane bus.
//
// The bus is one tab in the brain Chrome serving tools/bus.html via the
// proxy. Both surfaces (shell + extension) attach a CDP session and:
//   - read events: listen for Runtime.consoleAPICalled with arg 'egpt-bus'
//   - write events: Runtime.evaluate -> window.bus.post(ev)
//
// Long content (full brain replies, file contents) does NOT travel here.
// The bus carries short control events: attach-request, attach-reply,
// turn-request, turn-reply, agents-probe, agents-reply, node-online, etc.
// Anything bigger stays in conversation.md and Telegram.

import * as cdp from './cdp.mjs';

export const BUS_PATH = '/bus.html';

// The bus log is served unauthenticated by cdp-proxy; the auth boundary
// is at CDP attach (which goes through the token-prefixed WebSocket).
// Strip any token suffix from cdpHost() so both surfaces resolve the
// same canonical URL: http://localhost:9222/bus.html.
export function busUrl() {
  const host = cdp.cdpHost().split('/')[0];
  return `http://${host}${BUS_PATH}`;
}

// Heuristic for spotting the bus tab without depending on exact querystrings.
function isBusUrl(url) {
  if (!url) return false;
  return url.endsWith(BUS_PATH) || url.includes(`${BUS_PATH}?`) || url.includes(`${BUS_PATH}#`);
}

// Find an existing bus tab; open one if none exists. Returns { targetId, url, opened }.
export async function findOrOpenBusTab({ open = true } = {}) {
  const tabs = await cdp.listTabs();
  const found = tabs.find(t => isBusUrl(t.url));
  if (found) return { targetId: found.id, url: found.url, opened: false };
  if (!open) return null;
  const targetId = await cdp.openTab(busUrl());
  return { targetId, url: busUrl(), opened: true };
}

// One-shot Runtime.evaluate against an arbitrary tab. Used to post events.
async function evaluateOnTab(targetId, expression) {
  const tab = await cdp.findTab(targetId);
  if (!tab) throw new Error(`bus tab ${(targetId ?? '?').slice(0, 8)}… not found`);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    const tmo = setTimeout(() => { try { ws.close(); } catch {} ; reject(new Error('bus post timeout')); }, 5000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    ws.addEventListener('message', e => {
      let data;
      try { data = JSON.parse(e.data.toString()); } catch { return; }
      if (data.id === 1) {
        clearTimeout(tmo);
        try { ws.close(); } catch {}
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result?.result?.value);
      }
    });
    ws.addEventListener('error', () => { clearTimeout(tmo); reject(new Error('bus post WS error')); });
  });
}

/** Post a control event to the bus tab. Resolves when the page acknowledges. */
export function postEvent(targetId, event) {
  const safe = JSON.stringify(event ?? {});
  // window.bus is created by bus.html; if the tab hasn't finished loading
  // we fall back to a small retry loop in-page to keep the call resilient.
  const expr = `(function(ev){
    if (window.bus && window.bus.post) return window.bus.post(ev);
    var attempts = 0;
    var iv = setInterval(function(){
      if (window.bus && window.bus.post) { clearInterval(iv); window.bus.post(ev); }
      else if (++attempts > 20) clearInterval(iv);
    }, 100);
    return null;
  })(${safe})`;
  return evaluateOnTab(targetId, expr);
}

/**
 * Subscribe to all events posted to the bus tab. Listens for the page's
 * `console.log('egpt-bus', JSON.stringify(ev))` emissions via CDP's
 * Runtime.consoleAPICalled. Returns { stop } — call stop() to unsubscribe.
 */
export async function subscribeBusEvents(targetId, onEvent) {
  const tab = await cdp.findTab(targetId);
  if (!tab) throw new Error(`bus tab ${(targetId ?? '?').slice(0, 8)}… not found`);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    let nextId = 0;
    let stopped = false;
    let resolved = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { ws.close(); } catch {}
    };

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: ++nextId, method: 'Runtime.enable' }));
    });

    ws.addEventListener('message', e => {
      let data;
      try { data = JSON.parse(e.data.toString()); } catch { return; }
      if (data.id === 1 && !resolved) {
        resolved = true;
        resolve({ stop });
        return;
      }
      if (data.method !== 'Runtime.consoleAPICalled') return;
      const args = data.params?.args ?? [];
      if (args[0]?.value !== 'egpt-bus') return;
      const raw = args[1]?.value;
      if (typeof raw !== 'string') return;
      try { onEvent(JSON.parse(raw)); }
      catch (_) { /* malformed event; ignore */ }
    });

    ws.addEventListener('error', () => {
      if (!resolved) { resolved = true; reject(new Error('bus subscribe WS error')); }
      stop();
    });
    ws.addEventListener('close', () => { stopped = true; });

    // Safety: resolve even if Runtime.enable's reply gets reordered.
    setTimeout(() => {
      if (!resolved) { resolved = true; resolve({ stop }); }
    }, 1500);
  });
}
