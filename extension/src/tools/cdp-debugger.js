// extension/src/tools/cdp-debugger.js
//
// Replaces tools/cdp.mjs's streamFromTab + peekTab in the EXTENSION
// build, using chrome.debugger.attach({targetId}) instead of opening
// a raw WebSocket to ws://localhost:9221/devtools/page/<id>.
//
// Why: extension-origin WS connections to local CDP fail unless Chrome
// was launched with --remote-allow-origins=*, and even then have hit
// silent failures in newer Chrome versions. chrome.debugger uses the
// same Chrome DevTools Protocol over the extension-privilege channel,
// no origin flag required, and is the path we already use successfully
// for WA-CDP send (Input.dispatchMouseEvent etc.). This unifies the
// extension's CDP transport.
//
// The HTTP read-only functions (listTabs, findTab, isRunning, openTab,
// closeTab, browseTab) are re-exported from the original tools/cdp.mjs
// since they fetch /json/list etc. and don't need WS. The build shim
// in extension/build.mjs only redirects WS-using imports — it lets
// THIS file's own '../../../tools/cdp.mjs' import pass through.

export {
  listTabs, findTab, isRunning,
  openTab, closeTab, browseTab,
  setCdpHostGetter, cdpHost,
} from '../../../tools/cdp.mjs';

// One-shot Runtime.evaluate via chrome.debugger. Mirrors tools/cdp.mjs's
// peekTab return contract: returns the {id, text} value's text
// (callers expect a string body).
export async function peekTab(targetId, pollScript) {
  const target = { targetId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attached = true;
    const r = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: pollScript,
      returnByValue: true,
    });
    if (r?.exceptionDetails) {
      throw new Error(r.exceptionDetails.text || 'eval threw');
    }
    return r?.result?.value?.text ?? '';
  } finally {
    if (attached) { try { await chrome.debugger.detach(target); } catch (_) {} }
  }
}

// Stream a brain reply via inject + poll loop, all over chrome.debugger.
// Same heuristics as tools/cdp.mjs streamFromTab: poll initial state,
// inject the prompt, then poll for stable+non-streaming output.
export function streamFromTab({
  targetId,
  injectScript,
  pollScript,
  onUpdate,
  timeoutMs = 180000,
}) {
  return new Promise(async (resolve, reject) => {
    const target = { targetId };
    let attached = false;
    let pollHandle = null;
    let timeoutHandle = null;
    let settled = false;

    const cleanup = async () => {
      if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
      if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
      if (attached) { try { await chrome.debugger.detach(target); } catch (_) {} attached = false; }
    };
    const fail = async (err) => { if (settled) return; settled = true; await cleanup(); reject(err); };
    const done = async (text) => { if (settled) return; settled = true; await cleanup(); resolve(text); };

    const evalOnce = async (expression) => {
      const r = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression, returnByValue: true,
      });
      if (r?.exceptionDetails) {
        throw new Error(r.exceptionDetails.text || 'eval threw');
      }
      return r?.result?.value;
    };

    try {
      await chrome.debugger.attach(target, '1.3');
      attached = true;

      // Bring the brain tab to the front in its window. Background
      // tabs in Chrome get aggressive timer/network throttling (RAIL
      // ~1Hz, network priority dropped); ChatGPT, Claude, etc. visibly
      // stop streaming when their tab isn't visible. bringToFront
      // makes the tab the active one in its window without focusing
      // the WINDOW itself, so a brain tab in another monitor's
      // background window will resume normal-rate streaming. Best-
      // effort — failure here doesn't prevent the inject/poll loop
      // from running.
      try { await chrome.debugger.sendCommand(target, 'Page.bringToFront'); } catch (_) {}

      // Initial poll — capture starting message id so we know when a
      // brand-new reply has appeared (vs the previous turn's last
      // assistant message).
      const initial = await evalOnce(pollScript);
      const initialId = initial?.id ?? null;

      // Inject the prompt.
      const sent = await evalOnce(injectScript);
      if (!sent) {
        return fail(new Error('Inject script returned falsy — selectors may not match the current page.'));
      }

      let lastText = '';
      let textStable = 0;
      let noStreamingCount = 0;
      let sawNew = false;
      let pollErrs = 0;
      const pollStartMs = Date.now();
      // Same heuristics as tools/cdp.mjs:
      const STABLE_TICKS = 4;
      const TEXT_STALE_FALLBACK_TICKS = 20;
      const MIN_POLL_MS = 10_000;

      pollHandle = setInterval(async () => {
        try {
          const v = await evalOnce(pollScript);
          pollErrs = 0;
          if (!v) return;
          if (!sawNew) {
            if (v.id && v.id !== initialId) sawNew = true;
            else return;
          }
          if (v.text !== lastText) {
            lastText = v.text;
            onUpdate?.(lastText);
            textStable = 0;
          } else if (lastText) {
            textStable++;
          }
          if (!v.streaming) noStreamingCount++; else noStreamingCount = 0;
          if (noStreamingCount >= STABLE_TICKS && textStable >= STABLE_TICKS && lastText) {
            await done(lastText);
            return;
          }
          if (textStable >= TEXT_STALE_FALLBACK_TICKS && lastText &&
              (Date.now() - pollStartMs) >= MIN_POLL_MS) {
            await done(lastText);
          }
        } catch (_) {
          pollErrs++;
          if (pollErrs > 5) await fail(new Error('Repeated poll failures'));
        }
      }, 250);

      timeoutHandle = setTimeout(async () => {
        if (lastText) await done(lastText);
        else await fail(new Error(`Timed out waiting for response (${timeoutMs}ms)`));
      }, timeoutMs);
    } catch (e) {
      await fail(e);
    }
  });
}
