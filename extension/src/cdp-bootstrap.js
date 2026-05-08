// extension/src/cdp-bootstrap.js — installs the CDP host getter when
// the build doesn't shim tools/cdp.mjs to a chrome.debugger adapter.
//
// Chrome dist: tools/cdp.mjs is shimmed to extension/src/tools/cdp-ext.js
// (which uses chrome.debugger and has no concept of a host). The
// import below resolves to that module; setCdpHostGetter is undefined
// and the if-guard makes this a no-op. Harmless dead code on Chrome.
//
// Firefox dist: no shim, so tools/cdp.mjs resolves to the real
// browser-portable module. We register a chrome.storage-backed
// host getter so the user can point a Firefox extension at a remote
// Chrome (host:9222 + token through the egpt-proxy).
//
// Imported FIRST in tab/index.jsx so the getter is in place before
// any cdpHost() call.

import * as cdp from '../../tools/cdp.mjs';

if (typeof cdp.setCdpHostGetter === 'function') {
  let _cached = null;
  cdp.setCdpHostGetter(async () => {
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
}
