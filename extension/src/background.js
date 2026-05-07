// extension/src/background.js — service worker (minimal: just opens the tab)
// All logic lives in the tab itself (it's an extension page with full chrome.* access).

// Path is relative to the extension root — i.e. wherever manifest.json
// lives. Both Chrome (extension/dist/) and Firefox (extension/dist-firefox/)
// dists are self-contained, so 'tab/index.html' works in both.
const TAB_URL = 'tab/index.html';

chrome.action.onClicked.addListener(async () => {
  const tabUrl = chrome.runtime.getURL(TAB_URL);
  const existing = await chrome.tabs.query({ url: tabUrl });
  if (existing.length > 0) {
    chrome.tabs.update(existing[0].id, { active: true });
    chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url: tabUrl });
  }
});
