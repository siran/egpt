// AUTO-RESTART ON CONFIG CHANGE (operator 2026-10-09).
//
// config.yaml is read ONCE at boot (boot.mjs `const cfg = readConfig()`), and many values are
// captured into services there, so an edit otherwise needs a manual /restart. When the feature is
// ON, the spine's tick pulse notices a SETTLED config.yaml content change and triggers the SAME
// exit-43 drain the ingest /restart runs (requestRestart → boot's announceAndExit(43)) — a FULL
// restart, so every boot-captured value applies consistently.
//
// Two halves. The SEAM half drives createSpine directly with an injected read/hash and
// restart-trigger, firing tick() by hand — the five behaviours the ruling names. The SEAM-UNIT
// half exercises the real file read/hash (configContentHashSync): no-op save, change, malformed.
import { describe, it, expect } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpine } from '../src/spine/spine.mjs';
import { configContentHashSync } from '../src/tools/config-io.mjs';

// ── minimal fakes — the eight required deps, each a no-op. The config check rides tick() and
//    touches none of the message pipe, so nothing here needs to do anything.
const deps = () => ({
  bridge: { onMessage() {}, send() {}, stop() {} },
  brain: { async turn() { return { text: '' }; } },
  identity: { build: (m) => m },
  router: { resolve: () => ({ being: 'e' }) },
  gating: { async decide() { return { mode: 'off', receives: false, mayReply: false, sendToEgpt: 'mode' }; }, surfaces: () => false },
  sender: { open: () => ({ update() {}, async finish() {}, async fail() {} }) },
  transcript: { async log() {} },
  heartbeats: { runDue() {} },
});

const BOOT = 'hash-boot';
const NEXT = 'hash-next';

function build(opts = {}) {
  const restarts = [];
  const lines = [];
  const spine = createSpine({
    ...deps(),
    log: { line: (s) => lines.push(s) },
    requestRestart: () => restarts.push('restart'),
    ...opts,
  });
  return { spine, restarts, lines };
}

describe('spine tick — auto-restart on a config.yaml content change', () => {
  it('content changed + ENABLED → one /restart, fired exactly once across many ticks', () => {
    let live = BOOT;
    const { spine, restarts, lines } = build({
      autoRestartOnConfigChange: true, configBootHash: BOOT, readConfigHash: () => live,
    });
    spine.tick();
    expect(restarts).toEqual([]);          // unchanged yet

    live = NEXT;                           // the operator saved an edit
    spine.tick();
    spine.tick();
    spine.tick();
    expect(restarts).toEqual(['restart']); // once — the latch, not once per tick
    expect(lines.some((l) => l.includes('config.yaml changed on disk'))).toBe(true);
  });

  it('content changed + DISABLED → nothing (default false, the conservative node)', () => {
    let live = BOOT;
    const { spine, restarts } = build({
      autoRestartOnConfigChange: false, configBootHash: BOOT, readConfigHash: () => live,
    });
    live = NEXT;
    spine.tick();
    spine.tick();
    expect(restarts).toEqual([]);
  });

  it('a no-op save (same content hash) → no restart', () => {
    const { spine, restarts } = build({
      autoRestartOnConfigChange: true, configBootHash: BOOT, readConfigHash: () => BOOT,
    });
    spine.tick();
    spine.tick();
    expect(restarts).toEqual([]);
  });

  it('malformed/partial write (hash null) → nothing, the spine WAITS; the settled change then restarts', () => {
    let live = null;                       // mid-write: readConfigHash cannot parse it → null
    const { spine, restarts } = build({
      autoRestartOnConfigChange: true, configBootHash: BOOT, readConfigHash: () => live,
    });
    spine.tick();
    spine.tick();
    expect(restarts).toEqual([]);          // never a restart onto a broken config

    live = NEXT;                           // the file settled to a valid, changed config
    spine.tick();
    expect(restarts).toEqual(['restart']);
  });

  it('after a respawn carrying the NEW content (boot hash == live hash) → no re-trigger', () => {
    // The respawned spine captures the new content as its OWN boot hash — the fire-once guarantee.
    const { spine, restarts } = build({
      autoRestartOnConfigChange: true, configBootHash: NEXT, readConfigHash: () => NEXT,
    });
    spine.tick();
    spine.tick();
    expect(restarts).toEqual([]);
  });

  it('inert when a seam is missing (older caller / unexercised test) even with the flag on', () => {
    let live = NEXT;
    // no readConfigHash, no configBootHash
    const a = build({ autoRestartOnConfigChange: true, requestRestart: () => a.restarts.push('x'), readConfigHash: () => live });
    a.spine.tick();
    expect(a.restarts).toEqual([]);        // configBootHash null → inert
  });
});

// ── THE READ/HASH SEAM ITSELF (configContentHashSync) — the real file read + parse-gate ──────────
describe('configContentHashSync — content hash, parse-gated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'egpt-cfg-hash-'));
  const p = join(dir, 'config.yaml');
  const after = () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} };

  it('identical bytes hash the same; changed bytes hash differently; a missing file is null', () => {
    writeFileSync(p, 'node_name: kg\nturn_timeout_ms: 600000\n', 'utf8');
    const h1 = configContentHashSync(p);
    writeFileSync(p, 'node_name: kg\nturn_timeout_ms: 600000\n', 'utf8');   // no-op save, same bytes
    expect(configContentHashSync(p)).toBe(h1);

    writeFileSync(p, 'node_name: kg\nturn_timeout_ms: 1000\n', 'utf8');     // a real edit
    expect(configContentHashSync(p)).not.toBe(h1);

    expect(configContentHashSync(join(dir, 'does-not-exist.yaml'))).toBeNull();
    after();
  });

  it('a malformed / mid-write config returns null (never a hash to act on)', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'egpt-cfg-bad-'));
    const bad = join(dir2, 'config.yaml');
    writeFileSync(bad, 'node_name: "kg\n  broken: [unterminated\n', 'utf8');  // not valid YAML
    expect(configContentHashSync(bad)).toBeNull();
    try { rmSync(dir2, { recursive: true, force: true }); } catch {}
  });
});
