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

const SKELETON = fileURLToPath(new URL('../config/skeletons/heartbeats.yaml', import.meta.url));

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
