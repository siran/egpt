// tests/migrations-0018-keys-follow-handles.test.mjs — migrations/0018-keys-follow-handles.mjs.
//
// The fixtures are miniatures of each node's REAL state as the operator measured it on 2026-09-20.
//
// do carries the trap this migration is written around: the beings the operator calls don / den /
// dren are KEYED egpt / ken / wren, because do was built by copying kg's config and renaming only
// the handles. Every assertion here is about finding them by HANDLE — a migration that looked at
// the key would read satisfied on the one node it is for. `pi` (handle `pd`) and `djh` are in every
// fixture precisely because they must come out untouched.
//
// kg is the same one rule reading SATISFIED: nothing there answers to don/den/dren. Its `eplus`
// (handles [ "+", "e+" ]) is the reason the handle→key map is explicit — "rename every key to its
// first handle" would key that being `+`.
//
// CRLF throughout, as the live configs are, and the assertions are on the FULL text rather than a
// re-parse: comments are not part of the parse, and half this migration's value is that they and
// the live threadIds survive the move.
//
// Every fixture is also driven through the REAL runner (setup/migrate.mjs), so the earlier chain has
// to read satisfied on it — that is deliberate (the 0003 fixture lesson): an earlier migration
// refusing on this fixture would stop the chain and fail this file for the wrong reason.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as YAML from 'yaml';
import { plan } from '../migrations/0018-keys-follow-handles.mjs';
import { runMigrations } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');
// The 1-based line a fixture line sits on, read off the fixture rather than counted by hand. `nth`
// picks between identical lines - three chats each open their persona block with the same `egpt:`.
const lineOf = (lines, needle, nth = 1) => {
  const hits = lines.flatMap((l, i) => (l === needle ? [i + 1] : []));
  if (hits.length < nth) throw new Error(`fixture: ${JSON.stringify(needle)} appears ${hits.length} times, wanted #${nth}`);
  return hits[nth - 1];
};

// ── do: the node this migration is for ──────────────────────────────────────────────────────────
const DO_LINES = [
  '# config.yaml - do (fixture)',
  'node_name: do',
  'agents:',
  '  # THE PERSONA, keyed `egpt` because do was built by copying kg\'s config and renaming only the',
  '  # handles. The operator calls it don.',
  '  egpt:',
  '    configuration: sonnet-default # config/agents/sonnet-default.yaml',
  '    handles: [ d, don ]',
  '    default: true',
  '    name: "D"',
  '    conversation_defaults:',
  '      access_level: regular',
  '      allowed_users: [ "1555@s.whatsapp.net" ]',
  '',
  '  ken:',
  '    configuration: opus-xhigh # config/agents/opus-xhigh.yaml',
  '    personality: ken',
  '    handles: [ den ]',
  '    name: "Den"',
  '',
  '  wren:',
  '    configuration: wren # config/agents/wren.yaml',
  '    personality: wren',
  '    handles: [ dren ]',
  '    scope: agent/wren # one wren node-wide: every chat resolves to the same thread',
  '    name: "Dren"',
  '',
  '  # EXCLUDED by the operator (2026-09-20): pi keeps its key though its handle is `pd`, and so',
  '  # does djh.',
  '  pi:',
  '    configuration: haiku-low',
  '    handles: [ pd ]',
  '    name: "Pd"',
  '',
  '  djh:',
  '    configuration: haiku-low',
  '    handles: [ djh ]',
  '    mode: off',
];
const DO = crlf(DO_LINES);
const SCOPE_AFTER = '    scope: agent/dren # one dren node-wide: every chat resolves to the same thread (0018 - the scope names the being, so it follows its key)';
const DO_AFTER = crlf(DO_LINES.map((l) => (
  l === '  egpt:' ? '  don:'
    : l === '  ken:' ? '  den:'
      : l === '  wren:' ? '  dren:'
        : l === '    scope: agent/wren # one wren node-wide: every chat resolves to the same thread' ? SCOPE_AFTER
          : l
)));

const DO_CONV_LINES = [
  '# config/conversations.yaml - do (fixture)',
  'contacts:',
  '  whatsapp:',
  '    "120363000000000001@g.us": # Reencuentro CRC',
  '      slug: Reencuentro CRC',
  '      conversation_path: .egpt/conversations/whatsapp/Reencuentro CRC',
  '      agents:',
  '        egpt:',
  '          threadId: thread-egpt-crc-fixture',
  '          threadCreatedAt: 2026-09-14T21:41:26.506Z',
  '        ken: # the transcriptionist keeps its own thread in this chat',
  '          threadId: thread-ken-crc-fixture',
  '        pi:',
  '          threadId: thread-pi-crc-fixture',
  '    "1555@s.whatsapp.net":',
  '      slug: rodz',
  '      conversation_path: .egpt/conversations/whatsapp/rodz',
  '      agents:',
  '        egpt:',
  '          threadId: thread-egpt-rodz-fixture',
  '          identityInjectedAt: 2026-09-16T02:08:54.971Z',
  '        djh:',
  '          threadId: thread-djh-rodz-fixture',
  '  shell:',
  '    local:',
  '      slug: local',
  '      agents:',
  '        egpt:',
  '          threadId: thread-egpt-shell-fixture',
  '        ken:',
  '          threadId: thread-ken-shell-fixture',
  '        wren:',
  '          threadId: thread-wren-shell-fixture',
  '  agent:',
  '    # the agent-scope bookkeeping row: wren is pinned node-wide, so it has ONE conversation',
  '    wren:',
  '      conversation_path: .egpt/agents/wren',
  '      home_dir: /c/Users/an',
];
const DO_CONV = crlf(DO_CONV_LINES);
const DO_CONV_AFTER = crlf(DO_CONV_LINES.map((l, i) => {
  if (l === '        egpt:') return '        don:';
  if (l === '        ken:' || l === '        ken: # the transcriptionist keeps its own thread in this chat') return l.replace('        ken:', '        den:');
  if (l === '        wren:') return '        dren:';
  if (l === '    wren:') return '    dren:';
  if (l === '      conversation_path: .egpt/agents/wren') return '      conversation_path: .egpt/agents/dren';
  return l;
}));

const DO_ROOMS_LINES = [
  '# config/rooms.yaml - do (fixture)',
  'rooms:',
  '  room/radio:',
  '    radio_service:',
  '      wildnloyal:',
  '        enabled: true',
  '    agents:',
  '      egpt: # the persona runs the station',
  '        threadId: thread-egpt-radio-fixture',
  '        threadCreatedAt: 2026-09-12T03:00:00.000Z',
  '      pi:',
  '        threadId: thread-pi-radio-fixture',
  '  room/dj-son:',
  '    agents:',
  '      pi:',
  '        threadId: thread-pi-djson-fixture',
];
const DO_ROOMS = crlf(DO_ROOMS_LINES);
const DO_ROOMS_AFTER = DO_ROOMS.replace('      egpt: # the persona runs the station', '      don: # the persona runs the station');

// Exactly the shape src/rooms-file.mjs:38 warns about: `agents:` (the registry file) → `agent/wren:`
// (the row) → `agents:` (the per-being container) → `wren:` (the being). BOTH the row key and the
// inner key move.
const DO_AGENTS_LINES = [
  '# config/agents.yaml - do (fixture)',
  'agents:',
  '  agent/wren:',
  '    agents:',
  '      wren:',
  '        threadId: thread-agent-wren-fixture',
  '        threadCreatedAt: 2026-09-14T21:41:26.506Z',
  '        identityInjectedAt: 2026-09-16T02:08:54.971Z',
];
const DO_AGENTS = crlf(DO_AGENTS_LINES);
const DO_AGENTS_AFTER = DO_AGENTS.replace('  agent/wren:', '  agent/dren:').replace('      wren:', '      dren:');

// The room folder the being wakes in, as room-core's ensureTree builds it.
const ROOM = {
  'agents/wren/transcript.md': '# wren\r\n\r\nthe live transcript\r\n',
  'agents/wren/transcripts/2026-09-14.md': 'rolled\r\n',
  'agents/wren/media/note.ogg': 'audio',
  'agents/wren/files/dropped.txt': 'shelf',
  'agents/wren/directives/30-pointers.md': 'the card\r\n',
  'agents/wren/scripts/run.cmd': '@echo off\r\n',
  'agents/wren/identity.d/10-wren.md': 'I am wren\r\n',
};
const ROOM_ENTRIES = ['directives', 'files', 'identity.d', 'media', 'scripts', 'transcript.md', 'transcripts'];

// ── kg: nothing here answers to don / den / dren ─────────────────────────────────────────────────
const KG_LINES = [
  '# config.yaml - kg (fixture)',
  'node_name: kg',
  'agents:',
  '  egpt:',
  '    configuration: sonnet-default # config/agents/sonnet-default.yaml',
  '    handles: [ e, egpt ]',
  '    default: true',
  '    name: "E"',
  '',
  '  # the being whose HANDLE is `+` - the reason the handle->key map is explicit',
  '  eplus:',
  '    configuration: opus-high # config/agents/opus-high.yaml',
  '    personality: egpt',
  '    handles: [ "+", "e+" ]',
  '    name: "E+"',
  '',
  '  wren:',
  '    configuration: wren',
  '    handles: [ wren, w ]',
  '    scope: agent/wren # one wren node-wide: every chat resolves to the same thread',
  '',
  '  rodz:',
  '    configuration: sonnet-high',
  '    handles: [ rodz ]',
];
const KG = crlf(KG_LINES);
// kg has the same SHAPES in the same files - it is left alone because of the handles, not because
// there is nothing here to move.
const KG_CONV = crlf([
  'contacts:',
  '  whatsapp:',
  '    "120363000000000002@g.us":',
  '      slug: Reencuentro CRC',
  '      agents:',
  '        egpt:',
  '          threadId: thread-egpt-kg-fixture',
  '        eplus:',
  '          threadId: thread-eplus-kg-fixture',
  '  agent:',
  '    wren:',
  '      conversation_path: .egpt/agents/wren',
  '      home_dir: /c/Users/an',
]);
const KG_AGENTS = crlf([
  'agents:',
  '  agent/wren:',
  '    agents:',
  '      wren:',
  '        threadId: thread-agent-wren-kg-fixture',
]);

function home({ config = DO, conversations = DO_CONV, rooms = DO_ROOMS, agents = DO_AGENTS, room = ROOM } = {}) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0018-')), '.egpt');
  mkdirSync(join(h, 'config'), { recursive: true });
  for (const [name, text] of [['config.yaml', config], ['conversations.yaml', conversations], ['rooms.yaml', rooms], ['agents.yaml', agents]]) {
    if (text != null) writeFileSync(join(h, 'config', name), text);
  }
  for (const [rel, text] of Object.entries(room ?? {})) {
    mkdirSync(dirname(join(h, rel)), { recursive: true });
    writeFileSync(join(h, rel), text);
  }
  return h;
}
const cfgPath = (h) => join(h, 'config', 'config.yaml');
const convPath = (h) => join(h, 'config', 'conversations.yaml');
const roomsPath = (h) => join(h, 'config', 'rooms.yaml');
const agentsPath = (h) => join(h, 'config', 'agents.yaml');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0018-test`; writeFileSync(to, readFileSync(f)); return to; } });
const baks = (h) => readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-')).sort();

describe('0018 on do - the beings keyed egpt / ken / wren are the ones that answer to don / den / dren', () => {
  it('plans every move, naming each file, each key and the threadId that travels with it', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${cfgPath(h)}:${lineOf(DO_LINES, '  egpt:')}  agents.egpt -> agents.don  (the being that answers to \`don\`)`,
      '  -   egpt:',
      '  +   don:',
      `${cfgPath(h)}:${lineOf(DO_LINES, '  ken:')}  agents.ken -> agents.den  (the being that answers to \`den\`)`,
      '  -   ken:',
      '  +   den:',
      `${cfgPath(h)}:${lineOf(DO_LINES, '  wren:')}  agents.wren -> agents.dren  (the being that answers to \`dren\`)`,
      '  -   wren:',
      '  +   dren:',
      `${cfgPath(h)}:${lineOf(DO_LINES, '    scope: agent/wren # one wren node-wide: every chat resolves to the same thread')}  agents.dren.scope names the conversation that is moving`,
      '  -     scope: agent/wren # one wren node-wide: every chat resolves to the same thread',
      `  + ${SCOPE_AFTER}`,
      `${convPath(h)}:${lineOf(DO_CONV_LINES, '        egpt:')}  contacts.whatsapp.120363000000000001@g.us.agents.egpt -> don  (threadId thread-egpt-crc-fixture moves with the block)`,
      `${convPath(h)}:${lineOf(DO_CONV_LINES, '        ken: # the transcriptionist keeps its own thread in this chat')}  contacts.whatsapp.120363000000000001@g.us.agents.ken -> den  (threadId thread-ken-crc-fixture moves with the block)`,
      `${convPath(h)}:${lineOf(DO_CONV_LINES, '        egpt:', 2)}  contacts.whatsapp.1555@s.whatsapp.net.agents.egpt -> don  (threadId thread-egpt-rodz-fixture moves with the block)`,
      `${convPath(h)}:${lineOf(DO_CONV_LINES, '        egpt:', 3)}  contacts.shell.local.agents.egpt -> don  (threadId thread-egpt-shell-fixture moves with the block)`,
      `${convPath(h)}:${lineOf(DO_CONV_LINES, '        ken:')}  contacts.shell.local.agents.ken -> den  (threadId thread-ken-shell-fixture moves with the block)`,
      `${convPath(h)}:${lineOf(DO_CONV_LINES, '        wren:')}  contacts.shell.local.agents.wren -> dren  (threadId thread-wren-shell-fixture moves with the block)`,
      `${convPath(h)}:${lineOf(DO_CONV_LINES, '      conversation_path: .egpt/agents/wren')}  contacts.agent.wren.conversation_path follows the folder`,
      '  -       conversation_path: .egpt/agents/wren',
      '  +       conversation_path: .egpt/agents/dren',
      `${convPath(h)}:${lineOf(DO_CONV_LINES, '    wren:')}  contacts.agent.wren -> dren  (the agent-scope row: conversation_path, home_dir)`,
      `${roomsPath(h)}:${lineOf(DO_ROOMS_LINES, '      egpt: # the persona runs the station')}  rooms.room/radio.agents.egpt -> don  (threadId thread-egpt-radio-fixture moves with the block)`,
      `${agentsPath(h)}:${lineOf(DO_AGENTS_LINES, '      wren:')}  agents.agent/wren.agents.wren -> dren  (threadId thread-agent-wren-fixture moves with the block)`,
      `${agentsPath(h)}:${lineOf(DO_AGENTS_LINES, '  agent/wren:')}  agents.agent/wren -> agent/dren  (the agent-scope row of the registry)`,
      `move ${join(h, 'agents', 'wren')} -> ${join(h, 'agents', 'dren')}  (the room it wakes in, holding: ${ROOM_ENTRIES.join(', ')})`,
      'agents.egpt answers to `don`, so its key becomes `don` - every block above MOVES, none is recreated, and no thread is dropped',
      'agents.ken answers to `den`, so its key becomes `den` - every block above MOVES, none is recreated, and no thread is dropped',
      'agents.wren answers to `dren`, so its key becomes `dren` - every block above MOVES, none is recreated, and no thread is dropped',
      'backup first, beside each: <file>.bak-0018-<timestamp>  (the folder is renamed, not copied)',
    ]);
  });

  it('apply: every file is byte-identical apart from the moved keys - comments, CRLF and pi/djh untouched', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO_AFTER);
    expect(readFileSync(convPath(h), 'utf8')).toBe(DO_CONV_AFTER);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(DO_ROOMS_AFTER);
    expect(readFileSync(agentsPath(h), 'utf8')).toBe(DO_AGENTS_AFTER);
    // The operator's comments are still where they were, above and beside the beings that moved.
    const cfg = readFileSync(cfgPath(h), 'utf8');
    expect(cfg).toContain('  # handles. The operator calls it don.\r\n  don:\r\n');
    expect(cfg).toContain('    configuration: opus-xhigh # config/agents/opus-xhigh.yaml');
    expect(readFileSync(convPath(h), 'utf8')).toContain('        den: # the transcriptionist keeps its own thread in this chat');
    // Every backup holds the file as it was.
    expect(readFileSync(`${cfgPath(h)}.bak-0018-test`, 'utf8')).toBe(DO);
    expect(readFileSync(`${convPath(h)}.bak-0018-test`, 'utf8')).toBe(DO_CONV);
    expect(readFileSync(`${roomsPath(h)}.bak-0018-test`, 'utf8')).toBe(DO_ROOMS);
    expect(readFileSync(`${agentsPath(h)}.bak-0018-test`, 'utf8')).toBe(DO_AGENTS);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('apply: every threadId survives, in its new block - nothing is recreated', async () => {
    const h = home();
    await (await plan(ctxFor(h))).apply();
    const conv = YAML.parse(readFileSync(convPath(h), 'utf8'));
    const crc = conv.contacts.whatsapp['120363000000000001@g.us'].agents;
    expect(crc.don).toEqual({ threadId: 'thread-egpt-crc-fixture', threadCreatedAt: '2026-09-14T21:41:26.506Z' });
    expect(crc.den).toEqual({ threadId: 'thread-ken-crc-fixture' });
    expect(crc.egpt).toBeUndefined();
    expect(crc.ken).toBeUndefined();
    const rodz = conv.contacts.whatsapp['1555@s.whatsapp.net'].agents;
    expect(rodz.don).toEqual({ threadId: 'thread-egpt-rodz-fixture', identityInjectedAt: '2026-09-16T02:08:54.971Z' });
    expect(conv.contacts.shell.local.agents).toEqual({
      don: { threadId: 'thread-egpt-shell-fixture' },
      den: { threadId: 'thread-ken-shell-fixture' },
      dren: { threadId: 'thread-wren-shell-fixture' },
    });
    // The agent-scope row: renamed, repointed, and nothing else in it touched.
    expect(conv.contacts.agent).toEqual({ dren: { conversation_path: '.egpt/agents/dren', home_dir: '/c/Users/an' } });
    // The registry row and the per-being key inside it (src/rooms-file.mjs:38 - BOTH move).
    const reg = YAML.parse(readFileSync(agentsPath(h), 'utf8'));
    expect(Object.keys(reg.agents)).toEqual(['agent/dren']);
    expect(reg.agents['agent/dren'].agents).toEqual({
      dren: {
        threadId: 'thread-agent-wren-fixture',
        threadCreatedAt: '2026-09-14T21:41:26.506Z',
        identityInjectedAt: '2026-09-16T02:08:54.971Z',
      },
    });
  });

  it('apply: pi and djh are left exactly as they were, in every file', async () => {
    const h = home();
    await (await plan(ctxFor(h))).apply();
    const cfg = YAML.parse(readFileSync(cfgPath(h), 'utf8'));
    expect(Object.keys(cfg.agents)).toEqual(['don', 'den', 'dren', 'pi', 'djh']);
    expect(cfg.agents.pi).toEqual({ configuration: 'haiku-low', handles: ['pd'], name: 'Pd' });
    expect(cfg.agents.djh).toEqual({ configuration: 'haiku-low', handles: ['djh'], mode: 'off' });
    const conv = YAML.parse(readFileSync(convPath(h), 'utf8'));
    expect(conv.contacts.whatsapp['120363000000000001@g.us'].agents.pi).toEqual({ threadId: 'thread-pi-crc-fixture' });
    expect(conv.contacts.whatsapp['1555@s.whatsapp.net'].agents.djh).toEqual({ threadId: 'thread-djh-rodz-fixture' });
    const rooms = YAML.parse(readFileSync(roomsPath(h), 'utf8'));
    expect(rooms.rooms['room/radio'].agents.pi).toEqual({ threadId: 'thread-pi-radio-fixture' });
    expect(rooms.rooms['room/dj-son'].agents).toEqual({ pi: { threadId: 'thread-pi-djson-fixture' } });
  });

  it('apply: the room folder moves whole - the transcript, the rolled transcripts, and every shelf', async () => {
    const h = home();
    await (await plan(ctxFor(h))).apply();
    expect(readdirSync(join(h, 'agents'))).toEqual(['dren']);
    expect(readdirSync(join(h, 'agents', 'dren')).sort()).toEqual(ROOM_ENTRIES);
    expect(readFileSync(join(h, 'agents', 'dren', 'transcript.md'), 'utf8')).toBe(ROOM['agents/wren/transcript.md']);
    expect(readdirSync(join(h, 'agents', 'dren', 'transcripts'))).toEqual(['2026-09-14.md']);
    expect(readFileSync(join(h, 'agents', 'dren', 'identity.d', '10-wren.md'), 'utf8')).toBe('I am wren\r\n');
  });

  it('a node with no agents/<being> folder moves no folder, and the rest still lands', async () => {
    const h = home({ room: null });
    const p = await plan(ctxFor(h));
    expect(p.changes.some((c) => c.startsWith('move '))).toBe(false);
    await p.apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO_AFTER);
    expect(existsSync(join(h, 'agents'))).toBe(false);
  });

  it('a node that has only config.yaml is renamed there and nowhere else', async () => {
    const h = home({ conversations: null, rooms: null, agents: null, room: null });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO_AFTER);
    expect(readdirSync(join(h, 'config')).sort()).toEqual(['config.yaml', 'config.yaml.bak-0018-test']);
  });

  it('the scope line keeps its shape when it carries no comment to rewrite', async () => {
    const bare = DO.replace('    scope: agent/wren # one wren node-wide: every chat resolves to the same thread', '    scope: agent/wren');
    const h = home({ config: bare });
    await (await plan(ctxFor(h))).apply();
    const out = readFileSync(cfgPath(h), 'utf8');
    expect(out).toContain('    scope: agent/dren\r\n');
    expect(out).not.toContain('0018 - the scope names the being');
  });

  it('a being pinned to ANOTHER moved being\'s scope follows it too', async () => {
    const pinned = DO.replace('    handles: [ pd ]', '    handles: [ pd ]\r\n    scope: agent/wren');
    const h = home({ config: pinned });
    await (await plan(ctxFor(h))).apply();
    const cfg = YAML.parse(readFileSync(cfgPath(h), 'utf8'));
    expect(cfg.agents.pi.scope).toBe('agent/dren');   // pi's KEY is untouched; the room it points at moved
    expect(cfg.agents.dren.scope).toBe('agent/dren');
  });
});

describe('0018 is satisfied where it has nothing to do', () => {
  it('kg: no being answers to don, den or dren - and nothing is written', async () => {
    const h = home({ config: KG, conversations: KG_CONV, rooms: null, agents: KG_AGENTS, room: null });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([
      `no being in ${cfgPath(h)} answers to \`don\``,
      `no being in ${cfgPath(h)} answers to \`den\``,
      `no being in ${cfgPath(h)} answers to \`dren\``,
    ]);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
    expect(readFileSync(convPath(h), 'utf8')).toBe(KG_CONV);
    expect(readFileSync(agentsPath(h), 'utf8')).toBe(KG_AGENTS);
    expect(baks(h)).toEqual([]);
  });

  it('kg: `eplus` (handle `+`) is not renamed - the map is explicit, never "the first handle"', async () => {
    const h = home({ config: KG, conversations: KG_CONV, rooms: null, agents: KG_AGENTS, room: null });
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
    const cfg = YAML.parse(readFileSync(cfgPath(h), 'utf8'));
    expect(Object.keys(cfg.agents)).toEqual(['egpt', 'eplus', 'wren', 'rodz']);
    expect(cfg.agents.eplus.handles).toEqual(['+', 'e+']);
    expect(cfg.agents['+']).toBeUndefined();
    // kg's own wren keeps its key and its scope: nothing there answers to `dren`.
    expect(cfg.agents.wren.scope).toBe('agent/wren');
    expect(Object.keys(YAML.parse(readFileSync(agentsPath(h), 'utf8')).agents)).toEqual(['agent/wren']);
  });

  it('do, already applied: every being is keyed by its own handle', async () => {
    const h = home({ config: DO_AFTER, conversations: DO_CONV_AFTER, rooms: DO_ROOMS_AFTER, agents: DO_AGENTS_AFTER, room: null });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([
      `agents.don answers to \`don\` and is already keyed by it`,
      `agents.den answers to \`den\` and is already keyed by it`,
      `agents.dren answers to \`dren\` and is already keyed by it`,
    ]);
    expect(baks(h)).toEqual([]);
  });

  it('half a node is finished, not refused: a config.yaml already renamed leaves the rest alone', async () => {
    // The key is the being-id, so once config.yaml says `don` there is no `egpt` being to look for.
    const h = home({ config: DO_AFTER });
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
  });

  it('a node with no `agents:` mapping at all', async () => {
    const h = home({ config: 'node_name: zz\n', conversations: null, rooms: null, agents: null, room: null });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`${cfgPath(h)} has no \`agents:\` mapping, so no being here answers to \`don\`, \`den\`, \`dren\``);
  });
});

describe('0018 refuses, naming the place', () => {
  it('two beings answer to one handle', async () => {
    const two = DO.replace('  djh:', '  other:\r\n    handles: [ den, dd ]\r\n\r\n  djh:');
    const h = home({ config: two });
    await expect(plan(ctxFor(h))).rejects
      .toThrow(/0018 refuses: 2 beings in .* answer to `den` \(ken, other\) - which one takes the key `den` is a human decision, not a guess/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(two);
    expect(readFileSync(convPath(h), 'utf8')).toBe(DO_CONV);
  });

  it('one being answers to two of them', async () => {
    // ken stops answering to `den`, so the only being left answering to it is the one that also
    // answers to `dren` - which key that being takes is the human decision here.
    const both = DO.replace('    handles: [ den ]', '    handles: [ ken ]').replace('    handles: [ dren ]', '    handles: [ dren, den ]');
    const h = home({ config: both });
    await expect(plan(ctxFor(h))).rejects
      .toThrow(/0018 refuses: agents\.wren answers to both `den` and `dren`/);
  });

  it('the target key is already held by a DIFFERENT being', async () => {
    const taken = DO.replace('  pi:', '  don:\r\n    configuration: haiku-low\r\n    handles: [ nope ]\r\n\r\n  pi:');
    const h = home({ config: taken });
    await expect(plan(ctxFor(h))).rejects
      .toThrow(/0018 refuses: agents\.egpt answers to `don`, but .* already has a DIFFERENT being keyed `don` \(handles \[ nope \]\)/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(taken);
  });

  it('a per-being block whose target key is already taken in the same container', async () => {
    const clash = DO_CONV.replace('        pi:\r\n          threadId: thread-pi-crc-fixture', '        don:\r\n          threadId: thread-someone-else-fixture');
    const h = home({ conversations: clash });
    await expect(plan(ctxFor(h))).rejects
      .toThrow(/0018 refuses: moving contacts\.whatsapp\.120363000000000001@g\.us\.agents\.egpt to `don` in .*conversations\.yaml: .*already has a key "don"/);
    expect(readFileSync(convPath(h), 'utf8')).toBe(clash);
  });

  it('a registry file that does not parse', async () => {
    const h = home({ rooms: 'rooms: [ broken\n' });
    await expect(plan(ctxFor(h))).rejects
      .toThrow(/0018 refuses: [\s\S]*rooms\.yaml does not parse [\s\S]*, so whether it holds a being block cannot be read/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO);
  });

  it('a config.yaml that does not parse, and one that is not there', async () => {
    const h = home({ config: 'agents: [ broken\n' });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0018 refuses: .*config\.yaml does not parse/);
    const empty = home({ config: null, conversations: null, rooms: null, agents: null, room: null });
    await expect(plan(ctxFor(empty))).rejects.toThrow(/0018 refuses: there is no .*config\.yaml/);
  });

  it('the destination room folder already exists', async () => {
    const h = home({ room: { ...ROOM, 'agents/dren/transcript.md': '# someone else\r\n' } });
    await expect(plan(ctxFor(h))).rejects
      .toThrow(/0018 refuses: .*agents[\\/]dren already exists, so .*agents[\\/]wren cannot move onto it - which of the two is this being's room is a human decision/);
    expect(readdirSync(join(h, 'agents')).sort()).toEqual(['dren', 'wren']);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO);
  });

  it('the agent-scope row names the being somewhere this migration was not told about', async () => {
    const extra = DO_CONV.replace('      home_dir: /c/Users/an', '      home_dir: /c/Users/an\r\n      slug: wren');
    const h = home({ conversations: extra });
    await expect(plan(ctxFor(h))).rejects
      .toThrow(/0018 refuses: contacts\.agent\.wren\.slug is "wren" in .* - it names the being by its old key/);
  });

  it('an agent-scope row whose conversation_path does not end in the old key', async () => {
    const odd = DO_CONV.replace('      conversation_path: .egpt/agents/wren', '      conversation_path: .egpt/agents/wren-old');
    const h = home({ conversations: odd });
    await expect(plan(ctxFor(h))).rejects
      .toThrow(/0018 refuses: contacts\.agent\.wren\.conversation_path is "\.egpt\/agents\/wren-old" in .*, which does not end in `\/wren`/);
  });

  it('a file changed between plan and apply: nothing is written and nothing is moved', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    const edited = DO_CONV.replace('      slug: rodz', '      slug: rodz2');
    writeFileSync(convPath(h), edited);
    await expect(p.apply()).rejects.toThrow(/0018 refuses: .*conversations\.yaml changed since it was planned - re-run/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO);
    expect(readFileSync(convPath(h), 'utf8')).toBe(edited);
    expect(readdirSync(join(h, 'agents'))).toEqual(['wren']);
    expect(baks(h)).toEqual([]);
  });

  it('the destination folder appeared between plan and apply', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    mkdirSync(join(h, 'agents', 'dren'), { recursive: true });
    await expect(p.apply()).rejects.toThrow(/0018 refuses: .*agents[\\/]dren appeared since it was planned - re-run/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO);
    expect(baks(h)).toEqual([]);
  });
});

describe('0018 through the runner', () => {
  // The Windows probes of 0001/0002/0004/0005 are told "nothing there", and localAddresses is empty
  // so 0007 reads nothing as this node's own (as tests/migrations-0008-* and -0016-*).
  const ctx = { ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }), localAddresses: new Set() };
  const dir = join(import.meta.dirname, '..', 'migrations');
  // 0025 runs LAST in this chain and states an `access_level:` on every being that declares none,
  // so the live config.yaml is no longer the end state THIS migration is about. Its BACKUP is:
  // ctx.backup copies the file the instant before 0025 writes it, which is exactly what the chain
  // up to 0024 left behind - so the byte-for-byte assertions below are unchanged.
  const upTo0024 = (h) => {
    const d = join(h, 'config');
    return readFileSync(join(d, readdirSync(d).find((f) => f.startsWith('config.yaml.bak-0025-'))), 'utf8');
  };
  const ledger = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'))['0018-keys-follow-handles'].outcome;

  it('do: applied and recorded, every file moved and backed up, the folder renamed', async () => {
    const h = home();
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('applied');
    // 0020 runs later in the same chain and hands the being answering `don` the `rodz` handle -
    // not 0018's doing, and the only difference between 0018's own end state and what 0025 found.
    expect(upTo0024(h)).toBe(DO_AFTER.replace('[ d, don ]', '[ d, don, rodz ]'));
    expect(readFileSync(convPath(h), 'utf8')).toBe(DO_CONV_AFTER);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(DO_ROOMS_AFTER);
    expect(readFileSync(agentsPath(h), 'utf8')).toBe(DO_AGENTS_AFTER);
    expect(readdirSync(join(h, 'agents'))).toEqual(['dren']);
    for (const f of ['config.yaml', 'conversations.yaml', 'rooms.yaml', 'agents.yaml']) {
      expect(readdirSync(join(h, 'config')).filter((b) => b.startsWith(`${f}.bak-0018-`))).toHaveLength(1);
    }
  });

  it('kg: recorded as already satisfied, nothing touched, no backup', async () => {
    const h = home({ config: KG, conversations: KG_CONV, rooms: null, agents: KG_AGENTS, room: null });
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('already-satisfied');
    // 0020 runs later and evicts kg's `rodz` being - the mouth is an account, not a being - which
    // is the last block of this fixture (the blank line above it stays - a removal takes the key's
    // own lines, not its neighbour's). Everything else kg has is untouched by the whole chain, and
    // 0018 itself left no backup.
    expect(upTo0024(h)).toBe(crlf(KG_LINES.slice(0, -3)));
    expect(readFileSync(convPath(h), 'utf8')).toBe(KG_CONV);
    expect(readFileSync(agentsPath(h), 'utf8')).toBe(KG_AGENTS);
    expect(baks(h).filter((f) => f.includes('.bak-0018-'))).toEqual([]);
  });
});
