// tests/migrations-0022-a-room-that-carries-every-chat-compacts-sooner.test.mjs —
// migrations/0022-a-room-that-carries-every-chat-compacts-sooner.mjs.
//
// ONE ruling: a room several chats are invited into answers them all from ONE thread, so it must
// compact at half the window rather than at the node's ratio — before brainpool's overflow
// backstop RESETS that thread to a fresh session.
//
// THE FIXTURES ARE MINIATURES OF REAL STATE, in temp dirs, and every one of them is a node that
// every EARLIER migration has nothing left to do on (the runner describe at the bottom proves
// exactly that — a fixture an earlier migration acts on fails these tests for the wrong reason,
// which is how the 0003, 0010, 0018, 0019 and 0021 fixtures broke in turn). The config.yaml is kg
// as it reads AFTER 0021, and it carries wren's OWN `compaction.ratio: 0.50` — the being-level
// half of this same pin, so the two halves sit side by side in one fixture.
//
// The assertions are on the FULL text, never a re-parse: the comments beside these rows and every
// other byte are what the splice layer exists to protect. CRLF throughout, as the live files are.
//
// AND ONE TEST DOES NOT READ THE FILE AT ALL — it drives the node's own readState/getBeing over
// the edited profile, so what is written is proved to be what src/spine/brainpool.mjs's resolveConv
// hands src/spine/compaction.mjs as this conversation's `compaction` override. That is the whole
// question this migration had to answer before it wrote anything.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { plan } from '../migrations/0022-a-room-that-carries-every-chat-compacts-sooner.mjs';
import { runMigrations } from '../setup/migrate.mjs';
import { readState, getBeing } from '../src/conversations-state.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');

// ── what the migration writes, at the two columns it writes it at ────────────────────────────
const BLOCK = (pad) => [
  `${pad}# THIS ROOM CARRIES EVERY CHAT INVITED INTO IT (0022, operator 2026-09-14: "overshooting`,
  `${pad}# is not compacted late, it is lost: the overflow backstop resets the thread"). A chat`,
  `${pad}# joined here as a \`wa-group\` member resolves to THIS conversation - one being, one thread,`,
  `${pad}# one warm session (src/spine/identity-scope.mjs) - so this thread fills a window far`,
  `${pad}# faster than any single chat does. That is the case the per-conversation override in`,
  `${pad}# src/spine/compaction.mjs exists for: compact at HALF the window instead of the node's`,
  `${pad}# ratio, so the thread is trimmed well before brainpool's overflow backstop can RESET it.`,
  `${pad}compaction:`,
  `${pad}  ratio: 0.50`,
];
const RATIO_ONLY = (pad) => [
  `${pad}# HALF THE WINDOW, NOT THE NODE'S RATIO (0022, operator 2026-09-14). A chat joined this`,
  `${pad}# room as a \`wa-group\` member resolves to THIS conversation's one thread`,
  `${pad}# (src/spine/identity-scope.mjs), so it is trimmed well before brainpool's overflow`,
  `${pad}# backstop can RESET it to a fresh session - overshooting is not compacted late, it is lost.`,
  `${pad}ratio: 0.50`,
];
const IN_BEING = BLOCK('        ');          // a being block's own keys sit at column 8
const IN_COMPACTION = RATIO_ONLY('          ');  // an existing `compaction:` block's, at 10

// ── kg's config.yaml as it reads after 0021, so nothing earlier has anything to do ───────────
const OPERATOR = '[ "16468217865", "34836563681438", "@anrodriguez:beeper.com" ]';
const DRIVEN = '[ "16468217865", "34836563681438", "@anrodriguez:beeper.com", "@dolly-egpt:beeper.com" ]';
const KG_CONFIG = crlf([
  '# config.yaml - kg (fixture)',
  'node_name: kg',
  'agents:',
  '  egpt:',
  '    configuration: sonnet-default # config/agents/sonnet-default.yaml',
  '    handles: [ e, egpt, ekg ]',
  '    default: true',
  '    name: "E"',
  '    conversation_defaults:',
  '      access_level: sandbox',
  `      allowed_users: ${OPERATOR} # who may wake E`,
  '',
  '  wren:',
  '    configuration: sonnet-high # config/agents/sonnet-high.yaml',
  '    personality: wren # config/agents/identities/wren.md',
  '    handles: [ wren, w ]',
  '    name: "Wren"',
  '    scope: agent/wren # one agent/wren node-wide',
  '    sandboxed: false',
  '    conversation_defaults:',
  '      access_level: all',
  `      allowed_users: ${DRIVEN} # who may drive this being`,
  '      # LOWER THRESHOLD THAN THE NODE (operator 2026-09-14). This being is ONE THREAD carrying',
  '      # every chat it is addressed in, so it fills a window far faster than any single chat does.',
  '      compaction:',
  '        ratio: 0.50',
  '',
  '  codex:',
  '    configuration: codex',
  '    handles: [ codex ]',
  'compaction:',
  '  ratio: 0.80 # the node default the rooms below are too busy for',
  '  cooling_ms: 600000',
]);

// ── kg's config/rooms.yaml: three rooms, and only the middle one is a tunnel ──────────────────
const KG_ROOMS_LINES = [
  '# rooms.yaml - kg (fixture)',
  'rooms:',
  '  # the lobby - nobody was ever invited in, so it is one chat like any other',
  '  room/lobby:',
  '    agents:',
  '      egpt:',
  '        threadId: 9d1e-fixture',
  '        threadCreatedAt: "2026-09-16T10:00:00.000Z"',
  '',
  '  # acim - a WhatsApp group was invited in as a member (operator 2026-08-31)',
  '  room/acim:',
  '    members:',
  '      - id: "120363000000000001@g.us" # perrito traducciones',
  '        kind: wa-group',
  '        state: active',
  '    agents:',
  '      egpt:',
  '        access_level: all',
  '        threadId: 892d0ee4-fixture',
  '        identityInjectedAt: "2026-09-20T10:00:01.000Z"',
  '',
  '  # radio - a room with no members list at all',
  '  room/radio:',
  '    agents:',
  '      egpt:',
  '        threadId: 85937f93-fixture',
];
const KG_ROOMS = crlf(KG_ROOMS_LINES);
// The insert lands at the end of room/acim's `egpt:` block — the blank line after it describes
// what comes NEXT and stays where it is.
const ACIM_AT = KG_ROOMS_LINES.indexOf('        identityInjectedAt: "2026-09-20T10:00:01.000Z"') + 1;
const KG_ROOMS_AFTER = crlf([
  ...KG_ROOMS_LINES.slice(0, ACIM_AT),
  ...IN_BEING,
  ...KG_ROOMS_LINES.slice(ACIM_AT),
]);

// The room rows, as ensureContact mints them on surface `room` (slug = the room's name).
const KG_CONV = crlf([
  'contacts:',
  '  room:',
  '    lobby:',
  '      slug: lobby',
  '      conversation_path: .egpt/conversations/room/lobby',
  '    acim:',
  '      slug: acim',
  '      conversation_path: .egpt/conversations/room/acim',
  '    radio:',
  '      slug: radio',
  '      conversation_path: .egpt/conversations/room/radio',
]);

// The type files the `configuration:` lines name. None pins a `cwd:`, so 0014 has nothing to move.
const TYPES = {
  'sonnet-default': 'type: ccode\nmodel: sonnet\neffort: high\n',
  'sonnet-high': 'type: ccode\nmodel: sonnet\neffort: high\n',
};
const IDENTITIES = { wren: '# I am Wren\n' };

// `.egpt` nested inside the temp dir, so `<parent>/src` does not exist and 0015 stays satisfied.
function home({ rooms = KG_ROOMS, config = KG_CONFIG, conversations = KG_CONV } = {}) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0022-')), '.egpt');
  mkdirSync(join(h, 'config', 'agents', 'identities'), { recursive: true });
  if (config !== null) writeFileSync(join(h, 'config', 'config.yaml'), config);
  if (rooms !== null) writeFileSync(join(h, 'config', 'rooms.yaml'), rooms);
  if (conversations !== null) writeFileSync(join(h, 'config', 'conversations.yaml'), conversations);
  for (const [name, text] of Object.entries(TYPES)) writeFileSync(join(h, 'config', 'agents', `${name}.yaml`), text);
  for (const [name, text] of Object.entries(IDENTITIES)) writeFileSync(join(h, 'config', 'agents', 'identities', `${name}.md`), text);
  return h;
}
const roomsPath = (h) => join(h, 'config', 'rooms.yaml');
const convPath = (h) => join(h, 'config', 'conversations.yaml');
const cfgPath = (h) => join(h, 'config', 'config.yaml');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0022-test`; writeFileSync(to, readFileSync(f)); return to; } });
const baks = (h) => readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-'));
const rows = (h) => YAML.parse(readFileSync(roomsPath(h), 'utf8')).rooms;

describe('0022 on kg - room/acim carries every chat, so it compacts at half the window', () => {
  it('plans the insert, naming the room, the being and why', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${roomsPath(h)}:${ACIM_AT + 1}-${ACIM_AT + IN_BEING.length}  insert rooms.room/acim.agents.egpt.compaction (${IN_BEING.length} lines):`,
      ...IN_BEING.map((l) => `  + ${l}`),
      'room/acim carries every chat of 1 `wa-group` member on one thread - `egpt` compacts at 0.50 of the window here '
        + "instead of this node's ratio, so the thread is trimmed before the overflow backstop resets it",
      'backup first, beside it: <file>.bak-0022-<timestamp>',
    ]);
  });

  it('apply: room/acim gains the block and every other byte - the other two rooms, the comments, the CRLF - is untouched', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(KG_ROOMS_AFTER);
    expect(rows(h)['room/acim'].agents.egpt.compaction).toEqual({ ratio: 0.5 });
    // The thread and the access level it sat beside are still there, in the same block.
    expect(rows(h)['room/acim'].agents.egpt.threadId).toBe('892d0ee4-fixture');
    expect(rows(h)['room/acim'].agents.egpt.access_level).toBe('all');
    expect(readFileSync(`${roomsPath(h)}.bak-0022-test`, 'utf8')).toBe(KG_ROOMS);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('a room with NO wa-group member is not touched, though its being block reads the same way', async () => {
    const h = home();
    await (await plan(ctxFor(h))).apply();
    const after = readFileSync(roomsPath(h), 'utf8');
    expect(rows(h)['room/lobby'].agents.egpt).toEqual({ threadId: '9d1e-fixture', threadCreatedAt: '2026-09-16T10:00:00.000Z' });
    expect(rows(h)['room/radio'].agents.egpt).toEqual({ threadId: '85937f93-fixture' });
    // Comments preserved byte for byte on the rows nothing was written into.
    expect(after).toContain('  # the lobby - nobody was ever invited in, so it is one chat like any other\r\n');
    expect(after).toContain('  # radio - a room with no members list at all\r\n');
    expect(after).toContain('      - id: "120363000000000001@g.us" # perrito traducciones\r\n');
    expect(after.match(/compaction:/g)).toHaveLength(1);       // exactly one room compacts sooner
    // config.yaml is not this migration's file and is not opened for writing.
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG_CONFIG);
  });

  // THE EVIDENCE TEST. Not "is the key in the file" but "does the node READ it": the same
  // readState/getBeing pair boot.mjs hands brainpool, whose resolveConv passes exactly this
  // object to compaction.mjs's afterTurn as the per-conversation override.
  it('the node READS it: getBeing on surface `room` hands back the override compaction.mjs applies', async () => {
    const h = home();
    const before = getBeing(await readState(convPath(h)), 'room', 'acim', 'egpt');
    expect(before.compaction).toBeNull();                       // nothing stated: the node ratio applies

    await (await plan(ctxFor(h))).apply();

    const after = getBeing(await readState(convPath(h)), 'room', 'acim', 'egpt');
    expect(after.compaction).toEqual({ ratio: 0.5 });
    expect(after.threadId).toBe('892d0ee4-fixture');            // the thread it protects is still there
    // …and the room that is not a tunnel still states nothing, so it keeps the node's ratio.
    expect(getBeing(await readState(convPath(h)), 'room', 'lobby', 'egpt').compaction).toBeNull();
  });
});

describe('0022: more than one qualifying room is not a refusal - they all have the same defect', () => {
  // Two tunnels and one ordinary room. Both tunnels are edited and both are named; there is
  // nothing to choose between them, unlike 0021's two-pinned-engineers case.
  const TWO_LINES = [
    'rooms:',
    '  room/acim:',
    '    members:',
    '      - id: "120363000000000001@g.us"',
    '        kind: wa-group',
    '    agents:',
    '      egpt:',
    '        threadId: aaa-fixture',
    '  room/lobby:',
    '    agents:',
    '      egpt:',
    '        threadId: bbb-fixture',
    '  room/otra:',
    '    members:',
    '      - id: "120363000000000002@g.us"',
    '        kind: wa-group',
    '      - id: "120363000000000003@g.us"',
    '        kind: wa-group',
    '    agents:',
    '      egpt:',
    '        threadId: ccc-fixture',
  ];
  const TWO = crlf(TWO_LINES);
  const FIRST_AT = TWO_LINES.indexOf('        threadId: aaa-fixture') + 1;
  const SECOND_AT = TWO_LINES.indexOf('        threadId: ccc-fixture') + 1 + IN_BEING.length;  // the first insert moved it
  const TWO_AFTER = crlf([
    ...TWO_LINES.slice(0, TWO_LINES.indexOf('        threadId: aaa-fixture') + 1),
    ...IN_BEING,
    ...TWO_LINES.slice(TWO_LINES.indexOf('        threadId: aaa-fixture') + 1, TWO_LINES.indexOf('        threadId: ccc-fixture') + 1),
    ...IN_BEING,
    ...TWO_LINES.slice(TWO_LINES.indexOf('        threadId: ccc-fixture') + 1),
  ]);

  it('both are edited, both are named, and the plan line numbers are the file as it will read', async () => {
    const h = home({ rooms: TWO });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${roomsPath(h)}:${FIRST_AT + 1}-${FIRST_AT + IN_BEING.length}  insert rooms.room/acim.agents.egpt.compaction (${IN_BEING.length} lines):`,
      ...IN_BEING.map((l) => `  + ${l}`),
      `${roomsPath(h)}:${SECOND_AT + 1}-${SECOND_AT + IN_BEING.length}  insert rooms.room/otra.agents.egpt.compaction (${IN_BEING.length} lines):`,
      ...IN_BEING.map((l) => `  + ${l}`),
      'room/acim carries every chat of 1 `wa-group` member on one thread - `egpt` compacts at 0.50 of the window here '
        + "instead of this node's ratio, so the thread is trimmed before the overflow backstop resets it",
      'room/otra carries every chat of 2 `wa-group` members on one thread - `egpt` compacts at 0.50 of the window here '
        + "instead of this node's ratio, so the thread is trimmed before the overflow backstop resets it",
      'backup first, beside it: <file>.bak-0022-<timestamp>',
    ]);
    await p.apply();
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(TWO_AFTER);
    expect(rows(h)['room/acim'].agents.egpt.compaction).toEqual({ ratio: 0.5 });
    expect(rows(h)['room/otra'].agents.egpt.compaction).toEqual({ ratio: 0.5 });
    expect(rows(h)['room/lobby'].agents.egpt).toEqual({ threadId: 'bbb-fixture' });
  });

  // Several residents of one room: each has its own thread there and each answers the same
  // tunnelled chats on it, so each gets the override — the rung is per being because the READER is.
  it('every being resident in the room gets it, and each is named', async () => {
    const many = crlf([
      'rooms:',
      '  room/acim:',
      '    members:',
      '      - id: "120363000000000001@g.us"',
      '        kind: wa-group',
      '    agents:',
      '      egpt:',
      '        threadId: aaa-fixture',
      '      wren:',
      '        threadId: bbb-fixture',
    ]);
    const h = home({ rooms: many });
    const p = await plan(ctxFor(h));
    expect(p.changes.filter((l) => l.includes('  insert '))).toEqual([
      `${roomsPath(h)}:9-${8 + IN_BEING.length}  insert rooms.room/acim.agents.egpt.compaction (${IN_BEING.length} lines):`,
      `${roomsPath(h)}:${11 + IN_BEING.length}-${10 + 2 * IN_BEING.length}  insert rooms.room/acim.agents.wren.compaction (${IN_BEING.length} lines):`,
    ]);
    expect(p.changes).toContain(
      'room/acim carries every chat of 1 `wa-group` member on one thread - `egpt`, `wren` compact at 0.50 of the window here '
        + "instead of this node's ratio, so the thread is trimmed before the overflow backstop resets it",
    );
    await p.apply();
    expect(rows(h)['room/acim'].agents.egpt).toEqual({ threadId: 'aaa-fixture', compaction: { ratio: 0.5 } });
    expect(rows(h)['room/acim'].agents.wren).toEqual({ threadId: 'bbb-fixture', compaction: { ratio: 0.5 } });
  });
});

describe('0022: a `compaction:` block that states everything but the ratio gets the one line', () => {
  const PARTIAL_LINES = [
    'rooms:',
    '  room/acim:',
    '    members:',
    '      - id: "120363000000000001@g.us"',
    '        kind: wa-group',
    '    agents:',
    '      egpt:',
    '        threadId: aaa-fixture',
    '        compaction:',
    '          cooling_ms: 120000 # this room goes quiet less often than the node assumes',
  ];
  const PARTIAL = crlf(PARTIAL_LINES);

  it('inserts `ratio:` INTO the existing block, keeping its other key and its comment', async () => {
    const h = home({ rooms: PARTIAL });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes[0]).toBe(
      `${roomsPath(h)}:${PARTIAL_LINES.length + 1}-${PARTIAL_LINES.length + IN_COMPACTION.length}  insert rooms.room/acim.agents.egpt.compaction.ratio (${IN_COMPACTION.length} lines):`,
    );
    await p.apply();
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(crlf([...PARTIAL_LINES, ...IN_COMPACTION]));
    expect(rows(h)['room/acim'].agents.egpt.compaction).toEqual({ cooling_ms: 120000, ratio: 0.5 });
    expect(readFileSync(roomsPath(h), 'utf8')).toContain('          cooling_ms: 120000 # this room goes quiet less often than the node assumes\r\n');
  });
});

describe('0022: "nothing to do here" is a note, never a refusal', () => {
  it('already applied: satisfied, naming the room, and nothing is written', async () => {
    const h = home({ rooms: KG_ROOMS_AFTER });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([
      `1 room in ${roomsPath(h)} carries a \`wa-group\` member (room/acim), and no being block there is left to give a \`compaction.ratio\``,
      `rooms.room/acim.agents.egpt.compaction.ratio in ${roomsPath(h)} already reads 0.5 - this conversation already states its own threshold and is left alone`,
    ]);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(KG_ROOMS_AFTER);
    expect(baks(h)).toEqual([]);
  });

  // A hand-set ratio is somebody's decision, whatever it says. This does not overwrite one.
  it('a ratio already stated at some OTHER number is left exactly as it is', async () => {
    const other = KG_ROOMS_AFTER.replace('          ratio: 0.50\r\n', '          ratio: 0.35 # tighter still\r\n');
    const h = home({ rooms: other });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[1]).toContain('already reads 0.35');
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(other);
  });

  it('no config/rooms.yaml at all: a node with no rooms owes nothing here', async () => {
    const h = home({ rooms: null });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([`there is no ${roomsPath(h)}, so this node has no rooms and none of them carries every chat`]);
    expect(existsSync(roomsPath(h))).toBe(false);
  });

  it('an empty rooms.yaml, and one with rooms but no wa-group member anywhere', async () => {
    const empty = home({ rooms: '' });
    expect((await plan(ctxFor(empty))).notes[0]).toContain('holds no room rows');

    const h = home({ rooms: crlf(['rooms:', '  room/lobby:', '    agents:', '      egpt:', '        threadId: aaa']) });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([`no room in ${roomsPath(h)} carries a \`wa-group\` member, so no conversation here answers every chat from one thread`]);
  });

  // `wa-group` is ONE of src/room-core.mjs's ROOM_MEMBER_KINDS. A room whose members are brains or
  // shells is not a tunnel between chats and is not what this is about.
  it('a room whose members are of some OTHER kind is not a tunnel', async () => {
    const h = home({ rooms: crlf([
      'rooms:',
      '  room/dj-son:',
      '    members:',
      '      - id: egpt',
      '        kind: brain',
      '      - id: console',
      '        kind: shell',
      '    agents:',
      '      egpt:',
      '        threadId: aaa',
    ]) });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toContain('carries a `wa-group` member');
    expect(readFileSync(roomsPath(h), 'utf8')).not.toContain('compaction');
  });

  it('a qualifying room with no per-being `agents:` block: there is no thread there to protect', async () => {
    const h = home({ rooms: crlf([
      'rooms:',
      '  room/acim:',
      '    members:',
      '      - id: "120363000000000001@g.us"',
      '        kind: wa-group',
      '    heartbeats:',
      '      alive: true',
    ]) });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[1]).toBe(
      `rooms.room/acim carries 1 \`wa-group\` member but has no per-being \`agents:\` block in ${roomsPath(h)} `
        + '- no being has taken a turn there yet, so there is no thread here to protect and inventing a block for one would be a guess',
    );
    expect(readFileSync(roomsPath(h), 'utf8')).not.toContain('compaction');
  });

  // rooms.yaml also carries `shell/…` and `whatsapp/…` rows (src/rooms-file.mjs), and
  // mergeRoomBeings hydrates a ROOM's per-being block only from a `room/<slug>` key.
  it('a wa-group member on a row that is not keyed `room/<slug>` is named, never edited', async () => {
    const h = home({ rooms: crlf([
      'rooms:',
      '  whatsapp/some-group:',
      '    members:',
      '      - id: "120363000000000001@g.us"',
      '        kind: wa-group',
      '    agents:',
      '      egpt:',
      '        threadId: aaa',
    ]) });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([
      `no room in ${roomsPath(h)} carries a \`wa-group\` member, so no conversation here answers every chat from one thread`,
      `whatsapp/some-group in ${roomsPath(h)} carries 1 \`wa-group\` member but is not keyed \`room/<slug>\`, `
        + 'so no room\'s per-being block is backed by it - left alone',
    ]);
    expect(readFileSync(roomsPath(h), 'utf8')).not.toContain('compaction');
  });

  it('a `members:` that is not a list is named rather than guessed at', async () => {
    const h = home({ rooms: crlf([
      'rooms:',
      '  room/acim:',
      '    members: "120363000000000001@g.us"',
      '    agents:',
      '      egpt:',
      '        threadId: aaa',
    ]) });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[1]).toContain('has a `members:` that is "120363000000000001@g.us", not a list');
  });
});

describe('0022 refuses, naming the place, only on what it cannot honestly edit', () => {
  it('a rooms.yaml that does not parse', async () => {
    const h = home({ rooms: 'rooms: [ broken\n' });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0022 refuses: .*rooms\.yaml does not parse/);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe('rooms: [ broken\n');
  });

  it('a rooms.yaml that is not valid UTF-8 - a splice would re-encode bytes it never meant to touch', async () => {
    const h = home({ rooms: null });
    writeFileSync(roomsPath(h), Buffer.from([0x72, 0x6f, 0x6f, 0x6d, 0x73, 0x3a, 0x20, 0xff, 0x0a]));
    await expect(plan(ctxFor(h))).rejects.toThrow(/0022 refuses: .*rooms\.yaml is not valid UTF-8/);
  });

  it('a `compaction:` that is a SCALAR - this will not guess what a hand edit meant', async () => {
    const scalar = crlf([
      'rooms:',
      '  room/acim:',
      '    members:',
      '      - id: "120363000000000001@g.us"',
      '        kind: wa-group',
      '    agents:',
      '      egpt:',
      '        threadId: aaa',
      '        compaction: 0.5',
    ]);
    const h = home({ rooms: scalar });
    await expect(plan(ctxFor(h))).rejects.toThrow(
      /0022 refuses: `compaction:` at rooms\.room\/acim\.agents\.egpt in .*rooms\.yaml is 0\.5, not a mapping - src\/spine\/compaction\.mjs reads a block of `enabled`\/`ratio`\/`cooling_ms`\/`context_window` there/,
    );
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(scalar);
  });

  it('a bare `compaction:` with nothing under it is not a mapping either', async () => {
    const bare = crlf([
      'rooms:',
      '  room/acim:',
      '    members:',
      '      - id: "120363000000000001@g.us"',
      '        kind: wa-group',
      '    agents:',
      '      egpt:',
      '        threadId: aaa',
      '        compaction:',
    ]);
    const h = home({ rooms: bare });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0022 refuses: `compaction:` at rooms\.room\/acim\.agents\.egpt in .*is null, not a mapping/);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(bare);
  });

  it('a file edited between plan and apply, and nothing is written', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    const edited = KG_ROOMS.replace('# rooms.yaml - kg (fixture)', '# rooms.yaml - kg (edited)');
    writeFileSync(roomsPath(h), edited);
    await expect(p.apply()).rejects.toThrow(/0022 refuses: .*rooms\.yaml changed since it was planned - re-run/);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(edited);
    expect(baks(h)).toEqual([]);
  });
});

describe('0022 through the runner', () => {
  // The Windows probes of 0001/0002/0004/0005 are told "nothing there", and localAddresses is
  // empty so 0007 reads nothing as this node's own (as tests/migrations-0021-*).
  const ctx = { ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }), localAddresses: new Set() };
  const dir = join(import.meta.dirname, '..', 'migrations');
  const ledgerOf = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'));
  const ID = '0022-a-room-that-carries-every-chat-compacts-sooner';

  it('kg: applied and recorded, one room changed and one backup beside it', async () => {
    const h = home();
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledgerOf(h)[ID].outcome).toBe('applied');
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(KG_ROOMS_AFTER);
    expect(readdirSync(join(h, 'config')).filter((f) => f.startsWith('rooms.yaml.bak-0022-'))).toHaveLength(1);
  });

  it('a node with no rooms.yaml converges too, recorded as already-satisfied', async () => {
    const h = home({ rooms: null });
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledgerOf(h)[ID].outcome).toBe('already-satisfied');
    expect(existsSync(roomsPath(h))).toBe(false);
  });

  it('EVERY earlier migration reads satisfied on these fixtures - one that acted would invalidate them', async () => {
    for (const h of [home(), home({ rooms: null })]) {
      await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
      const earlier = Object.entries(ledgerOf(h)).filter(([id]) => id < '0022');
      expect(earlier.length).toBeGreaterThanOrEqual(21);
      expect(earlier.filter(([, e]) => e.outcome !== 'already-satisfied')).toEqual([]);
      // At most one backup in the whole chain, and it is this migration's: nothing earlier wrote.
      expect(baks(h).map((f) => f.replace(/\d{8}T\d{6}$/, '<stamp>'))).toEqual(
        existsSync(roomsPath(h)) ? ['rooms.yaml.bak-0022-<stamp>'] : [],
      );
    }
  });
});
