// extension/src/tools/cdp-ext.js — CDP adapter using chrome.debugger API.
// Drop-in replacement for tools/cdp.mjs in the extension context.
// Extension tab pages have direct access to chrome.debugger (declared in manifest).

const attached = new Set();

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attached.add(tabId);
  chrome.debugger.onDetach.addListener(function h(src) {
    if (src.tabId !== tabId) return;
    attached.delete(tabId);
    chrome.debugger.onDetach.removeListener(h);
  });
}

async function evaluate(tabId, expression) {
  const r = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  return r?.result?.value ?? null;
}

export async function isRunning() {
  return true; // Chrome is always running in the extension context
}

export async function listTabs(filterRegex = null) {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter(t => t.url && !/^chrome(-extension)?:/.test(t.url))
    .filter(t => !filterRegex || filterRegex.test(t.url))
    .map(t => ({ id: t.id, url: t.url, title: t.title }));
}

export async function findTab(targetId) {
  try {
    const t = await chrome.tabs.get(targetId);
    return t ? { id: t.id, url: t.url, title: t.title } : undefined;
  } catch { return undefined; }
}

export async function openTab(url) {
  const t = await chrome.tabs.create({ url, active: false });
  return { id: t.id, url: t.url ?? url };
}

export async function closeTab(targetId) {
  await chrome.tabs.remove(targetId);
  attached.delete(targetId);
}

export async function peekTab(targetId, pollScript) {
  await ensureAttached(targetId);
  return evaluate(targetId, pollScript);
}

export async function streamFromTab({
  targetId,
  injectScript,
  pollScript,
  onUpdate,
  timeoutMs = 180000,
}) {
  await ensureAttached(targetId);

  // Snapshot current response ID BEFORE injecting the prompt.
  // (Same order as the node cdp.mjs — critical so sawNew fires correctly.)
  const initial = await evaluate(targetId, pollScript);
  const initialId = initial?.id ?? null;

  const injected = await evaluate(targetId, injectScript);
  if (!injected) throw new Error('Inject script returned falsy — selectors may not match.');

  return new Promise((resolve, reject) => {
    let lastText = '';
    let textStable = 0;
    let noStreamingCount = 0;
    let sawNew = false;
    let pollErrs = 0;
    const STABLE_TICKS = 4;
    const TEXT_STALE_FALLBACK_TICKS = 20;
    const MIN_POLL_MS = 10000;
    const pollStartMs = Date.now();

    const done = (text) => { clearTimeout(timeoutHandle); clearInterval(pollHandle); resolve(text); };
    const fail = (err) => { clearTimeout(timeoutHandle); clearInterval(pollHandle); reject(err); };

    const timeoutHandle = setTimeout(() => {
      if (lastText) done(lastText);
      else fail(new Error(`Timed out (${timeoutMs}ms)`));
    }, timeoutMs);

    const pollHandle = setInterval(async () => {
      try {
        const v = await evaluate(targetId, pollScript);
        pollErrs = 0;
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
          done(lastText); return;
        }
        if (textStable >= TEXT_STALE_FALLBACK_TICKS && lastText && (Date.now() - pollStartMs) >= MIN_POLL_MS) {
          done(lastText);
        }
      } catch {
        pollErrs++;
        if (pollErrs > 5) fail(new Error('Repeated poll failures'));
      }
    }, 250);
  });
}
