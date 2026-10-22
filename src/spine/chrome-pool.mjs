// chrome-pool.mjs — deterministic, memory-bounded LAUNCH ADMISSION for the per-profile Chrome
// pool (plans/2610091931 chunk 2), plus the pure browser-group lookup a caller uses to turn a
// conversation into a launch descriptor.
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
import { sanitizeSlug } from '../sanitize.mjs';

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
// Chrome is idle (never busy). The brain Chrome is NOT in the caller's managed set, so this
// never gates or evicts it — admission bounds only the other groups' Chromes.
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

// BROWSER GROUPS (plans/2610091931 rev 2026-10-11). Group name = profile dir name; `brain` is the
// existing brain profile, every unlisted chat is `shared`.
export const BRAIN_GROUP = 'brain';
export const SHARED_GROUP = 'shared';

// A group name must be one safe path segment: something sanitizeSlug leaves exactly as it is.
export const isSafeGroupName = (g) => typeof g === 'string' && g !== '' && sanitizeSlug(g) === g;

// THE GROUP LOOKUP: a conversation's registry ENTRY + config/browsers.yaml's `groups:` map
// (rooms-file.readBrowserGroups) → the descriptor ensureChrome takes, `{ key, name, group }`.
//   • key   — basename of `conversation_path`, else `entry.slug`.
//   • name  — the key minus its `-yymmddhhmm` creation stamp: the chat name as the slug carries it,
//     sanitized (conversations-state ensureContact mints and renames slugs by this rule). Every entry
//     has it; pushedName is only a key comment in the live file and absent on most entries.
//   • group — the one group listing the name (compared as sanitizeSlug(listed)); unlisted → `shared`.
//     Listed in two groups, or in a group whose name is not a safe path segment → null (no browser)
//     plus `why`. Never a silent pick.
//   • unlisted with a parent (parentOf(entry): a /split's parent_chat entry) → the parent's group,
//     bounded hops. /end drops the split's entry, which ends the inheritance (operator 2026-10-21).
export function chromeConversationOf(entry = {}, groups = {}, parentOf = () => null, hops = 8) {
  const path = String(entry?.conversation_path ?? '').replace(/\\/g, '/');
  const key = (path ? basename(path) : '') || entry?.slug || '';
  const name = key.replace(/-\d{10}$/, '');
  const hits = Object.entries(groups ?? {})
    .filter(([, members]) => name && [].concat(members ?? []).some((m) => sanitizeSlug(m) === name))
    .map(([g]) => g);
  if (hits.length > 1) return { key, name, group: null, why: `"${name}" is listed in browser groups ${hits.join(', ')}` };
  const parent = !hits.length && hops > 0 ? parentOf(entry) : null;
  if (parent) return { ...chromeConversationOf(parent, groups, parentOf, hops - 1), key, name };
  const group = hits[0] ?? SHARED_GROUP;
  if (!isSafeGroupName(group)) return { key, name, group: null, why: `browser group "${group}" is not a safe profile dir name` };
  return { key, name, group };
}
