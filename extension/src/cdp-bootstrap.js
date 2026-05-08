// extension/src/cdp-bootstrap.js — installs the CDP host getter for the
// extension context.
//
// Default is 'localhost:9221' — Chrome's own remote-debugging port (the
// 'raw' CDP, localhost-only). The extension lives inside Chrome and
// doesn't need the egpt-proxy on :9222 to function: when the launcher
// starts Chrome with --remote-allow-origins=* (which it does), a WS
// upgrade from chrome-extension://<id> origin is accepted directly.
// Without the proxy dependency, the extension keeps working even when
// the egpt shell isn't running.
//
// Override via chrome.storage.sync.cdp_host:
//   * 'localhost:9222'        — same-host with proxy (token-bypass via
//                                loopback rule)
//   * 'host:9222/<token>'     — cross-host (Firefox controlling a
//                                remote Chrome through the proxy)
//   * any host:port           — bring-your-own
//
// Imported FIRST in every extension entry point so the getter is in
// place before any cdpHost() call.

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
