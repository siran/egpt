// chrome-pool.mjs — deterministic, memory-bounded LAUNCH ADMISSION for the per-profile Chrome
// pool (plans/2610091931 chunk 2), plus the two pure readers a caller uses to turn a conversation
// into a launch descriptor.
//
// PURE BY CONSTRUCTION, and that is the whole point (operator's key requirement: "a deterministic
// estimate as if to launch a new one"): nothing here touches fs, net, a clock, or the OS. Every
// real-world measurement — how much physical memory is free, how large a running Chrome's working
// set is — is taken by the CALLER (src/spine/commands.mjs) through injected seams and handed in as
// plain numbers, so the whole launch DECISION is unit-testable with no real Chrome and no real OS
// call. Given the same measurements it always returns the same answer.
//
// Mirrors the SHAPE of the warm-session pool's policy helpers (src/warm-sessions.mjs): small pure
// functions the launch orchestrator keys its registry decisions off, not a second launch path.

import { basename } from 'node:path';

export const MB = 1024 * 1024;

// THE DETERMINISTIC PER-CHROME COST ESTIMATE. Given the measured working-set/RSS of the managed
// Chromes currently running, the estimate is the MAX of them — the worst case the next one is
// likely to cost. With none running (nothing to measure), the configured floor. Non-positive /
// non-finite samples are dropped (an unreadable RSS is "unknown", not "0 bytes"). Same samples in
// → same number out: no clock, no randomness.
export function estimateChromeBytes({ runningRssBytes = [], floorBytes = 0 } = {}) {
  const measured = runningRssBytes.filter((n) => Number.isFinite(n) && n > 0);
  return measured.length ? Math.max(...measured) : floorBytes;
}

// THE PURE ADMISSION DECISION for ONE more Chrome. Launch when the launch would still leave the
// safety margin free; otherwise the caller must make room. The EXACT BOUNDARY —
// availableBytes - estimateBytes === marginBytes — ADMITS (the test is `>=`, never `>`).
//   available - estimate >= margin                     → { action: 'launch'  }
//   below margin, an idle managed Chrome can be freed   → { action: 'evict'   }  (caller evicts the
//                                                          idlest and calls again with the freed RAM)
//   below margin, nothing idle to evict                 → { action: 'decline' }
// `canEvict` is what distinguishes evict from decline; the caller sets it from whether any managed
// Chrome is idle (never busy). The shared/brain Chrome is NOT in the caller's managed set, so this
// never gates or evicts it — admission bounds only the EXTRA, dedicated Chromes.
export function admitLaunch({ availableBytes, estimateBytes, marginBytes, canEvict = false } = {}) {
  const projectedFree = Number(availableBytes) - Number(estimateBytes);
  const margin = Number(marginBytes);
  const toMb = (b) => Math.round(Number(b) / MB);
  if (projectedFree >= margin) {
    return { ok: true, action: 'launch', reason: `fits: ~${toMb(projectedFree)} MB would remain free, >= the ${toMb(margin)} MB margin` };
  }
  if (canEvict) {
    return { ok: false, action: 'evict', reason: `only ~${toMb(projectedFree)} MB would remain (< ${toMb(margin)} MB margin) — evict the idlest managed Chrome and retry` };
  }
  return { ok: false, action: 'decline', reason: `only ~${toMb(projectedFree)} MB would remain (< ${toMb(margin)} MB margin) and no idle managed Chrome to evict` };
}

// THE PER-CONVERSATION DEDICATED FLAG, read from the conversation's RESOLVED config doc — the one
// the config resolver merges out of config/config.yaml < config/conversations.yaml <
// <conv>/config.yaml (src/spine/config-resolver.mjs), exactly as brainpool.parseWarmBlock reads
// `warm:`. `chrome.dedicated: true` opts THIS conversation out of the shared brain Chrome and onto
// its own profile + process; absent / false / anything-but-true (the default) = shared. Pure.
export function parseDedicatedFlag(doc) {
  const c = (doc && typeof doc === 'object' && doc.chrome && typeof doc.chrome === 'object' && !Array.isArray(doc.chrome)) ? doc.chrome : {};
  return c.dedicated === true;
}

// Build the Chrome launch DESCRIPTOR a caller hands ensureChrome, from the conversation's registry
// ENTRY (getContact(state, surface, jid).entry — the existing helper that already holds it) and its
// RESOLVED config doc. The descriptor is `{ slug, name, dedicated }`:
//   • slug — basename of `conversation_path` (the dir name under the profiles root, e.g.
//     "Reinie Alvino-2607150057"); falls back to `entry.slug`. chromeProfileOf sanitizes it.
//   • name — `pushedName` (the chat title), which chromeProfileOf matches against admin_channel so
//     the admin conversation keeps brain.
//   • dedicated — the flag above.
// Pure. The runtime wiring of a caller that passes this to ensureChrome is CHUNK 3/4 (routing the
// being's CDP); here it is the documented contract those chunks build on.
export function chromeConversationOf(entry = {}, doc = {}) {
  const path = String(entry?.conversation_path ?? '').replace(/\\/g, '/');
  const slug = (path ? basename(path) : '') || entry?.slug || '';
  return { slug, name: entry?.pushedName ?? '', dedicated: parseDedicatedFlag(doc) };
}
