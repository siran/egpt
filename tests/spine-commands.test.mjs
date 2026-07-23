// Operator slash commands: recognition (Self DM / authorized), lifecycle exits,
// and the loop intercept (a command is never routed to the brain).
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCommands } from '../src/spine/commands.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { Room } from '../src/room-core.mjs';
import { emptyState, ensureContact, getBeing, recordThread, patchContact, DEFAULT_ALLOWED_TOOLS, READONLY_ALLOWED_TOOLS } from '../src/conversations-state.mjs';

function harness({ config = {}, state = null, agentTypes = ['egpt', 'sonnet-high'], brains, identityLayers = ['default'], io = {}, cdp, launch, clock } = {}) {
  const sent = [], exits = [], rewinds = [], writes = [], evicts = [];
  const files = {};   // custom-branch authored files (agent-type yaml + identity layer)
  let st = state;
  // /chrome launch + clock seams: default to a fake that reports "task not registered"
  // and an advancing fake clock, so NO command test ever runs real schtasks or waits real
  // wall-clock time (both seams are consumed ONLY by /chrome's chromeReport).
  const fakeClock = clock ?? (() => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; })();
  const cmds = createCommands({
    getConfig: () => config,
    ...(cdp ? { cdp } : {}),
    launchChromeTask: launch ?? (() => ({ ok: false })),
    now: fakeClock.now,
    sleep: fakeClock.sleep,
    send: async (chatId, text) => sent.push({ chatId, text }),
    exit: (code) => exits.push(code),
    writeRewindTarget: (ref) => rewinds.push(ref),
    loadState: state ? async () => st : null,
    writeState: state ? async (s) => { writes.push(s); st = s; } : null,
    listAgentTypes: () => agentTypes,
    listIdentityLayers: () => identityLayers,
    brains: brains ?? { resolve: (name) => ({ name, type: 'ccode', allowed_tools: 'all' }) },
    evictWarm: (key) => evicts.push(key),
    agentsDir: '/agents', identitiesDir: '/identities',
    io: { writeFile: async (p, c) => { files[p] = c; }, mkdir: async () => {}, ...io },
  });
  return { cmds, sent, exits, rewinds, writes, evicts, files, getState: () => st };
}

describe('commands.isCommand', () => {
  it('recognizes a slash command in the Self DM', () => {
    const { cmds } = harness({ config: { whatsapp: { chat_id: '!self' } } });
    expect(cmds.isCommand({ body: '/restart', chatId: '!self' })).toBe(true);
  });
  it('recognizes a slash command from an authorized sender / own send anywhere', () => {
    const { cmds } = harness();
    expect(cmds.isCommand({ body: '/restart', chatId: '!group', authorized: true })).toBe(true);
    expect(cmds.isCommand({ body: '/restart', chatId: '!group', isSender: true })).toBe(true);
  });
  it('does NOT recognize a slash command from a random chat/sender', () => {
    const { cmds } = harness({ config: { whatsapp: { chat_id: '!self' } } });
    expect(cmds.isCommand({ body: '/restart', chatId: '!group' })).toBe(false);
  });
  it('recognizes a slash command in the TELEGRAM surface Self DM (per-surface chat_id)', () => {
    const { cmds } = harness({ config: { whatsapp: { chat_id: '!self' }, telegram: { chat_id: '!tg-self' } } });
    expect(cmds.isCommand({ body: '/restart', chatId: '!tg-self', surface: 'telegram' })).toBe(true);
  });
  it('does NOT recognize a slash command from a random telegram chat', () => {
    const { cmds } = harness({ config: { telegram: { chat_id: '!tg-self' } } });
    expect(cmds.isCommand({ body: '/restart', chatId: '!tg-group', surface: 'telegram' })).toBe(false);
  });
  it('the whatsapp Self chat_id does NOT authorize the same id on the telegram surface (namespace)', () => {
    const { cmds } = harness({ config: { whatsapp: { chat_id: '!self' } } });
    expect(cmds.isCommand({ body: '/restart', chatId: '!self', surface: 'telegram' })).toBe(false);
  });
  it('does NOT treat plain text (or @e) as a command', () => {
    const { cmds } = harness();
    expect(cmds.isCommand({ body: 'hola', chatId: '!self', authorized: true })).toBe(false);
    expect(cmds.isCommand({ body: '@e estas?', chatId: '!self', authorized: true })).toBe(false);
  });
});

describe('commands.run', () => {
  it('lifecycle commands exit with the daemon codes', async () => {
    const { cmds, exits } = harness();
    await cmds.run({ body: '/restart', chatId: '!self' });
    await cmds.run({ body: '/upgrade', chatId: '!self' });
    expect(exits).toEqual([43, 42]);
  });
  it('/rewind <ref> writes the target then exits 44', async () => {
    const { cmds, exits, rewinds } = harness();
    await cmds.run({ body: '/rewind deadbeef', chatId: '!self' });
    expect(rewinds).toEqual(['deadbeef']);
    expect(exits).toEqual([44]);
  });
  it('an unwired command is acknowledged (no exit, not leaked to E)', async () => {
    const { cmds, sent, exits } = harness();
    await cmds.run({ body: '/channels', chatId: '!self' });
    expect(exits).toEqual([]);
    expect(sent[0].text).toMatch(/channels: recognized/);
  });

  it('/e auto <mode> persists the conversation mode into conversations.yaml', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;
    const { cmds, sent, getState } = harness({ state });
    await cmds.run({ body: '/e auto on', chatId: '!room', surface: 'whatsapp' });
    expect(getBeing(getState(), 'whatsapp', '!room', 'e').mode).toBe('on');
    expect(sent[0].text).toMatch(/E mode here → on/);
  });

  it('/e auto <bad> is rejected and leaves the mode unchanged', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;
    const { cmds, sent, getState } = harness({ state });
    await cmds.run({ body: '/e auto loud', chatId: '!room', surface: 'whatsapp' });
    expect(getBeing(getState(), 'whatsapp', '!room', 'e').mode).toBe(null);
    expect(sent[0].text).toMatch(/unknown mode/);
  });

  it('/e auto accum is now the unknown-mode error (accum retired 2026-07-01)', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;
    const { cmds, sent, getState } = harness({ state });
    await cmds.run({ body: '/e auto accum', chatId: '!room', surface: 'whatsapp' });
    expect(getBeing(getState(), 'whatsapp', '!room', 'e').mode).toBe(null);   // not persisted
    expect(sent[0].text).toMatch(/unknown mode "accum"/);
    expect(sent[0].text).toMatch(/on, auto, mute, mention-direct, mention, off/);   // the surviving enum (auto added 2026-07-04), accum gone
  });

  it('/e auto <mode> <target> from Self sets the NAMED chat (not the Self DM)', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' }).state;
    const { cmds, sent, getState } = harness({ state });
    await cmds.run({ body: '/e auto on hfm', chatId: '!self', surface: 'whatsapp' });
    expect(getBeing(getState(), 'whatsapp', '!hfm:beeper.local', 'e').mode).toBe('on');   // the NAMED chat
    expect(getBeing(getState(), 'whatsapp', '!self', 'e')).toBe(null);                     // Self DM untouched (not even a contact)
    expect(sent[0].text).toMatch(/HFM.*→ on/);
  });

  it('/e auto <mode> <unknown> reports no match', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' }).state;
    const { cmds, sent } = harness({ state });
    await cmds.run({ body: '/e auto on zzz', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/no chat matches/);
  });

  it('/e auto <mode> <unknown-jid> errors and does NOT write state (no false ✅)', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' }).state;
    const { cmds, sent, writes } = harness({ state });
    // A verbatim jid E has never seen: patchContact would silently no-op, so the
    // old code replied "✅" for a chat it never touched. Now it must fail loudly.
    await cmds.run({ body: '/e auto mute !nope:beeper.local', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/no chat matches/);
    expect(writes).toHaveLength(0);
  });

  it('/e auto <mode> <known-jid> succeeds and writes state', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' }).state;
    const { cmds, sent, writes, getState } = harness({ state });
    await cmds.run({ body: '/e auto mute !hfm:beeper.local', chatId: '!self', surface: 'whatsapp' });
    expect(getBeing(getState(), 'whatsapp', '!hfm:beeper.local', 'e').mode).toBe('mute');
    expect(writes).toHaveLength(1);
    expect(sent[0].text).toMatch(/→ mute/);
  });
});

// resolveTarget cross-surface fallback (operator 2026-07-05 live bug): from the whatsapp
// Self DM, "/e auto auto miss" reported "no chat matches" even though a telegram chat
// "Miss Xinyi" was registered — resolveTarget only ever searched the command's own
// surface. Own-surface hits still win with no ambiguity check against other surfaces;
// only a ZERO own-surface hit falls through to every other KNOWN_SURFACES entry.
describe('/e auto <target>: cross-surface resolution', () => {
  it('a TELEGRAM chat targeted by name from the whatsapp Self DM resolves + patches the TELEGRAM entry', async () => {
    const state = ensureContact(emptyState(), 'telegram', '!miss:something', { pushedName: 'Miss Xinyi', slugHint: 'miss-xinyi' }).state;
    const { cmds, sent, getState } = harness({ state });
    await cmds.run({ body: '/e auto on miss', chatId: '!self', surface: 'whatsapp' });
    expect(getBeing(getState(), 'telegram', '!miss:something', 'e').mode).toBe('on');   // the TELEGRAM entry
    expect(getBeing(getState(), 'whatsapp', '!miss:something', 'e')).toBe(null);         // whatsapp has no such being
    expect(sent[0].text).toMatch(/Miss Xinyi.*→ on/);
  });

  it('a same-surface hit wins silently even when another surface ALSO matches the term', async () => {
    let state = ensureContact(emptyState(), 'whatsapp', '!miss-wa:beeper.local', { pushedName: 'Miss Wa', slugHint: 'miss-wa' }).state;
    state = ensureContact(state, 'telegram', '!miss-tg:something', { pushedName: 'Miss Tg', slugHint: 'miss-tg' }).state;
    const { cmds, sent, getState } = harness({ state });
    await cmds.run({ body: '/e auto on miss', chatId: '!self', surface: 'whatsapp' });
    expect(getBeing(getState(), 'whatsapp', '!miss-wa:beeper.local', 'e').mode).toBe('on');   // the OWN-surface hit
    expect(getBeing(getState(), 'telegram', '!miss-tg:something', 'e').mode).toBe(null);       // telegram untouched, no ambiguity check
    expect(sent[0].text).not.toMatch(/be more specific/);
  });

  it('cross-surface ambiguity (own surface 0 hits, two OTHER surfaces match) lists each hit with its surface', async () => {
    let state = ensureContact(emptyState(), 'telegram', '!miss-tg:something', { pushedName: 'Miss Tg', slugHint: 'miss-tg' }).state;
    state = ensureContact(state, 'signal', '!miss-sig:something', { pushedName: 'Miss Sig', slugHint: 'miss-sig' }).state;
    const { cmds, sent, writes } = harness({ state });
    await cmds.run({ body: '/e auto on miss', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/matches 2/);
    expect(sent[0].text).toMatch(/Miss Tg \(telegram\)/);
    expect(sent[0].text).toMatch(/Miss Sig \(signal\)/);
    expect(sent[0].text).toMatch(/be more specific/);
    expect(writes).toHaveLength(0);
  });
});

describe('/status <target>: cross-surface resolution', () => {
  it('/status <cross-surface target> reports the TELEGRAM conversation, not the whatsapp origin', async () => {
    const state = ensureContact(emptyState(), 'telegram', '!miss:something', { pushedName: 'Miss Xinyi', slugHint: 'miss-xinyi' }).state;
    // io.readFile always misses (no transcript/heartbeats fixtures) — every such probe
    // degrades independently (matches the /status <target> degrade tests); this test
    // only cares that the reported conversation is the resolved TARGET surface.
    const { cmds, sent } = harness({ state, io: { readFile: async () => { throw new Error('ENOENT'); } } });
    await cmds.run({ body: '/status miss', chatId: '!self', surface: 'whatsapp' });
    const { text } = sent[0];
    expect(text).toMatch(/name: Miss Xinyi/);
    expect(text).toMatch(/surface: telegram/);       // the resolved TARGET surface, not whatsapp
    expect(text).toMatch(/slug: Miss Xinyi/);
  });
});

describe('loop intercept', () => {
  it('a command is handled, NOT routed to the brain (and is logged)', async () => {
    let cb = null;
    const brain = { calls: [], async turn(b, e) { this.calls.push(e); return { text: 'x' }; } };
    const exits = [];
    const cmds = createCommands({ getConfig: () => ({ whatsapp: { chat_id: '!self' } }), send: async () => {}, exit: (c) => exits.push(c) });
    const transcript = { entries: [], log(ev) { this.entries.push(ev); } };
    const spine = createSpine({
      bridge: { onMessage(fn) { cb = fn; }, send() {}, stop() {} },
      brain, commands: cmds,
      identity: { build: (m) => ({ ...m }) },
      router: { resolve: () => 'e' },
      gating: { decide: async () => ({ mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }), surfaces: () => true },
      sender: { open: () => ({ update() {}, async finish() {} }) },
      transcript, heartbeats: { runDue() {} },
    });
    spine.start();
    await cb({ body: '/restart', chatId: '!self' });
    expect(brain.calls).toHaveLength(0);   // intercepted — not the persona
    expect(exits).toEqual([43]);
    expect(transcript.entries).toHaveLength(1);
  });
});

describe('/e wizard', () => {
  const contact = () => ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;

  it('/e (bare) arms the wizard here and posts the first (agent-type) prompt', async () => {
    const { cmds, sent } = harness({ state: contact() });
    const ev = { chatId: '!room', surface: 'whatsapp', authorized: true };
    await cmds.run({ ...ev, body: '/e' });
    expect(sent[0].text).toMatch(/reconfigure «fam»/);
    expect(sent[0].text).toMatch(/1\/1  agent type\?/);   // existing pick = 1 step
    expect(sent[0].text).toMatch(/1\) egpt/);
    // armed → a plain pick from the operator now gets first refusal…
    expect(cmds.isCommand({ ...ev, body: '1' })).toBe(true);
    // …but a non-operator's message in the same chat never routes to it.
    expect(cmds.isCommand({ chatId: '!room', surface: 'whatsapp', body: '1' })).toBe(false);
  });

  it('picking an existing type applies IMMEDIATELY with its pinned model/effort, freezes readonly (threadId preserved), evicts warm', async () => {
    let state = contact();
    // existing context, seeded in the persona's NESTED block (operator 2026-07-10): readonly
    // first, then recordThread MERGES the thread in so both survive.
    state = patchContact(state, 'whatsapp', '!room', { e: { readonly: { agent: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'all' } } });
    state = recordThread(state, 'whatsapp', '!room', 'THREAD-1', undefined, 'e');
    const brains = { resolve: (name) => ({ name, type: 'ccode', model: 'opus', effort: 'high', allowed_tools: ['Read'] }) };
    const { cmds, sent, evicts, getState } = harness({ state, brains });
    const ev = { chatId: '!room', surface: 'whatsapp', authorized: true };
    await cmds.run({ ...ev, body: '/e' });   // arm
    await cmds.run({ ...ev, body: '2' });    // type → sonnet-high → applies immediately (pinned opus/high)
    const b = getBeing(getState(), 'whatsapp', '!room', 'e');
    expect(b).toMatchObject({ agent: 'sonnet-high', brainType: 'ccode', model: 'opus', effort: 'high' });
    expect(b.allowedTools).toEqual(['Read']);
    expect(b.threadId).toBe('THREAD-1');                       // re-point keeps the thread
    expect(evicts).toEqual([`e:ccode:whatsapp:${b.slug}`]);    // old-engine-keyed warm entry dropped
    expect(sent.at(-1).text).toMatch(/«fam» → sonnet-high · opus\/high/);   // pushedName, not the slug
  });

  it('picking a type that omits model/effort applies the deterministic floor (sonnet/high)', async () => {
    const brains = { resolve: (name) => ({ name, type: 'ccode', allowed_tools: 'all' }) };   // no model/effort pinned
    const { cmds, sent, getState } = harness({ state: contact(), brains });
    const ev = { chatId: '!room', surface: 'whatsapp', authorized: true };
    await cmds.run({ ...ev, body: '/e' });   // arm
    await cmds.run({ ...ev, body: '1' });    // type → egpt → applies immediately (floor)
    expect(getBeing(getState(), 'whatsapp', '!room', 'e')).toMatchObject({ agent: 'egpt', model: 'sonnet', effort: 'high' });
    expect(sent.at(-1).text).toMatch(/«fam» → egpt · sonnet\/high/);
  });

  it('a picked type file that says allowed_tools: all is coerced to the explicit default list before freezing, never written as \'all\'', async () => {
    const brains = { resolve: (name) => ({ name, type: 'ccode', allowed_tools: 'all' }) };
    const { cmds, getState } = harness({ state: contact(), brains });
    const ev = { chatId: '!room', surface: 'whatsapp', authorized: true };
    await cmds.run({ ...ev, body: '/e' });
    await cmds.run({ ...ev, body: '1' });
    expect(getBeing(getState(), 'whatsapp', '!room', 'e').allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
  });

  it('/e <fragment> resolves the target chat (like /e auto) and writes THERE, not the Self DM', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' }).state;
    const { cmds, sent, getState } = harness({ state, config: { whatsapp: { chat_id: '!self' } } });
    const ev = { chatId: '!self', surface: 'whatsapp' };   // typed in the Self DM
    await cmds.run({ ...ev, body: '/e hfm' });
    expect(sent[0].text).toMatch(/reconfigure «HFM»/i);
    await cmds.run({ ...ev, body: '1' });   // type → egpt → applies immediately (deterministic floor)
    expect(getBeing(getState(), 'whatsapp', '!hfm:beeper.local', 'e')).toMatchObject({ agent: 'egpt', model: 'sonnet', effort: 'high' });
    expect(getBeing(getState(), 'whatsapp', '!self', 'e')).toBe(null);   // Self DM untouched
  });

  it('/e <cross-surface target> arms + applies to the TELEGRAM conversation (initWizard/buildResult surface threading)', async () => {
    const state = ensureContact(emptyState(), 'telegram', '!miss:something', { pushedName: 'Miss Xinyi', slugHint: 'miss-xinyi' }).state;
    const { cmds, sent, getState } = harness({ state, config: { whatsapp: { chat_id: '!self' } } });
    const ev = { chatId: '!self', surface: 'whatsapp' };   // typed in the whatsapp Self DM
    await cmds.run({ ...ev, body: '/e miss' });            // arm — target resolved cross-surface onto telegram
    expect(sent[0].text).toMatch(/reconfigure «Miss Xinyi»/i);
    await cmds.run({ ...ev, body: '1' });                  // type → egpt → applies immediately (deterministic floor)
    expect(getBeing(getState(), 'telegram', '!miss:something', 'e')).toMatchObject({ agent: 'egpt', model: 'sonnet', effort: 'high' });
    expect(getBeing(getState(), 'whatsapp', '!self', 'e')).toBe(null);   // Self DM (operator chat) untouched
  });

  it('x cancels an armed wizard (nothing written, no longer armed)', async () => {
    const { cmds, sent, writes } = harness({ state: contact() });
    const ev = { chatId: '!room', surface: 'whatsapp', authorized: true };
    await cmds.run({ ...ev, body: '/e' });
    await cmds.run({ ...ev, body: 'x' });
    expect(sent.at(-1).text).toMatch(/cancelled/);
    expect(writes).toHaveLength(0);
    expect(cmds.isCommand({ ...ev, body: '1' })).toBe(false);
  });

  it('b steps back to the previous question (in the custom branch, the only multi-step path)', async () => {
    const { cmds, sent } = harness({ state: contact() });   // agentTypes [egpt, sonnet-high] → tools = 3, custom = option 4
    const ev = { chatId: '!room', surface: 'whatsapp', authorized: true };
    await cmds.run({ ...ev, body: '/e' });   // step 1 (type) — "1/1"
    await cmds.run({ ...ev, body: '4' });    // custom → step 2 (model) "2/5"
    expect(sent.at(-1).text).toMatch(/2\/5  model\?/);
    await cmds.run({ ...ev, body: 'b' });    // back → step 1 type (mode still custom → "1/5")
    expect(sent.at(-1).text).toMatch(/1\/5  agent type\?/);
  });

  it('an armed wizard expires after its 5-min TTL (inert, not stepped)', async () => {
    const { cmds, writes } = harness({ state: contact() });
    const ev = { chatId: '!room', surface: 'whatsapp', authorized: true };
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-03T00:00:00Z'));
      await cmds.run({ ...ev, body: '/e' });                     // armed at T0
      vi.setSystemTime(new Date('2026-07-03T00:06:00Z'));        // +6 min > 5-min TTL
      expect(cmds.isCommand({ ...ev, body: '1' })).toBe(false);  // expired → not a command
      await cmds.run({ ...ev, body: '1' });                      // stepping does nothing
      expect(writes).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it('a non-operator message never steps or cancels an armed wizard', async () => {
    const { cmds } = harness({ state: contact() });
    const op = { chatId: '!room', surface: 'whatsapp', authorized: true };
    await cmds.run({ ...op, body: '/e' });   // armed
    const stranger = { chatId: '!room', surface: 'whatsapp' };
    expect(cmds.isCommand({ ...stranger, body: '2' })).toBe(false);
    expect(cmds.isCommand({ ...stranger, body: 'x' })).toBe(false);
    expect(cmds.isCommand({ ...op, body: '2' })).toBe(true);   // still armed for the operator
  });

  it('lists only agent types that resolve (an all-comments/unknown type is dropped)', async () => {
    const brains = { resolve: (name) => (name === 'egpt' ? { name, type: 'ccode', allowed_tools: 'all' } : null) };
    const { cmds, sent } = harness({ state: contact(), agentTypes: ['egpt', 'sonnet-high'], brains });
    await cmds.run({ body: '/e', chatId: '!room', surface: 'whatsapp', authorized: true });
    expect(sent[0].text).toMatch(/1\) egpt/);
    expect(sent[0].text).not.toMatch(/sonnet-high/);   // unresolvable → not offered
  });

  it('/e auto is NOT intercepted by the wizard arming', async () => {
    const { cmds, sent, getState } = harness({ state: contact() });
    await cmds.run({ body: '/e auto on', chatId: '!room', surface: 'whatsapp' });
    expect(getBeing(getState(), 'whatsapp', '!room', 'e').mode).toBe('on');
    expect(sent[0].text).toMatch(/E mode here → on/);
    expect(sent[0].text).not.toMatch(/reconfigure/);
  });
});

describe('/e wizard: structured-yaml view + custom branch', () => {
  const contact = () => ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;
  const ev = { chatId: '!room', surface: 'whatsapp', authorized: true };

  it('step 1 renders each type\'s composition inline and offers custom last', async () => {
    const brains = { resolve: (name) => (name === 'egpt' ? { name, type: 'ccode', model: 'sonnet', effort: 'high', personality: 'default' } : null) };
    const { cmds, sent } = harness({ state: contact(), agentTypes: ['egpt', 'sonnet-high'], brains });
    await cmds.run({ ...ev, body: '/e' });
    const p = sent[0].text;
    expect(p).toMatch(/1\) egpt:/);
    expect(p).toMatch(/model: sonnet/);
    expect(p).toMatch(/effort: high/);
    expect(p).toMatch(/personality: default/);
    expect(p).not.toMatch(/sonnet-high/);    // unresolvable → dropped
    expect(p).toMatch(/2\) tools:/);         // tools before custom
    expect(p).toMatch(/3\) custom:/);        // custom last (only egpt resolved)
  });

  it('custom branch (free-text personality): writes the type file + identity layer, freezes readonly, evicts', async () => {
    let state = contact();
    state = recordThread(state, 'whatsapp', '!room', 'THREAD-1', undefined, 'e');   // existing context to preserve (nested persona thread)
    const { cmds, sent, evicts, writes, files, getState } = harness({ state, agentTypes: ['egpt'], identityLayers: ['default', 'secretary'] });
    await cmds.run({ ...ev, body: '/e' });          // arm — configs [egpt] + tools = option 2, custom = option 3
    await cmds.run({ ...ev, body: '3' });           // custom → model step
    await cmds.run({ ...ev, body: '2' });           // model → sonnet
    await cmds.run({ ...ev, body: '3' });           // effort → high
    // personality step: [default, secretary] + describe it = option 3
    await cmds.run({ ...ev, body: '3' });           // describe it → free capture
    await cmds.run({ ...ev, body: 'You are a terse ops bot.' });   // free text → name step
    await cmds.run({ ...ev, body: 'Ops Bot' });     // name (sanitized → ops-bot) → done

    // type file written with the right shape
    const typeFile = files[join('/agents', 'ops-bot.yaml')];
    expect(typeFile).toBeTruthy();
    expect(typeFile).toMatch(/type: ccode/);
    expect(typeFile).toMatch(/model: sonnet/);
    expect(typeFile).toMatch(/effort: high/);
    expect(typeFile).toMatch(/personality: ops-bot/);   // free text → layer named after the type
    // identity layer written as a FLAT file (JUST the instructions, no comment header)
    const layer = files[join('/identities', 'ops-bot.md')];
    expect(layer).toBe('You are a terse ops bot.\n');
    // applied to the conversation exactly like an existing-type pick
    const b = getBeing(getState(), 'whatsapp', '!room', 'e');
    expect(b).toMatchObject({ agent: 'ops-bot', brainType: 'ccode', model: 'sonnet', effort: 'high' });
    expect(b.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(b.threadId).toBe('THREAD-1');            // re-point keeps the thread
    expect(evicts).toEqual([`e:ccode:whatsapp:${b.slug}`]);
    expect(writes.length).toBe(1);
    expect(sent.at(-1).text).toMatch(/new type created/);
    expect(sent.at(-1).text).toMatch(/ops-bot · sonnet\/high/);
  });

  it('custom branch (existing personality layer): no identity file, type file names the picked layer', async () => {
    const { cmds, files } = harness({ state: contact(), agentTypes: ['egpt'], identityLayers: ['default', 'poet'] });
    await cmds.run({ ...ev, body: '/e' });
    await cmds.run({ ...ev, body: '3' });   // custom
    await cmds.run({ ...ev, body: '1' });   // model → haiku
    await cmds.run({ ...ev, body: '1' });   // effort → low
    await cmds.run({ ...ev, body: '2' });   // personality → poet (option 2, not free text)
    await cmds.run({ ...ev, body: 'bard' }); // name → done
    expect(files[join('/agents', 'bard.yaml')]).toMatch(/personality: poet/);
    expect(files[join('/identities', 'bard.md')]).toBeUndefined();   // no free-text layer authored
  });

  it('custom branch: the personality step lists the seeded layers + a free-text option', async () => {
    const { cmds, sent } = harness({ state: contact(), agentTypes: ['egpt'], identityLayers: ['default', 'secretary', 'poet'] });
    await cmds.run({ ...ev, body: '/e' });
    await cmds.run({ ...ev, body: '3' });   // custom
    await cmds.run({ ...ev, body: '1' });   // model
    await cmds.run({ ...ev, body: '1' });   // effort → personality step
    const p = sent.at(-1).text;
    expect(p).toMatch(/personality\?/);
    expect(p).toMatch(/default/);
    expect(p).toMatch(/secretary/);
    expect(p).toMatch(/poet/);
    expect(p).toMatch(/describe it \(free text\)/);
  });

  it('custom branch: a name colliding with an existing type re-prompts, then accepts a fresh one', async () => {
    const { cmds, sent, files } = harness({ state: contact(), agentTypes: ['egpt', 'sonnet-high'], identityLayers: ['default'] });
    await cmds.run({ ...ev, body: '/e' });
    await cmds.run({ ...ev, body: '4' });   // custom (2 types + tools + custom = option 4)
    await cmds.run({ ...ev, body: '2' });   // model
    await cmds.run({ ...ev, body: '3' });   // effort
    await cmds.run({ ...ev, body: '1' });   // personality → default
    await cmds.run({ ...ev, body: 'egpt' }); // name taken
    expect(sent.at(-1).text).toMatch(/name taken/);
    expect(files[join('/agents', 'egpt.yaml')]).toBeUndefined();   // nothing written on collision
    await cmds.run({ ...ev, body: 'fresh-type' });         // ok → done
    expect(files[join('/agents', 'fresh-type.yaml')]).toMatch(/type: ccode/);
    expect(sent.at(-1).text).toMatch(/new type created/);
  });
});

describe('/e wizard: tools branch', () => {
  const ev = { chatId: '!room', surface: 'whatsapp', authorized: true };
  const instanced = (tools) => {
    let state = ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;
    // instanced brain + thread in the persona's NESTED block (operator 2026-07-10): readonly
    // first, then recordThread MERGES the thread so both survive.
    state = patchContact(state, 'whatsapp', '!room', { e: { readonly: { agent: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: tools } } });
    return recordThread(state, 'whatsapp', '!room', 'THREAD-1', undefined, 'e');
  };

  it('the CFG_STEP menu offers "tools" (never "all") and arming reaches it via bare /e', async () => {
    const { cmds, sent } = harness({ state: instanced(['Read']), agentTypes: ['egpt'] });
    await cmds.run({ ...ev, body: '/e' });
    expect(sent[0].text).toMatch(/2\) tools:/);
    expect(sent[0].text).not.toMatch(/\ball\b/i);
  });

  it('/e <fragment> also reaches the tools branch', async () => {
    const state = ensureContact(instanced(['Read']), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' }).state;
    const { cmds, sent } = harness({ state, agentTypes: ['egpt'], config: { whatsapp: { chat_id: '!self' } } });
    await cmds.run({ chatId: '!self', surface: 'whatsapp', body: '/e hfm' });
    await cmds.run({ chatId: '!self', surface: 'whatsapp', body: '2' });   // tools
    expect(sent.at(-1).text).toMatch(/2\/2  tools\?/);
  });

  it('"default" (1) freezes DEFAULT_ALLOWED_TOOLS, keeps agent/model/effort + threadId, evicts warm', async () => {
    const { cmds, sent, evicts, getState } = harness({ state: instanced(['Read']), agentTypes: ['egpt'] });
    await cmds.run({ ...ev, body: '/e' });
    await cmds.run({ ...ev, body: '2' });   // tools
    await cmds.run({ ...ev, body: '1' });   // default
    const b = getBeing(getState(), 'whatsapp', '!room', 'e');
    expect(b).toMatchObject({ agent: 'egpt', brainType: 'ccode', model: 'sonnet', effort: 'high', threadId: 'THREAD-1' });
    expect(b.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(evicts).toEqual([`e:ccode:whatsapp:${b.slug}`]);
    expect(sent.at(-1).text).toMatch(/«fam» tools → \[Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task\]/);
  });

  it('"read-only" (2) freezes READONLY_ALLOWED_TOOLS', async () => {
    const { cmds, getState } = harness({ state: instanced(['Read']), agentTypes: ['egpt'] });
    await cmds.run({ ...ev, body: '/e' });
    await cmds.run({ ...ev, body: '2' });   // tools
    await cmds.run({ ...ev, body: '2' });   // read-only
    expect(getBeing(getState(), 'whatsapp', '!room', 'e').allowedTools).toEqual(READONLY_ALLOWED_TOOLS);
  });

  it('"keep current" (3) preserves the exact live list untouched', async () => {
    const { cmds, getState } = harness({ state: instanced(['Read', 'Bash(git:*)']), agentTypes: ['egpt'] });
    await cmds.run({ ...ev, body: '/e' });
    await cmds.run({ ...ev, body: '2' });   // tools
    await cmds.run({ ...ev, body: '3' });   // keep current
    expect(getBeing(getState(), 'whatsapp', '!room', 'e').allowedTools).toEqual(['Read', 'Bash(git:*)']);
  });

  it('"keep current" on a legacy allowed_tools: all self-heals to the explicit default — never re-freezes \'all\'', async () => {
    const { cmds, getState } = harness({ state: instanced('all'), agentTypes: ['egpt'] });
    await cmds.run({ ...ev, body: '/e' });
    await cmds.run({ ...ev, body: '2' });   // tools
    await cmds.run({ ...ev, body: '3' });   // keep current
    expect(getBeing(getState(), 'whatsapp', '!room', 'e').allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
  });

  it('custom (4) free text freezes exactly the validated list typed', async () => {
    const { cmds, getState } = harness({ state: instanced(['Read']), agentTypes: ['egpt'] });
    await cmds.run({ ...ev, body: '/e' });
    await cmds.run({ ...ev, body: '2' });   // tools
    await cmds.run({ ...ev, body: '4' });   // custom
    await cmds.run({ ...ev, body: 'Read Grep WebFetch Bash(yt-dlp:*)' });
    expect(getBeing(getState(), 'whatsapp', '!room', 'e').allowedTools).toEqual(['Read', 'Grep', 'WebFetch', 'Bash(yt-dlp:*)']);
  });

  it('custom free text rejects a bare Bash — re-prompts, wizard stays armed, nothing written', async () => {
    const { cmds, sent, writes } = harness({ state: instanced(['Read']), agentTypes: ['egpt'] });
    await cmds.run({ ...ev, body: '/e' });
    await cmds.run({ ...ev, body: '2' });   // tools
    await cmds.run({ ...ev, body: '4' });   // custom
    await cmds.run({ ...ev, body: 'Read Bash' });
    expect(sent.at(-1).text).toMatch(/bare "Bash" isn't allowed/);
    expect(writes).toHaveLength(0);
    expect(cmds.isCommand({ ...ev, body: '1' })).toBe(true);   // still armed
  });

  it('a never-instanced conversation picking tools + default falls back to the deterministic floor', async () => {
    const { cmds, getState } = harness({ state: contact(), agentTypes: ['egpt'] });
    await cmds.run({ ...ev, body: '/e' });
    await cmds.run({ ...ev, body: '2' });   // tools
    await cmds.run({ ...ev, body: '1' });   // default
    expect(getBeing(getState(), 'whatsapp', '!room', 'e')).toMatchObject({ agent: 'egpt', model: 'sonnet', effort: 'high' });
  });
});

function contact() {
  return ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;
}

// /chrome <node> — ATTACH-ONLY Chrome status, answered ONLY by the addressed node.
// The CDP seam is injected everywhere here: these tests never reach a real Chrome
// and never open a socket. The node gate is the same wake-word principle as the
// mesh's self-set (node_name ∪ node_alias): a non-addressed node says NOTHING, so
// on a shared Beeper account exactly one node answers.
describe('/chrome <node>', () => {
  const self = { chatId: '!self', surface: 'whatsapp' };
  const kg = { node_name: 'kg', whatsapp: { chat_id: '!self' } };
  const reachable = {
    isRunning: async () => true,
    cdpHost: async () => 'localhost:9221',
    listTabs: async () => ([
      { title: 'ChatGPT', url: 'https://chatgpt.com/c/abc' },
      { title: 'Claude', url: 'https://claude.ai/chat/def' },
    ]),
  };
  const unreachable = {
    isRunning: async () => false,
    cdpHost: async () => 'localhost:9221',
    listTabs: async () => { throw new Error('Cannot reach Chrome at localhost:9221'); },
  };

  it('/chrome kg on the kg node with Chrome reachable reports attached + the host + tab info', async () => {
    const { cmds, sent } = harness({ config: kg, cdp: reachable });
    await cmds.run({ ...self, body: '/chrome kg' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/attached/i);
    expect(sent[0].text).toMatch(/localhost:9221/);
    expect(sent[0].text).toMatch(/tabs: 2/);
    expect(sent[0].text).toMatch(/ChatGPT/);
    expect(sent[0].text).toMatch(/chatgpt\.com/);
  });

  // The whole point of the gate: `do` must not answer a question addressed to `kg`.
  it('/chrome kg on the `do` node replies NOTHING AT ALL (silent — only the addressed node answers)', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'do', whatsapp: { chat_id: '!self' } }, cdp: reachable });
    await cmds.run({ ...self, body: '/chrome kg' });
    expect(sent).toHaveLength(0);
  });

  it('a node_alias matches too (the addressed name is any of node_name ∪ node_alias)', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg', node_alias: ['reve'], whatsapp: { chat_id: '!self' } }, cdp: reachable });
    await cmds.run({ ...self, body: '/chrome reve' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/attached/i);
  });

  it('the node match is case-insensitive', async () => {
    const { cmds, sent } = harness({ config: kg, cdp: reachable });
    await cmds.run({ ...self, body: '/chrome KG' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/attached/i);
  });

  // NOT an error: no Chrome listening is the normal resting state. The node cannot
  // open one itself (Session 0 service — an invisible browser), so it hands the
  // operator the exact command line to run in THEIR session.
  it('/chrome kg with Chrome NOT reachable reports the launch command line (no throw, not a failure)', async () => {
    const { cmds, sent } = harness({ config: kg, cdp: unreachable });
    await cmds.run({ ...self, body: '/chrome kg' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/no chrome/i);
    expect(sent[0].text).toMatch(/--remote-debugging-port=9221/);
    expect(sent[0].text).toMatch(/--user-data-dir=/);
    expect(sent[0].text).not.toMatch(/failed|error/i);
    // The reason it can't do it itself must land in the chat, not just in a comment.
    expect(sent[0].text).toMatch(/session/i);
  });

  it('a listTabs failure after a live isRunning degrades to the launch hint, never a throw', async () => {
    const { cmds, sent } = harness({
      config: kg,
      cdp: { ...unreachable, isRunning: async () => true },
    });
    await expect(cmds.run({ ...self, body: '/chrome kg' })).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  // Bare /chrome = usage, self-naming. Every node answers this ONE short line (it is
  // the discovery path: it tells the operator the valid args). The expensive status
  // payload stays strictly single-node.
  it('bare /chrome shows a short usage line naming THIS node', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg', node_alias: ['reve'], whatsapp: { chat_id: '!self' } }, cdp: reachable });
    await cmds.run({ ...self, body: '/chrome' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/\/chrome <node>/);
    expect(sent[0].text).toMatch(/kg/);
    expect(sent[0].text).toMatch(/reve/);
    expect(sent[0].text).not.toMatch(/attached/i);   // never the status payload
  });

  // An unknown arg is a NON-MATCH, and a non-match is silent — same rule as `do`
  // ignoring `/chrome kg`. If every node answered "unknown node" the operator would
  // get exactly the double-answer the gate exists to prevent.
  it('/chrome <unknown node> is silent (a non-match is a non-match, on every node)', async () => {
    const { cmds, sent } = harness({ config: kg, cdp: reachable });
    await cmds.run({ ...self, body: '/chrome zzz' });
    expect(sent).toHaveLength(0);
  });

  it('/chrome is gated on the operator exactly like the other commands', () => {
    const { cmds } = harness({ config: kg, cdp: reachable });
    expect(cmds.isCommand({ body: '/chrome kg', chatId: '!self', surface: 'whatsapp' })).toBe(true);
    expect(cmds.isCommand({ body: '/chrome kg', chatId: '!group', surface: 'whatsapp' })).toBe(false);
    expect(cmds.isCommand({ body: '/chrome kg', chatId: '!group', surface: 'whatsapp', authorized: true })).toBe(true);
  });

  it('a non-operator /chrome is never run (no reply, no CDP probe)', async () => {
    let probed = false;
    const { cmds, sent } = harness({
      config: kg,
      cdp: { ...reachable, isRunning: async () => { probed = true; return true; } },
    });
    const ev = { body: '/chrome kg', chatId: '!group', surface: 'whatsapp' };
    expect(cmds.isCommand(ev)).toBe(false);   // the loop never reaches run()
    expect(sent).toHaveLength(0);
    expect(probed).toBe(false);
  });

  // Regression lock: /chrome must not fall through to the "recognized" catch-all.
  it('/chrome kg is NOT answered by the unwired-command catch-all', async () => {
    const { cmds, sent } = harness({ config: kg, cdp: reachable });
    await cmds.run({ ...self, body: '/chrome kg' });
    expect(sent[0].text).not.toMatch(/recognized/);
  });

  // ── LAUNCH (Session-0 → Session-1 scheduled-task hop) ──────────────────────────
  // Unreachable is no longer just a hint: /chrome fires the `egpt-chrome` scheduled
  // task (via the injected launch seam — a fake here, `schtasks /run /tn egpt-chrome`
  // in prod), polls CDP up to ~20s (fake advancing clock → instant), then attaches.

  it('/chrome kg unreachable → fires the launch task, waits, attaches, replies with tabs', async () => {
    const launched = [];
    // isRunning stays false until the launch fires, then comes up on the 2nd poll (proves it WAITS).
    let polls = 0;
    const cdp = {
      isRunning: async () => launched.length > 0 && ++polls >= 2,
      cdpHost: async () => 'localhost:9221',
      listTabs: async () => ([
        { title: 'ChatGPT', url: 'https://chatgpt.com/c/abc' },
        { title: 'Claude', url: 'https://claude.ai/chat/def' },
      ]),
    };
    const launch = () => { launched.push('fire'); return { ok: true }; };
    const { cmds, sent } = harness({ config: kg, cdp, launch });
    await cmds.run({ ...self, body: '/chrome kg' });
    expect(launched).toHaveLength(1);             // the launch task WAS fired (schtasks recorded)
    expect(polls).toBeGreaterThanOrEqual(2);      // it polled CDP, not just checked once
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/attached/i);
    expect(sent[0].text).toMatch(/localhost:9221/);
    expect(sent[0].text).toMatch(/tabs: 2/);
    expect(sent[0].text).toMatch(/ChatGPT/);
    expect(sent[0].text).not.toMatch(/no chrome/i);   // NOT the fallback hint
  });

  it('/chrome kg unreachable + launch task NOT registered (schtasks non-zero) → command-line fallback + setup note, no throw', async () => {
    const launched = [];
    const launch = () => { launched.push('fire'); return { ok: false }; };
    const { cmds, sent } = harness({ config: kg, cdp: unreachable, launch });
    await expect(cmds.run({ ...self, body: '/chrome kg' })).resolves.toBeUndefined();
    expect(launched).toHaveLength(1);                  // it TRIED (fired the task) …
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/no chrome/i);        // … then fell back to the hint
    expect(sent[0].text).toMatch(/--remote-debugging-port=9221/);
    expect(sent[0].text).toMatch(/register-chrome-task\.ps1/);   // the one-line setup note
    expect(sent[0].text).not.toMatch(/failed|error/i);
  });

  it('/chrome kg unreachable, launch fires but Chrome never comes up within the timeout → same graceful fallback', async () => {
    const launched = [];
    const launch = () => { launched.push('fire'); return { ok: true }; };
    // unreachable.isRunning is always false; the advancing fake clock makes the ~20s poll instant.
    const { cmds, sent } = harness({ config: kg, cdp: unreachable, launch });
    await expect(cmds.run({ ...self, body: '/chrome kg' })).resolves.toBeUndefined();
    expect(launched).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/no chrome/i);
    expect(sent[0].text).toMatch(/register-chrome-task\.ps1/);
  });

  it('/chrome kg reachable attaches immediately and NEVER fires the launch task', async () => {
    const launched = [];
    const launch = () => { launched.push('fire'); return { ok: true }; };
    const { cmds, sent } = harness({ config: kg, cdp: reachable, launch });
    await cmds.run({ ...self, body: '/chrome kg' });
    expect(launched).toHaveLength(0);                 // Chrome already up → no launch fired
    expect(sent[0].text).toMatch(/attached/i);
    expect(sent[0].text).toMatch(/tabs: 2/);
  });

  it('/chrome kg on the `do` node fires NO launch and stays silent (gate before any launch)', async () => {
    const launched = [];
    const launch = () => { launched.push('fire'); return { ok: true }; };
    const { cmds, sent } = harness({ config: { node_name: 'do', whatsapp: { chat_id: '!self' } }, cdp: unreachable, launch });
    await cmds.run({ ...self, body: '/chrome kg' });
    expect(sent).toHaveLength(0);
    expect(launched).toHaveLength(0);
  });
});

// /room create <name> — the FIRST wired NamedRoom create path (Phase 2). A Room IS a
// folder: `create` makes the standard tree (baseDir + media/files/identity.d + a minimal
// config.yaml) so the heartbeat/transcription loaders enumerate rooms/<name>/. All fs is
// routed through the commands io seam, so these run fully in-memory (mkdir recorded,
// writeFile captured) and never touch a real profile. No member roster yet (later work).
describe('/room create <name>', () => {
  const self = { chatId: '!self', surface: 'whatsapp' };

  it('/room create foo makes the room folder tree and confirms the path', async () => {
    const mkdirs = [];
    const { cmds, sent, files } = harness({
      config: { whatsapp: { chat_id: '!self' } },
      io: { mkdir: async (p) => { mkdirs.push(p); }, stat: async () => { throw new Error('ENOENT'); } },
    });
    await cmds.run({ ...self, body: '/room create foo' });
    const r = Room.named('foo');
    // the standard tree dirs were created …
    for (const dir of [r.baseDir(), r.mediaDir, r.filesDir, r.identityDir]) expect(mkdirs).toContain(dir);
    // … and a config.yaml was written into the room folder
    expect(files[r.configPath]).toBeTruthy();
    // the reply names the EGPT_HOME-relative path
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/rooms\/foo\//);
    expect(sent[0].text).toMatch(/created/);
    expect(sent[0].text).not.toMatch(/recognized/);   // NOT the unwired catch-all
  });

  it('/room create foo again reports it already exists and does NOT clobber (idempotent)', async () => {
    const mkdirs = [];
    const { cmds, sent, files } = harness({
      config: { whatsapp: { chat_id: '!self' } },
      io: { mkdir: async (p) => { mkdirs.push(p); }, stat: async () => ({ isDirectory: () => true }) },   // folder present
    });
    await cmds.run({ ...self, body: '/room create foo' });
    expect(sent[0].text).toMatch(/already exists/);
    expect(mkdirs).toHaveLength(0);              // nothing created
    expect(Object.keys(files)).toHaveLength(0);  // nothing written → existing content untouched
  });

  it('/room create with no name replies usage and creates nothing', async () => {
    const mkdirs = [];
    const { cmds, sent, files } = harness({
      config: { whatsapp: { chat_id: '!self' } },
      io: { mkdir: async (p) => { mkdirs.push(p); }, stat: async () => { throw new Error('ENOENT'); } },
    });
    await cmds.run({ ...self, body: '/room create' });
    expect(sent[0].text).toMatch(/usage: \/room create <name>/);
    expect(mkdirs).toHaveLength(0);
    expect(Object.keys(files)).toHaveLength(0);
  });

  it('/room (bare) shows the usage line naming the wired subcommands', async () => {
    const { cmds, sent } = harness({ config: { whatsapp: { chat_id: '!self' } } });
    await cmds.run({ ...self, body: '/room' });
    expect(sent[0].text).toMatch(/usage/i);
    expect(sent[0].text).toMatch(/create/);
    expect(sent[0].text).toMatch(/join/);
    expect(sent[0].text).not.toMatch(/recognized/);
  });

  // Slug-first grammar (Phase 2): `/room <slug> <verb>` — a non-create first token is a
  // room slug, the second an unknown verb here (join/leave/members are the real ones).
  it('/room <slug> <bad-verb> reports the unknown subcommand (not "create only")', async () => {
    const { cmds, sent } = harness({ config: { whatsapp: { chat_id: '!self' } } });
    await cmds.run({ ...self, body: '/room join fam' });   // slug=join, verb=fam
    expect(sent[0].text).toMatch(/unknown subcommand/i);
  });
});

// Phase 2 dispatch recognition: /rooms, /members, /activate are operator-gated commands
// wired BEFORE the catch-all, so they never leak to E. (Behavior lives in
// tests/rooms-members.test.mjs; here we lock only the recognition + non-leak.)
describe('/rooms /members /activate — dispatch recognition', () => {
  const self = { chatId: '!self', surface: 'whatsapp' };
  const cfg = { whatsapp: { chat_id: '!self' } };

  it('are recognized from the Self DM, refused from a random chat', () => {
    const { cmds } = harness({ config: cfg });
    for (const body of ['/rooms', '/members', '/activate chatgpt']) {
      expect(cmds.isCommand({ body, chatId: '!self', surface: 'whatsapp' })).toBe(true);
      expect(cmds.isCommand({ body, chatId: '!group', surface: 'whatsapp' })).toBe(false);
    }
  });

  it('/members with no current room replies (not the unwired catch-all)', async () => {
    const { cmds, sent } = harness({ config: cfg });
    await cmds.run({ ...self, body: '/members' });
    expect(sent[0].text).toMatch(/no current room/i);
    expect(sent[0].text).not.toMatch(/recognized/);
  });

  it('/rooms with no saved rooms replies (not the catch-all)', async () => {
    const { cmds, sent } = harness({ config: cfg });
    await cmds.run({ ...self, body: '/rooms' });
    expect(sent[0].text).not.toMatch(/recognized/);
  });
});

// /tabs /open /tab /close — Phase 1 browser command wrappers: thin dispatch over
// cdp.mjs's listTabs/openTab/activateTarget/closeTab, same CDP seam /chrome uses (no
// real Chrome, no real socket in these tests). /tab <n> and /close <n> address a tab by
// the SAME 1-based number /tabs prints, resolved fresh against listTabs() on every call
// — never a stale index carried over from an earlier /tabs (Chrome's own tab order can
// shift between commands).
describe('/tabs /open /tab /close', () => {
  const self = { chatId: '!self', surface: 'whatsapp' };
  const cfg = { whatsapp: { chat_id: '!self' } };
  const twoTabs = [
    { id: 'AAA111', title: 'ChatGPT', url: 'https://chatgpt.com/c/abc' },
    { id: 'BBB222', title: 'Gmail', url: 'https://mail.google.com/mail/u/0' },
  ];

  it('/tabs lists both tabs, numbered, with title + url', async () => {
    const { cmds, sent } = harness({ config: cfg, cdp: { listTabs: async () => twoTabs } });
    await cmds.run({ ...self, body: '/tabs' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/tabs: 2/);
    expect(sent[0].text).toMatch(/1 · ChatGPT/);
    expect(sent[0].text).toMatch(/chatgpt\.com/);
    expect(sent[0].text).toMatch(/2 · Gmail/);
    expect(sent[0].text).toMatch(/mail\.google\.com/);
  });

  it('/open <url> calls cdp.openTab with that url and names it in the reply', async () => {
    const opened = [];
    const { cmds, sent } = harness({ config: cfg, cdp: { openTab: async (url) => { opened.push(url); return 'NEWID'; } } });
    await cmds.run({ ...self, body: '/open https://example.com' });
    expect(opened).toEqual(['https://example.com']);
    expect(sent[0].text).toMatch(/https:\/\/example\.com/);
  });

  it('/tab 2 activates the 2nd listed tab', async () => {
    const activated = [];
    const cdp = { listTabs: async () => twoTabs, activateTarget: async (id) => { activated.push(id); } };
    const { cmds, sent } = harness({ config: cfg, cdp });
    await cmds.run({ ...self, body: '/tab 2' });
    expect(activated).toEqual(['BBB222']);   // twoTabs[1].id — the SECOND listed tab
    expect(sent[0].text).toMatch(/Gmail/);
  });

  it('/close 2 closes the 2nd listed tab', async () => {
    const closed = [];
    const cdp = { listTabs: async () => twoTabs, closeTab: async (id) => { closed.push(id); } };
    const { cmds, sent } = harness({ config: cfg, cdp });
    await cmds.run({ ...self, body: '/close 2' });
    expect(closed).toEqual(['BBB222']);
    expect(sent[0].text).toMatch(/Gmail/);
  });

  it('/tab <n> past the end of the list reports it instead of throwing', async () => {
    const cdp = { listTabs: async () => twoTabs, activateTarget: async () => {} };
    const { cmds, sent } = harness({ config: cfg, cdp });
    await expect(cmds.run({ ...self, body: '/tab 5' })).resolves.toBeUndefined();
    expect(sent[0].text).toMatch(/no tab 5/);
  });

  it('none of the four fall through to the unwired-command catch-all', async () => {
    const cdp = { listTabs: async () => twoTabs, openTab: async () => 'X', activateTarget: async () => {}, closeTab: async () => {} };
    const { cmds, sent } = harness({ config: cfg, cdp });
    await cmds.run({ ...self, body: '/tabs' });
    await cmds.run({ ...self, body: '/open https://x' });
    await cmds.run({ ...self, body: '/tab 1' });
    await cmds.run({ ...self, body: '/close 1' });
    expect(sent).toHaveLength(4);
    for (const s of sent) expect(s.text).not.toMatch(/recognized/);
  });
});

// Regression lock (Phase 1): browseTab was a dead export (zero callers anywhere outside
// its own definition in cdp.mjs) evicted alongside /browse. This scans every .mjs/.js
// file under src/ (recursively) for the bare identifier — it FAILS on the pre-eviction
// code (browseTab is defined in src/tools/cdp.mjs) and stays green once it's gone; it
// would also catch a future caller reintroducing it.
describe('browseTab is fully evicted from src/', () => {
  it('no file under src/ references browseTab', () => {
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
    const SRC_DIR = join(ROOT, 'src');
    const offenders = [];
    const walk = (dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (/\.m?js$/.test(ent.name) && readFileSync(p, 'utf8').includes('browseTab')) offenders.push(p);
      }
    };
    walk(SRC_DIR);
    expect(offenders).toEqual([]);
  });
});
