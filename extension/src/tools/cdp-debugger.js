// extension/src/tools/cdp-debugger.js
//
// Thin RPC client over a 'egpt-brain' chrome.runtime port. The actual
// chrome.debugger.attach + poll loop runs in the service worker
// (background.js — see runStreamInSw / runPeekInSw). Why: when the
// poll loop ran in the egpt UI tab, Chrome's per-tab background
// throttling slowed setInterval to 1Hz when the egpt tab was hidden
// in its window — making brain-reply detection take 4× longer than
// when foregrounded. The service worker is exempt from per-tab
// throttling, so polling proceeds at full speed regardless of which
// tab the user is looking at.
//
// HTTP read-only functions (listTabs, findTab, isRunning, openTab,
// closeTab, browseTab, setCdpHostGetter, cdpHost) still come from
// tools/cdp.mjs since they don't need debugger or WS — just /json
// fetches.

export {
  listTabs, findTab, isRunning,
  openTab, closeTab, browseTab,
  setCdpHostGetter, cdpHost,
} from '../../../src/tools/cdp.mjs';

function rpc(message, { onUpdate } = {}) {
  return new Promise((resolve, reject) => {
    let port;
    try { port = chrome.runtime.connect({ name: 'egpt-brain' }); }
    catch (e) { return reject(new Error(`brain RPC connect: ${e?.message ?? e}`)); }
    let settled = false;
    let lastText = '';
    const finish = (kind, value) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch (_) {}
      if (kind === 'ok') resolve(value);
      else reject(value);
    };
    port.onMessage.addListener((msg) => {
      if (!msg || settled) return;
      if (msg.type === 'update') {
        lastText = msg.text ?? lastText;
        if (onUpdate) { try { onUpdate(lastText); } catch (_) {} }
      } else if (msg.type === 'done') {
        finish('ok', msg.text ?? lastText);
      } else if (msg.type === 'peek-result') {
        finish('ok', msg.text ?? '');
      } else if (msg.type === 'error') {
        finish('err', new Error(msg.error ?? 'brain failed'));
      }
    });
    port.onDisconnect.addListener(() => {
      // SW died mid-call or background closed the port. Resolve with
      // whatever partial text we got, otherwise reject.
      if (settled) return;
      if (lastText) finish('ok', lastText);
      else finish('err', new Error('brain port disconnected before completion'));
    });
    try { port.postMessage(message); }
    catch (e) { finish('err', new Error(`brain RPC post: ${e?.message ?? e}`)); }
  });
}

export async function peekTab(targetId, pollScript) {
  return rpc({ type: 'peek', targetId, pollScript });
}

export function streamFromTab({ targetId, injectScript, pollScript, onUpdate, timeoutMs = 180_000 }) {
  return rpc(
    { type: 'run', targetId, injectScript, pollScript, timeoutMs },
    { onUpdate },
  );
}
