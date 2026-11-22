// CONFIG CHANGE ON THE TICK (operator 2026-10-09; step B 2026-10-16).
//
// The spine's tick pulse (and every message arrival) notices a SETTLED config.yaml content change
// and hands it to boot's applyConfig: hot keys are swapped in with no restart; a restart-only key
// takes the SAME exit-43 drain the ingest /restart runs (requestRestart → boot's
// announceAndExit(43)) when auto_restart_on_config_change is on; an invalid file is refused.
//
// Two halves. The SEAM half drives createSpine directly with an injected hash, applyConfig answer
// and restart trigger, firing tick() by hand. The SEAM-UNIT half exercises the real file read/hash
// (configContentHashSync): no-op save, change, malformed.
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
const RESTART = { restart: ['shell'], autoRestart: true };

function build({ answer = () => RESTART, live = BOOT, ...opts } = {}) {
  const restarts = [];
  const lines = [];
  const group = [];
  const applied = [];
  let hash = live;
  let fire = null;
  const spine = createSpine({
    ...deps(),
    bridge: { onMessage(cb) { fire = cb; }, send() {}, stop() {} },
    log: { line: (s) => lines.push(s) },
    configBootHash: BOOT, readConfigHash: () => hash,
    applyConfig: () => { applied.push(hash); return answer(); },
    requestRestart: () => restarts.push('restart'),
    logToGroup: async (t) => { group.push(t); },
    ...opts,
  });
  spine.start();
  const arrive = () => fire?.({ surface: 'wa', chatId: 'c', msgId: `m${lines.length}`, body: 'hola', kind: 'text', raw: {} });
  return { spine, restarts, lines, group, applied, arrive, save: (h) => { hash = h; } };
}

describe('spine tick — a config.yaml content change is applied, restarted, or refused', () => {
  it('hot keys only → applied once, no restart', () => {
    const { spine, restarts, applied, lines, save } = build({ answer: () => ({ changed: ['agents.e', 'liveness'] }) });
    spine.tick();
    expect(applied).toEqual([]);           // unchanged yet
    save(NEXT);
    spine.tick(); spine.tick();
    expect(applied).toEqual([NEXT]);       // once per content
    expect(restarts).toEqual([]);
    expect(lines.some((l) => l.includes('config.yaml applied without a restart: agents.e, liveness'))).toBe(true);
  });

  it('a restart-only key + the switch ON → one /restart, fired exactly once across many ticks', () => {
    const { spine, restarts, lines, save } = build();
    save(NEXT);
    spine.tick(); spine.tick();
    save('hash-third');
    spine.tick();
    expect(restarts).toEqual(['restart']); // the latch, not once per tick
    expect(lines.some((l) => l.includes('restart-only key(s) shell — triggering /restart'))).toBe(true);
  });

  it('a restart-only key + the switch OFF → nothing restarts, and it says why', () => {
    const { spine, restarts, applied, lines, save } = build({ answer: () => ({ restart: ['shell'], autoRestart: false }) });
    save(NEXT);
    spine.tick(); spine.tick();
    expect(restarts).toEqual([]);
    expect(applied).toEqual([NEXT]);
    expect(lines.some((l) => l.includes('auto_restart_on_config_change is off'))).toBe(true);
  });

  it('an invalid config → refused, the logging group told once, no restart', async () => {
    const { spine, restarts, group, save } = build({ answer: () => ({ error: 'boot: no node_name' }) });
    save(NEXT);
    spine.tick(); spine.tick();
    await Promise.resolve();
    expect(restarts).toEqual([]);
    expect(group).toEqual(['? · config.yaml change refused, the running config stays: boot: no node_name']);
  });

  it('system_messages.config_refused: a custom template is used, a blank one posts nothing', async () => {
    const custom = build({ answer: () => ({ error: 'bad' }), logLine: (k, v) => (k === 'config_refused' ? `refused: ${v.error}` : null) });
    custom.save(NEXT);
    custom.spine.tick(); custom.spine.tick();
    await Promise.resolve();
    expect(custom.group).toEqual(['refused: bad']);
    const blank = build({ answer: () => ({ error: 'bad' }), logLine: () => null });
    blank.save(NEXT);
    blank.spine.tick(); blank.spine.tick();
    await Promise.resolve();
    expect(blank.group).toEqual([]);
  });

  it('a message arrival applies a hot change, but leaves a restart to the tick', async () => {
    const hot = build({ answer: () => ({ changed: ['agents.e'] }) });
    hot.save(NEXT);
    await hot.arrive();
    expect(hot.applied).toEqual([NEXT]);

    const cold = build();
    cold.save(NEXT);
    await cold.arrive();
    expect(cold.restarts).toEqual([]);
    cold.spine.tick();
    expect(cold.restarts).toEqual(['restart']);
  });

  it('a no-op save (same content hash) → nothing is read', () => {
    const { spine, restarts, applied } = build();
    spine.tick(); spine.tick();
    expect(applied).toEqual([]);
    expect(restarts).toEqual([]);
  });

  it('malformed/partial write (hash null) → nothing, the spine WAITS; the settled change then restarts', () => {
    const { spine, restarts, applied, save } = build({ live: null });
    spine.tick(); spine.tick();
    expect(applied).toEqual([]);           // never a restart onto a broken config
    save(NEXT);
    spine.tick();
    expect(restarts).toEqual(['restart']);
  });

  it('after a respawn carrying the NEW content (boot hash == live hash) → no re-trigger', () => {
    const { spine, restarts } = build({ configBootHash: NEXT, live: NEXT });
    spine.tick(); spine.tick();
    expect(restarts).toEqual([]);
  });

  it('inert when a seam is missing (older caller / unexercised test)', () => {
    const a = build({ configBootHash: null, live: NEXT });
    a.spine.tick();
    const b = build({ applyConfig: null, live: NEXT });
    b.spine.tick();
    expect([...a.restarts, ...b.restarts, ...a.applied, ...b.applied]).toEqual([]);
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
