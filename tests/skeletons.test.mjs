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
import { AUTO_MODES } from '../src/auto-mode.mjs';
import { ROOM_MEMBER_STATES, ROOM_MEMBER_KINDS } from '../src/room-core.mjs';
import { parseWarmBlock } from '../src/spine/brainpool.mjs';
import { parseTranscriptionConfig } from '../src/transcription-service.mjs';
import { parse as parseConvState, getContact, getBeing, residentsOf } from '../src/conversations-state.mjs';

const SKELETON = fileURLToPath(new URL('../config/skeletons/heartbeats.yaml', import.meta.url));
const CONFIG_SKELETON = fileURLToPath(new URL('../config/skeletons/config.yaml', import.meta.url));
const CONV_SKELETON = fileURLToPath(new URL('../config/skeletons/conversations.yaml', import.meta.url));
const CONVCFG_SKELETON = fileURLToPath(new URL('../config/skeletons/conversation-config.yaml', import.meta.url));

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
    expect(keys).toContain('beeper');   // the beeper accounts block (replaced top-level beeper_token, operator 2026-07-09)
    expect(keys.length).toBeGreaterThanOrEqual(4);
    for (const key of keys) {
      expect(CONFIG_SCHEMA, `skeleton sets "${key}" but it is not in CONFIG_SCHEMA`).toHaveProperty(key);
    }
  });

  it('ships the agents registry uncommented, and no longer sets default_brain (agent configuration supersedes)', () => {
    const doc = YAML.parse(text);
    // agents is the shipped centerpiece now (operator 2026-07-02) — the persona agent
    expect(doc.agents?.egpt).toMatchObject({ configuration: 'egpt', handles: ['e', 'egpt'] });
    // default_brain / persona_name are gone from the skeleton (new-config-only)
    expect(Object.keys(doc)).not.toContain('default_brain');
    expect(Object.keys(doc)).not.toContain('persona_name');
  });
});

// ── the TWO per-conversation files (operator 2026-07-26) ────────────────────
// The ruling was that every conversation option must be documented and commented,
// and that the two files must stop being conflated:
//   config/skeletons/conversations.yaml        → the REGISTRY (one entry per chat)
//   config/skeletons/conversation-config.yaml  → the per-conversation FOLDER config
// NOTE the CONFIG_SCHEMA rule above does NOT extend here: that test guards
// config/skeletons/config.yaml, whose keys ARE the /config namespace. These two
// describe DIFFERENT files with their own key spaces (`contacts:` / `members:` …),
// none of which is a CONFIG_SCHEMA key. Do not generalize that assertion onto them.
// What these lock instead is that the documented option names + enums still match
// what the code actually reads.
describe('config/skeletons/conversations.yaml (the registry)', () => {
  const text = readFileSync(CONV_SKELETON, 'utf8');

  it('the example entry resolves through the REAL readers', () => {
    // Not "does it parse" — does the shape the skeleton teaches actually resolve.
    const state = parseConvState(text);
    const c = getContact(state, 'whatsapp', 'EXAMPLE_CHAT_ID');
    expect(c).toBeTruthy();
    expect(c.slug).toBe('some-group-2606291919');   // derived from conversation_path
    expect(c.entry.home_dir).toBeTruthy();

    const b = getBeing(state, 'whatsapp', 'EXAMPLE_CHAT_ID', 'egpt');
    expect(b.present).toBe(true);                   // the documented agent block is real
    expect(b.threadId).toBe(null);

    // Only the documented agent is a resident — no phantom from a flat key.
    expect(residentsOf(c.entry)).toEqual(['egpt']);
  });

  it('uncommenting an option yields something the real readers honor', () => {
    // The whole point of the ruling: configuring = uncommenting. So the commented
    // lines have to be live YAML at the right indent, not prose that happens to
    // start with '#'. Strip the '#' from the option lines an operator would.
    const on = (t, key) => t.replace(new RegExp(`^(\\s*)#(${key}:.*)$`, 'm'), '$1$2');
    let t = text;
    for (const k of ['posts_back_delay_ms', 'guard', 'mode', 'send_to_egpt']) t = on(t, k);

    const state = parseConvState(t);
    const entry = getContact(state, 'whatsapp', 'EXAMPLE_CHAT_ID').entry;
    // the flat pair — read by src/spine/transcription.mjs and src/spine/boot.mjs
    expect(entry.posts_back_delay_ms).toBe(-1);
    expect(entry.guard).toEqual({ turns: -1 });

    // the per-agent pair — read by getBeing → src/spine/gating.mjs
    const b = getBeing(state, 'whatsapp', 'EXAMPLE_CHAT_ID', 'egpt');
    expect(AUTO_MODES).toContain(b.mode);
    expect(['always', 'mode']).toContain(b.send_to_egpt);

    // and it must not have grown a phantom resident in the process
    expect(residentsOf(entry)).toEqual(['egpt']);
  });

  it('every reply mode it names is a real AUTO_MODES token, and it names them all', () => {
    // The mode line is the one enum an operator copies verbatim; if AUTO_MODES
    // gains or loses a token the skeleton must say so.
    const line = text.split('\n').find((l) => l.includes('how this agent wakes here'));
    expect(line, 'the mode one-liner should still be there').toBeTruthy();
    const named = line.split(':').pop().split('|').map((s) => s.trim());
    expect(named.sort()).toEqual([...AUTO_MODES].sort());
  });

  it('points at the OTHER file by path, and warns that comments here are erased', () => {
    expect(text).toContain('conversations/<surface>/<slug>/config.yaml');
    expect(text).toContain('config/skeletons/conversation-config.yaml');
    expect(text).toMatch(/COMMENTS YOU ADD HERE DO NOT SURVIVE/);
  });
});

describe('config/skeletons/conversation-config.yaml (the per-conversation folder config)', () => {
  const text = readFileSync(CONVCFG_SKELETON, 'utf8');

  it('is all-commented, and every reader takes that as "defaults"', () => {
    // Deliberate: every block here is optional, so the shipped file sets nothing
    // and each service must read it as absent rather than choke.
    expect(YAML.parse(text)).toBe(null);
    expect(parseWarmBlock(text)).toEqual({ idleTtlMs: null });
    expect(parseTranscriptionConfig(text)).toEqual({ enabled: true, postsBack: true });
    expect(parseHeartbeatsBlock(text)).toEqual({});
  });

  it('the member states + kinds it documents are exactly the real ones', () => {
    const states = text.split('\n').find((l) => l.includes('state  '));
    const kinds = text.split('\n').find((l) => l.includes('kind   '));
    expect(states, 'the state one-liner should still be there').toBeTruthy();
    expect(kinds, 'the kind one-liner should still be there').toBeTruthy();
    for (const s of ROOM_MEMBER_STATES) expect(states, `state "${s}" undocumented`).toContain(s);
    for (const k of ROOM_MEMBER_KINDS) expect(kinds, `kind "${k}" undocumented`).toContain(k);
  });

  it('points at the OTHER file by path, and says comments ARE safe here', () => {
    expect(text).toContain('config/skeletons/conversations');
    expect(text).toMatch(/COMMENTS ARE SAFE HERE/);
  });
});
