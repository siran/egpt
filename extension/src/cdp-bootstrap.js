// extension/src/cdp-bootstrap.js — installs the CDP host getter for the
// extension context.
//
// The shared tools/cdp.mjs ships with a Node-default getter (reads the
// token from ~/.egpt/cdp-token). In an extension that fallback never
// runs — node:fs isn't reachable. We register a chrome.storage-backed
// getter instead so the user can configure the host (e.g. point a
// Firefox extension at a remote Chrome via the proxy + token).
//
// Default 'localhost:9222' is correct when the extension runs in the
// same Chrome instance it's controlling — no token needed because
// :9222 is the raw Chrome CDP port (Chrome's own loopback). For
// cross-host or Firefox-controlling-remote-Chrome setups, set
// chrome.storage.sync.cdp_host to e.g. 'host:9221/<token>'.
//
// Imported FIRST in every extension entry point (tab, settings,
// background) so the getter is in place before any cdpHost() call.

import { setCdpHostGetter } from '../../tools/cdp.mjs';

let _cached = null;

setCdpHostGetter(async () => {
  if (_cached) return _cached;
  try {
    const got = await chrome.storage.sync.get('cdp_host');
    if (typeof got?.cdp_host === 'string' && got.cdp_host.trim()) {
      _cached = got.cdp_host.trim();
    }
  } catch (_) { /* storage may be unavailable in some contexts */ }
  if (!_cached) _cached = 'localhost:9222';
  return _cached;
});
