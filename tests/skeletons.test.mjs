// tests/skeletons.test.mjs — the shipped paste-ready templates in config/skeletons/
// must never rot: config/skeletons/heartbeats.yaml has to parse as YAML AND every
// entry has to pass the heartbeat loader's OWN parse (frequency/when + command/ai_run),
// so a skeleton the operator copies always loads. Runs the real loader collect()
// against the parsed block (no profile touched — all fakes).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';
import { createHeartbeatLoader, parseHeartbeatsBlock } from '../src/spine/heartbeat-loader.mjs';
import { CONFIG_SCHEMA } from '../config/config-schema.mjs';

const SKELETON = fileURLToPath(new URL('../config/skeletons/heartbeats.yaml', import.meta.url));
const CONFIG_SKELETON = fileURLToPath(new URL('../config/skeletons/config.yaml', import.meta.url));

describe('config/skeletons/heartbeats.yaml', () => {
  const text = readFileSync(SKELETON, 'utf8');

  it('parses as YAML and carries a heartbeats: block', () => {
    const doc = YAML.parse(text);
    expect(doc).toBeTypeOf('object');
    expect(doc.heartbeats).toBeTypeOf('object');
    const block = parseHeartbeatsBlock(text);
    expect(Object.keys(block).length).toBeGreaterThan(0);
  });

  it('every entry passes the loader parse: the when one-shot arms, the recurring one has a cadence, ai_run expands', async () => {
    const block = parseHeartbeatsBlock(text);
    const loader = createHeartbeatLoader({
      getConfig: () => ({ default_time_zone: 'America/New_York', heartbeats: block }),
      aliveMs: 0, procCwd: '/checkout', egptHome: '/home',
      io: { writeFile: async () => {}, mkdir: async () => {} },
      // well before any example `when:` so the one-shot is armed, not stale
      now: () => Date.UTC(2026, 0, 1),
    });
    const { entries } = await loader.collect();
    // no entry was dropped — every skeleton entry normalized cleanly
    expect(entries.length).toBe(Object.keys(block).length);

    const when = entries.find((e) => e.whenMs != null);
    expect(when, 'skeleton should demo a when: one-shot').toBeTruthy();
    expect(when.fired).toBe(false);

    const freq = entries.find((e) => e.everyMs != null);
    expect(freq, 'skeleton should demo a frequency: recurring entry').toBeTruthy();
    expect(freq.everyMs).toBeGreaterThan(0);

    // the one-shot demoes ai_run → expanded to a textecute command
    expect(when.action.aiRun).toBeTruthy();
    expect(when.action.command).toContain('textecute.mjs');
  });
});

describe('config/skeletons/config.yaml', () => {
  const text = readFileSync(CONFIG_SKELETON, 'utf8');

  it('parses as YAML into an object', () => {
    const doc = YAML.parse(text);
    expect(doc).toBeTypeOf('object');
    expect(doc).not.toBeNull();
  });

  it('every top-level key it SETS (uncommented) is registered in CONFIG_SCHEMA', () => {
    // The skeleton can never drift from the schema: a key set here that /config
    // does not know about would be rejected as 'unknown' on a fresh install.
    // The `signal` surface block (peer of whatsapp/telegram) is now registered in
    // CONFIG_SCHEMA, so it no longer needs a known-pending exemption.
    const doc = YAML.parse(text);
    const keys = Object.keys(doc);
    // sanity: the skeleton actually sets the core keys (not an empty parse)
    expect(keys).toContain('beeper_token');
    expect(keys.length).toBeGreaterThanOrEqual(4);
    for (const key of keys) {
      expect(CONFIG_SCHEMA, `skeleton sets "${key}" but it is not in CONFIG_SCHEMA`).toHaveProperty(key);
    }
  });

  it('ships the agents registry uncommented, and no longer sets default_brain (agent type supersedes)', () => {
    const doc = YAML.parse(text);
    // agents is the shipped centerpiece now (operator 2026-07-02) — the persona agent
    expect(doc.agents?.egpt).toMatchObject({ type: 'default', handles: ['e', 'egpt'] });
    // default_brain was removed from the skeleton (documented as a legacy fallback only)
    expect(Object.keys(doc)).not.toContain('default_brain');
  });
});
