// Operator slash commands: recognition (Self DM / authorized), lifecycle exits,
// and the loop intercept (a command is never routed to the brain).
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { createCommands } from '../src/spine/commands.mjs';
import { createSpine } from '../spine.mjs';
import { emptyState, ensureContact, getBeing, recordThread, patchContact, DEFAULT_ALLOWED_TOOLS, READONLY_ALLOWED_TOOLS } from '../conversations-state.mjs';

function harness({ config = {}, state = null, agentTypes = ['egpt', 'sonnet-high'], brains, identityLayers = ['default'] } = {}) {
  const sent = [], exits = [], rewinds = [], writes = [], evicts = [];
  const files = {};   // custom-branch authored files (agent-type yaml + identity layer)
  let st = state;
  const cmds = createCommands({
    getConfig: () => config,
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
    io: { writeFile: async (p, c) => { files[p] = c; }, mkdir: async () => {} },
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
    expect(sent[0].text).toMatch(/on, mute, mention-direct, mention, off/);   // the surviving enum, accum gone from the list
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
    state = recordThread(state, 'whatsapp', '!room', 'THREAD-1');   // existing context
    state = patchContact(state, 'whatsapp', '!room', { readonly: { agent: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'all' } });
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
    state = recordThread(state, 'whatsapp', '!room', 'THREAD-1');   // existing context to preserve
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
    state = recordThread(state, 'whatsapp', '!room', 'THREAD-1');
    return patchContact(state, 'whatsapp', '!room', { readonly: { agent: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: tools } });
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
