// tools/bus.js — bus tab logic, lifted out of bus.html so the file is CSP-
// compliant when loaded as chrome-extension://<id>/bus.html. MV3 extensions
// disallow inline <script> blocks; loading via <script src="bus.js"> works
// because the file is served from the extension's own origin.
//
// Compact, tab-resident message bus. The egpt shell attaches via
// CDP-over-WebSocket through the proxy on :9222, listening for
// `console.log('egpt-bus', …)` events and posting via Runtime.evaluate.
// The egpt extension attaches via the chrome.runtime port hook below —
// same window.bus, different transport — so the two coexist without
// competing for a chrome.debugger session.
//
// Long content (full brain replies, file pastes) does NOT travel here —
// the bus carries only short control events. Long content stays in
// conversation.md and Telegram.

(function () {
  const NODE_TIMEOUT_MS = 60_000;
  const events = [];
  const listeners = new Set();
  const nodes = new Map(); // nodeId -> { lastSeen, role }
  const logEl = document.getElementById('log');
  const nodesEl = document.getElementById('nodes');
  const countEl = document.getElementById('event-count');
  const updatedEl = document.getElementById('updated');

  const pad2 = (n) => String(n).padStart(2, '0');
  function fmtClock(ts) {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }
  function bodyText(ev) {
    const { type, ts, from, to, ...rest } = ev;
    const keys = Object.keys(rest);
    if (!keys.length) return type;
    return type + ' ' + JSON.stringify(rest);
  }
  function render(ev) {
    const row = document.createElement('div');
    row.className = 'row ' + (ev.type ? ev.type.replace(/[^a-z0-9-]/gi, '-') : 'unknown');
    row.innerHTML =
      '<span class="ts"></span>' +
      '<span class="from"></span>' +
      '<span class="to"></span>' +
      '<span class="body"></span>';
    row.children[0].textContent = fmtClock(ev.ts ?? Date.now());
    row.children[1].textContent = ev.from ?? '?';
    row.children[2].textContent = ev.to ? '→ ' + ev.to : '→ *';
    row.children[3].textContent = bodyText(ev);
    logEl.appendChild(row);
    // Keep DOM small — drop oldest beyond 500 rows.
    while (logEl.childElementCount > 500) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function refreshNodes() {
    const now = Date.now();
    const rows = [];
    for (const [id, info] of nodes.entries()) {
      const stale = now - info.lastSeen > NODE_TIMEOUT_MS;
      rows.push(
        `<span class="node-pill ${stale ? 'stale' : ''}" title="last seen ${fmtClock(info.lastSeen)}">` +
        `${info.role || 'node'}: ${id}</span>`
      );
    }
    nodesEl.innerHTML = rows.join('') || '<span class="subtitle">no nodes online</span>';
  }
  function noteNode(ev) {
    if (!ev?.from) return;
    nodes.set(ev.from, { lastSeen: ev.ts ?? Date.now(), role: ev.role ?? nodes.get(ev.from)?.role });
    if (ev.type === 'node-offline') nodes.delete(ev.from);
    refreshNodes();
  }
  setInterval(refreshNodes, 5000);

  window.bus = {
    post(ev) {
      ev = Object.assign({ ts: Date.now() }, ev || {});
      events.push(ev);
      if (events.length > 500) events.shift();
      render(ev);
      noteNode(ev);
      countEl.textContent = events.length;
      updatedEl.textContent = 'last event ' + fmtClock(ev.ts);
      // Subscribers attached via CDP listen for this exact console
      // call and parse the JSON payload.
      try { console.log('egpt-bus', JSON.stringify(ev)); } catch (_) {}
      for (const l of listeners) {
        try { l(ev); } catch (_) {}
      }
      return ev;
    },
    getEvents(since = 0) { return events.filter(e => (e.ts ?? 0) > since); },
    on(handler) { listeners.add(handler); return () => listeners.delete(handler); },
    nodes() { return Array.from(nodes.entries()).map(([id, info]) => ({ id, ...info })); },
  };

  document.getElementById('clear').addEventListener('click', () => {
    events.length = 0;
    logEl.innerHTML = '';
    countEl.textContent = '0';
  });
  document.getElementById('copy').addEventListener('click', () => {
    try { navigator.clipboard.writeText(events.map(e => JSON.stringify(e)).join('\n')); } catch (_) {}
  });

  // Extension hook: when this page is loaded as
  // chrome-extension://<id>/bus.html (the extension hosts its own bus),
  // open a long-lived chrome.runtime port to the extension background.
  // The extension then talks to the bus via the port — no
  // chrome.debugger session, no banner, no conflict with the shell's
  // WS-via-proxy attach. When the page is loaded over http (proxy-served,
  // shell-only setup), chrome.runtime.id is undefined and this whole
  // block is a no-op.
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
    let suppressForward = false;
    let port = null;
    function connect() {
      try { port = chrome.runtime.connect({ name: 'egpt-bus' }); }
      catch (_) { return setTimeout(connect, 1000); }
      port.onMessage.addListener((msg) => {
        if (!msg) return;
        if (msg.type === 'post' && msg.ev) {
          suppressForward = true;
          try { window.bus.post(msg.ev); }
          finally { suppressForward = false; }
        } else if (msg.type === 'replay-request') {
          const past = window.bus.getEvents(msg.since ?? 0);
          try { port.postMessage({ type: 'replay', past }); } catch (_) {}
        }
      });
      port.onDisconnect.addListener(() => {
        port = null;
        // Service worker may have shut down; reconnect on demand.
        // Will succeed once SW is awake again.
        setTimeout(connect, 1000);
      });
    }
    // Forward live bus events to the extension. suppressForward
    // prevents loops when the extension's own posts trickle back.
    window.bus.on((ev) => {
      if (suppressForward) return;
      if (port) {
        try { port.postMessage({ type: 'event', ev }); } catch (_) {}
      }
    });
    connect();
  }
})();
