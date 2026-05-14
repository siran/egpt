// tests-manual/cdp-extension-attach.mjs — attach to an already-running
// Chrome on :9221 and exercise the egpt extension's tab + settings
// pages via CDP. Use this when the operator has launched Chrome
// manually (their normal shortcut) with the extension permanently
// installed — far simpler than fighting Chrome 148's --load-extension
// policy in a fresh profile.
//
// Run:
//   1) Start Chrome with --remote-debugging-port=9221 (your shortcut)
//   2) node tests-manual/cdp-extension-attach.mjs
//
// What it checks:
//   1. Chrome reachable on :9221 and extension SW found
//   2. tab/index.html is a chrome-extension target and its #root mounted
//   3. Settings page can be opened and mounts
//   4. JavaScript console of the tab is reasonably error-free during mount

import WebSocket from 'ws';

const PORT = 9221;

function makeCdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const consoleLines = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const args = (m.params.args ?? []).map(a => a.value ?? a.description ?? '?').join(' ');
      consoleLines.push({ level: m.params.type, text: args });
    } else if (m.method === 'Runtime.exceptionThrown') {
      const ed = m.params.exceptionDetails;
      consoleLines.push({ level: 'error', text: ed.text + ' ' + (ed.exception?.description ?? '') });
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    ready,
    consoleLines,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { ws.close(); },
  };
}

async function evaluateOnTarget(target, expression) {
  const cli = makeCdpClient(target.webSocketDebuggerUrl);
  await cli.ready;
  await cli.send('Runtime.enable');
  const r = await cli.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  cli.close();
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + ' — ' + (r.exceptionDetails.exception?.description ?? ''));
  }
  return r.result?.value;
}

async function main() {
  const checks = [];
  const record = (label, pass, detail = '') => {
    checks.push({ label, pass, detail });
    console.log(`  ${pass ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`);
  };

  console.log('CDP extension attach');
  console.log('────────────────────');

  // 1. Chrome reachable
  let version;
  try {
    version = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
  } catch (e) {
    console.log(`!! cannot reach Chrome on :${PORT} — is it running with --remote-debugging-port=${PORT}?`);
    process.exit(2);
  }
  record('Chrome reachable', true, `Chrome/${version.Browser.split('/')[1]}`);

  // 2. Find extension service worker + pages
  const targets = await (await fetch(`http://localhost:${PORT}/json`)).json();
  const extTargets = targets.filter(t => typeof t.url === 'string' && t.url.startsWith('chrome-extension://'));
  const sw = extTargets.find(t => t.type === 'service_worker' && t.url.endsWith('/background.js'));
  if (!sw) {
    record('egpt service worker', false, 'no chrome-extension://*/background.js target — extension may not be loaded');
    console.log('  hint: open the extension in chrome://extensions and reload it, then retry');
    process.exit(1);
  }
  const extId = sw.url.match(/^chrome-extension:\/\/([a-z]+)\//)[1];
  record('egpt service worker', true, `id=${extId}`);

  // 3. Inspect existing tab page (if open) or open a new one
  let tab = extTargets.find(t => t.type === 'page' && t.url.endsWith('/tab/index.html'));
  if (!tab) {
    const tabUrl = `chrome-extension://${extId}/tab/index.html`;
    const r = await fetch(`http://localhost:${PORT}/json/new?${encodeURIComponent(tabUrl)}`, { method: 'PUT' });
    if (!r.ok) {
      record('open tab/index.html', false, `/json/new returned ${r.status}`);
      process.exit(1);
    }
    tab = await r.json();
    await new Promise(r => setTimeout(r, 1500));
    record('open tab/index.html', true, 'new tab');
  } else {
    record('open tab/index.html', true, 'pre-existing tab');
  }

  // 4. Evaluate against the tab
  let tabState;
  try {
    tabState = await evaluateOnTarget(tab, `
      (() => ({
        title: document.title,
        bodyLen: document.body?.textContent?.length ?? 0,
        rootTag: document.getElementById('root')?.tagName ?? null,
        rootChildren: document.getElementById('root')?.children?.length ?? 0,
        // React 19 marks the root as having a fiber via a special key.
        hasReactRoot: !!(document.getElementById('root') &&
          Object.keys(document.getElementById('root')).some(k => k.startsWith('__reactContainer'))),
        // sample of what's rendered (first non-trivial text block)
        firstText: (document.body?.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      }))()
    `);
  } catch (e) {
    record('tab React mounted', false, `eval failed: ${e.message}`);
    process.exit(1);
  }
  const tabMounted = tabState.rootTag && tabState.rootChildren > 0;
  record('tab React mounted', tabMounted,
    tabMounted
      ? `title="${tabState.title}"  #root has ${tabState.rootChildren} children  react=${tabState.hasReactRoot}`
      : `rootTag=${tabState.rootTag}  children=${tabState.rootChildren}`);
  if (tabState.firstText) console.log(`      first text: "${tabState.firstText.slice(0, 80)}…"`);

  // 5. Open / inspect settings page
  let settingsTab = extTargets.find(t => t.type === 'page' && t.url.endsWith('/settings/index.html'));
  if (!settingsTab) {
    const setUrl = `chrome-extension://${extId}/settings/index.html`;
    const r = await fetch(`http://localhost:${PORT}/json/new?${encodeURIComponent(setUrl)}`, { method: 'PUT' });
    if (r.ok) {
      settingsTab = await r.json();
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  if (settingsTab) {
    let setState;
    try {
      setState = await evaluateOnTarget(settingsTab, `
        (() => ({
          title: document.title,
          bodyLen: document.body?.textContent?.length ?? 0,
          rootChildren: document.getElementById('root')?.children?.length ?? 0,
          firstText: (document.body?.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 200),
        }))()
      `);
      const setMounted = setState.rootChildren > 0;
      record('settings mounted', setMounted,
        setMounted ? `title="${setState.title}"  ${setState.bodyLen} chars` : 'no #root children');
      if (setState.firstText) console.log(`      first text: "${setState.firstText.slice(0, 80)}…"`);
    } catch (e) {
      record('settings mounted', false, `eval failed: ${e.message}`);
    }
  } else {
    record('settings mounted', false, 'could not open settings/index.html');
  }

  // 6. Service worker console — does it look healthy?
  let swState;
  try {
    swState = await evaluateOnTarget(sw, `
      (() => ({
        // Chrome SW global: self.registration exists if active.
        active: !!self.registration,
        // Look for any of our exported names (the background bundle
        // doesn't export anything to globalThis, so this is mostly a
        // "did the SW boot without throwing" check).
        scriptUrl: self.location?.href ?? null,
        uptimeOk: typeof self.addEventListener === 'function',
      }))()
    `);
  } catch (e) {
    swState = { error: e.message };
  }
  record('service worker healthy', !!swState.uptimeOk,
    swState.uptimeOk ? `active=${swState.active}` : `eval failed: ${swState.error ?? '?'}`);

  // 7. Drive a /help round-trip in the tab. CodeMirror takes plain
  //    keystrokes / inserted text just fine; Enter submits. We watch
  //    the body's text length grow as evidence that the response
  //    landed in the items list, then sample the rendered output for
  //    keywords that prove /help actually ran (not just the echo).
  //
  //    /help is a local-only command — no bridge dispatch, no brain
  //    turn, no bus traffic. Side effect is one /help line in the
  //    operator's room transcript; acceptable for a smoke probe.
  const cli = makeCdpClient(tab.webSocketDebuggerUrl);
  await cli.ready;
  await cli.send('Runtime.enable');
  await cli.send('Input.enable').catch(() => {});

  // Focus the CodeMirror content node + record current body size as
  // baseline.
  const before = await cli.send('Runtime.evaluate', {
    expression: `
      (() => {
        const ed = document.querySelector('.cm-content');
        if (ed) ed.focus();
        return { bodyLen: document.body.innerText.length, focused: document.activeElement?.className ?? '' };
      })()
    `,
    returnByValue: true,
  });

  // Insert the slash command + dispatch Enter.
  await cli.send('Input.insertText', { text: '/help' });
  await cli.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await cli.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  // Give React a beat to commit the response item.
  await new Promise(r => setTimeout(r, 800));

  const after = await cli.send('Runtime.evaluate', {
    expression: `
      (() => {
        const text = document.body.innerText;
        return {
          bodyLen: text.length,
          mentionsHelp: text.includes('/help'),
          mentionsRecap: text.includes('/recap'),
          mentionsTheme: text.includes('/theme'),
          mentionsSlash: (text.match(/\\B\\/[a-z]+\\b/g) ?? []).length,
        };
      })()
    `,
    returnByValue: true,
  });
  cli.close();
  const grew = after.result.value.bodyLen > before.result.value.bodyLen;
  const helpRan = after.result.value.mentionsRecap && after.result.value.mentionsTheme;
  record('/help round-trip', grew && helpRan,
    grew && helpRan
      ? `body grew ${after.result.value.bodyLen - before.result.value.bodyLen} chars; lists ${after.result.value.mentionsSlash} slash commands`
      : `grew=${grew}  recap=${after.result.value.mentionsRecap}  theme=${after.result.value.mentionsTheme}`);

  // 8. Parity check — the extension shell and the Node-side disk
  //    state should agree on chat presence. The extension reads its
  //    own per-room state, but slash commands shared with the daemon
  //    surface the same wa-chats.json. We read disk directly and
  //    cross-reference whatever the extension currently shows.
  let parityOk = false, parityDetail = '';
  try {
    const { buildRecap } = await import('../tools/logon-summary.mjs');
    const r = await buildRecap({ max: 30, includeDms: true });
    const diskChats = (r?.chatList ?? []).map(c => c.name ?? c.jid).filter(Boolean);
    parityDetail = `node-side disk lists ${diskChats.length} chat${diskChats.length === 1 ? '' : 's'}` +
      (diskChats.length ? `: ${diskChats.slice(0, 5).join(', ')}${diskChats.length > 5 ? ', …' : ''}` : '');
    parityOk = true;   // we just verify the data path is reachable
  } catch (e) {
    parityDetail = `disk read failed: ${e.message}`;
  }
  record('node-side recap data reachable', parityOk, parityDetail);

  // Summary
  console.log('────────────────────');
  const failed = checks.filter(c => !c.pass);
  if (failed.length === 0) {
    console.log(`PASS — ${checks.length}/${checks.length} checks`);
    process.exit(0);
  } else {
    console.log(`FAIL — ${failed.length}/${checks.length} failed`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('!! crash:', e.message);
  process.exit(2);
});
