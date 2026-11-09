// config-swap.mjs — which config.yaml keys need a spine restart (step B, 2026-10-16).
//
// boot.mjs swaps a changed config.yaml in (getConfig() returns the new one) unless the change
// touches a key below: those are bound ONCE at boot — a dialled bridge, a bound port, a resolved
// service profile — and nothing re-reads them. A key boot starts binding once belongs here.
import { isDeepStrictEqual } from 'node:util';
import { LEGACY_BLOCKS } from '../loop-guard.mjs';
import { chatboxNames } from '../bridges/http.mjs';

// `*` matches any one segment (an agent's map key).
export const RESTART_KEYS = [
  'node_name', 'node_alias',                                              // node signature, ears, mesh self-set
  'limbs', 'beeper', 'beeper_token', 'agents.*.use', 'agents.*.beeper_connection', // tokens, endpoints, the bridges dialled
  'agents.*.fallback_handle.unless_peer_alive',                           // one peer watcher per port, built at boot
  'shell', 'peer_spine',                                                  // console port/token, being link, mouth link
  'dispatch.address_without_at',                                          // baked into both limbs and the router
  'user_name', 'whatsapp.user_name', 'whatsapp.media',                    // bridge construction options
  'bridge_signature_open', 'bridge_signature_close', 'transcription_open', 'transcription_close',
  'echo', 'echo_max_age_ms', 'echo_priority', 'echo_timeout_ms', 'echo_coverage_similarity', 'peer_nodes',
  'ear_probe', 'media_flood',
  'transcription_service', 'transcription', 'transcriptor', 'voice_service', 'synthesizer',   // profiles resolved once, worker roles
  'default_time_zone',                                                    // resolved once for identity, transcript, spine, commands
  'warm.max', 'warm.idle_ttl_ms', 'warm.idle_ttl_by_class',               // the warm pool's own limits
  'loop_guard', ...Object.values(LEGACY_BLOCKS), 'turn_timeout_ms',      // both loop-guard halves (+ pre-0044 keys), the per-turn backstop
];

const isMap = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// Every concrete path a pattern names in either config, with its value on each side.
function expand(pattern, a, b, at = []) {
  const [head, ...rest] = pattern;
  if (head == null) return [{ path: at.join('.'), a, b }];
  const keys = head === '*' ? [...new Set([...Object.keys(isMap(a) ? a : {}), ...Object.keys(isMap(b) ? b : {})])] : [head];
  return keys.flatMap((k) => expand(rest, isMap(a) ? a[k] : undefined, isMap(b) ? b[k] : undefined, [...at, k]));
}

/** The restart-only paths whose value differs between two configs, e.g. ['shell', 'agents.h.use'].
 *  The top-level chatbox blocks either one names (limbs.http.chatboxes) bind at boot too. */
export function restartKeysChanged(prev, next) {
  const keys = new Set([...RESTART_KEYS, ...chatboxNames(prev), ...chatboxNames(next)]);
  return [...keys].flatMap((p) => expand(p.split('.'), prev, next)).filter(({ a, b }) => !isDeepStrictEqual(a, b)).map(({ path }) => path);
}

/** For the log line: the top-level keys that changed, `agents` broken out per agent. */
export function changedKeys(prev = {}, next = {}) {
  return expand(['*'], prev, next).flatMap(({ path, a, b }) => {
    if (isDeepStrictEqual(a, b)) return [];
    return path === 'agents' ? expand(['*'], a, b, ['agents']).filter((x) => !isDeepStrictEqual(x.a, x.b)).map((x) => x.path) : [path];
  });
}

/** Does writing `path` (a /config set target) touch a restart-only key? */
export function isRestartKey(path) {
  const seg = String(path ?? '').split('.');
  return RESTART_KEYS.some((p) => {
    const ps = p.split('.');
    const n = Math.min(ps.length, seg.length);
    return ps.slice(0, n).every((s, i) => s === '*' || s === seg[i]);
  });
}
