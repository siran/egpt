// extension/src/cdp-bootstrap.js — installs the CDP host getter for
// the extension. tools/cdp.mjs ships with a Node-default getter that
// reads ~/.egpt/cdp-token from disk; in an extension that's never
// available, so we register a chrome.storage-backed getter here.
//
// Default 'localhost:9221' — Chrome's own raw CDP port, localhost-
// only. The extension lives inside Chrome, so it can talk directly
// without going through the egpt-proxy on :9222. The launcher
// passes --remote-allow-origins=* so a WS upgrade from
// chrome-extension://<id> origin is accepted; without that flag a
// manually-launched Chrome would reject. (Bus tab events go through
// chrome.runtime ports — see bus-ext.js — and don't need a CDP
// attach at all.)
//
// Override via chrome.storage.sync.cdp_host:
//   * 'localhost:9221'        — default (raw Chrome, no proxy needed)
//   * 'localhost:9222'        — through the proxy (loopback bypass)
//   * 'host:9222/<token>'     — cross-host (Firefox extension
//                                controlling a remote Chrome)
//
// Imported FIRST in tab/index.jsx so the getter is in place before
// any cdpHost() call.

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
  if (!_cached) _cached = 'localhost:9221';
  return _cached;
});
