// tests/migrations-0024-the-room-hands-its-work-out.test.mjs — migrations/0024-the-room-hands-its-work-out.mjs.
//
// ONE ruling, in two halves: the node that has `room/acim` AND the Drive folder hands that room's
// finished files out. config.yaml's root `outbox_targets:` names the path ONCE — the only place a
// path is ever written — and the room's per-being block names only the KEY. Either half alone does
// nothing, which is why both are written and why one test asserts exactly that.
//
// THE FIXTURES ARE MINIATURES OF REAL STATE, in temp dirs, and every one of them is a node that
// every EARLIER migration has nothing left to do on (the runner describe at the bottom proves
// exactly that — a fixture an earlier migration acts on fails these tests for the wrong reason,
// which is how the 0003, 0010, 0018, 0019, 0021 and 0022 fixtures broke in turn). kg reads as it
// does after 0022/0023: its own `chrome:` block, and a `room/acim` whose being already carries the
// ratio 0022 pinned. 0022 and 0023 both act on rooms, so this fixture is the one they leave alone.
//
// The assertions are on the FULL text, never a re-parse: the comments beside these rows and every
// other byte are what the splice layer exists to protect. CRLF throughout, as the live files are.
//
// AND THE OUTCOME TEST DOES NOT READ THE FILE AT ALL — it drives the node's own readState/getBeing
// and then src/room-outbox.mjs's resolveOutboxTarget over what was written, which is the pair
// src/spine/brainpool.mjs's resolveConv hands the turn. getBeing RENAMES the stored `outbox_to` to
// `outboxTo`, which is the name asserted below; and resolving it against the written config.yaml is
// what proves the two halves AGREE rather than merely both being present.
//
// THE DESTINATION IS ASKED THROUGH A ctx SEAM (`isDirectory`, the pattern 0007 set with
// localAddresses and 0023 with findChrome), so this suite never depends on whether the machine
// running it happens to have that Drive folder mounted.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as YAML from 'yaml';
import { plan } from '../migrations/0024-the-room-hands-its-work-out.mjs';
import { runMigrations } from '../setup/migrate.mjs';
import { readState, getBeing } from '../src/conversations-state.mjs';
import { resolveOutboxTarget } from '../src/room-outbox.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');

// The one path this migration spells, and the key that is the only thing a conversation names.
const DEST = 'G:/My Drive/jose-lorenzo/ACIM-ES.v2';
const KEY = 'acim-drive';
const KG_CHAT = '0MP97ovrD6XvVovMVx6v';       // kg's account's view of "perrito traduciones"

// ── what the migration writes, at the columns it writes it at ────────────────────────────────
const ENTRY_LINES = (pad) => [
  `${pad}# WHERE room/acim HANDS ITS FINISHED FILES OUT (0024, operator 2026-09-22). This drive`,
  `${pad}# letter lives in the operator's OWN session, so the sandboxed account a being runs as has`,
  `${pad}# no such path at all - which is why the spine does the move (src/room-outbox.mjs) instead`,
  `${pad}# of the being. \`acim-drive\` is the only thing a conversation ever names; this line is the`,
  `${pad}# only place the path behind that name is written.`,
  `${pad}acim-drive: ${DEST}`,
];
const MAP_LINES = (pad) => [
  `${pad}# THE APPROVED DESTINATIONS A ROOM'S outbox/ MAY BE DRAINED TO (0024, operator 2026-09-22).`,
  `${pad}# THE ONLY PLACE A PATH IS EVER WRITTEN, and that is the whole point of it. A conversation`,
  `${pad}# selects an entry BY KEY - \`outbox_to: <key>\` on its per-being block in`,
  `${pad}# config/rooms.yaml - and that key is used as a LOOKUP and nothing else: it never`,
  `${pad}# contributes a fragment, a suffix or a \`..\` to the answer, so a name this map does not`,
  `${pad}# have resolves to NOTHING rather than to a folder nobody approved. Sibling of`,
  `${pad}# \`allowed_paths:\` for that reason: one place the node grants a folder, one place to`,
  `${pad}# revoke it. Unset anywhere means the feature is simply off.`,
  `${pad}outbox_targets:`,
  ...ENTRY_LINES(`${pad}  `),
];
const OUTBOX_LINES = (pad) => [
  `${pad}# THIS ROOM HANDS ITS WORK OUT (0024, operator 2026-09-22). The being writes finished`,
  `${pad}# files into this room's own outbox/ and the SPINE moves them: it runs as the operator and`,
  `${pad}# can see a drive the sandboxed account the being runs as has no letter for at all. What is`,
  `${pad}# named here is the TARGET'S KEY and never a path - the path is written once, in`,
  `${pad}# config.yaml's \`outbox_targets:\` map, and a conversation only ever SELECTS among the entries`,
  `${pad}# there. Unset would mean this room hands nothing out.`,
  `${pad}outbox_to: acim-drive`,
];

const WHOLE_MAP = MAP_LINES('');            // a top-level key sits at column 0
const IN_MAP = ENTRY_LINES('  ');           // an existing `outbox_targets:` block's entries, at 2
const IN_BEING = OUTBOX_LINES('        ');  // a room being block's own keys sit at column 8

// ── kg's config.yaml as it reads after 0022/0023 ─────────────────────────────────────────────
const OPERATOR = '[ "16468217865", "34836563681438", "@anrodriguez:beeper.com" ]';
const DRIVEN = '[ "16468217865", "34836563681438", "@anrodriguez:beeper.com", "@dolly-egpt:beeper.com" ]';
const KG_LINES = [
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
  '      compaction:',
  '        ratio: 0.50',
  '  codex:',
  '    configuration: codex',
  '    handles: [ codex ]',
  '# kg names its own browser already - a 64-bit install, and its own brain profile',
  'chrome:',
  '  bin: C:/Program Files/Google/Chrome/Application/chrome.exe',
  '  profile_dir: C:/Users/an/.egpt/chrome/profiles/brain',
  'compaction:',
  '  ratio: 0.80 # the node default',
  '  cooling_ms: 600000',
  '',
  '# nothing below this line is read by the spine',
];
const KG = crlf(KG_LINES);
// The map goes in after the LAST top-level key's own lines - the blank line and the comment below
// describe what comes NEXT and stay where they are.
const KG_MAP_AT = KG_LINES.indexOf('  cooling_ms: 600000') + 1;

// ── kg's config/rooms.yaml: the lobby, and the room a WhatsApp group is invited into ──────────
const KG_ROOMS_LINES = [
  '# rooms.yaml - kg (fixture)',
  'rooms:',
  '  # the lobby - nobody was ever invited in, so it is one chat like any other',
  '  room/lobby:',
  '    agents:',
  '      egpt:',
  '        threadId: lobby-kg-fixture',
  '',
  '  # acim - a WhatsApp group was invited in as a member, and 0022 already pinned its ratio',
  '  room/acim:',
  '    agents:',
  '      egpt:',
  '        threadId: acim-kg-fixture',
  '        compaction:',
  '          ratio: 0.50',
  '    members:',
  '      - kind: wa-group',
  `        id: ${KG_CHAT}`,
  '        state: active',
  '',
  '# nothing below this line is a room',
];
const KG_ROOMS = crlf(KG_ROOMS_LINES);
// The line goes in at the end of `egpt:`'s own block - past the `compaction:` it already carries,
// and before the `members:` list, which belongs to the ROW and not to the being.
const KG_BEING_AT = KG_ROOMS_LINES.indexOf('          ratio: 0.50') + 1;

// ── kg's conversations.yaml: the room rows that make `room/acim` resolve at all ───────────────
const KG_CONV = crlf([
  'contacts:',
  '  whatsapp:',
  `    ${KG_CHAT}: # perrito traduciones`,
  '      conversation_path: .egpt/conversations/whatsapp/perrito-traduciones',
  '      home_dir: /c/Users/an',
  '  room:',
  '    acim:',
  '      conversation_path: .egpt/rooms/acim',
  '      home_dir: /c/Users/an',
  '    lobby:',
  '      conversation_path: .egpt/rooms/lobby',
  '      home_dir: /c/Users/an',
]);

// ── do: `room/acim-do` and no `room/acim`, and no such drive letter either ────────────────────
const DO_ROOMS = crlf([
  '# rooms.yaml - do (fixture)',
  'rooms:',
  '  room/lobby:',
  '    agents:',
  '      don:',
  '        threadId: lobby-do-fixture',
  '',
  '  # the room 0023 built - a different room, and the prefix is not the row key',
  '  room/acim-do:',
  '    agents:',
  '      don:',
  '        access_level: sandbox',
  '        compaction:',
  '          ratio: 0.50',
  '    members:',
  '      - kind: wa-group',
  '        id: MMF7iTSSiR3fc7UbbgM9',
  '        state: active',
]);

// The type files the `configuration:` lines name. None pins a `cwd:`, so 0014 has nothing to move.
const TYPES = {
  'sonnet-default': 'type: ccode\nmodel: sonnet\neffort: high\n',
  'sonnet-high': 'type: ccode\nmodel: sonnet\neffort: high\n',
};
const IDENTITIES = { wren: '# I am Wren\n' };

// `.egpt` nested inside the temp dir, so `<parent>/src` does not exist and 0015 stays satisfied.
function home({ config = KG, rooms = KG_ROOMS, conversations = KG_CONV } = {}) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0024-')), '.egpt');
  mkdirSync(join(h, 'config', 'agents', 'identities'), { recursive: true });
  if (config !== null) writeFileSync(join(h, 'config', 'config.yaml'), config);
  if (rooms !== null) writeFileSync(join(h, 'config', 'rooms.yaml'), rooms);
  if (conversations !== null) writeFileSync(join(h, 'config', 'conversations.yaml'), conversations);
  for (const [name, text] of Object.entries(TYPES)) writeFileSync(join(h, 'config', 'agents', `${name}.yaml`), text);
  for (const [name, text] of Object.entries(IDENTITIES)) writeFileSync(join(h, 'config', 'agents', 'identities', `${name}.md`), text);
  return h;
}
const cfgPath = (h) => join(h, 'config', 'config.yaml');
const roomsPath = (h) => join(h, 'config', 'rooms.yaml');
const convPath = (h) => join(h, 'config', 'conversations.yaml');
const baks = (h) => readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-'));
// The destination is handed in: `true` is the node that holds that Drive folder, `false` is every
// other node. Nothing here ever stats a real `G:`.
const ctxFor = (h, isDirectory = () => true) => ({
  egptHome: h,
  isDirectory,
  log: () => {},
  backup: (f) => { const to = `${f}.bak-0024-test`; writeFileSync(to, readFileSync(f)); return to; },
});

// The two files as this migration leaves a kg-shaped node.
const KG_AFTER = crlf([...KG_LINES.slice(0, KG_MAP_AT), ...WHOLE_MAP, ...KG_LINES.slice(KG_MAP_AT)]);
const KG_ROOMS_AFTER = crlf([...KG_ROOMS_LINES.slice(0, KG_BEING_AT), ...IN_BEING, ...KG_ROOMS_LINES.slice(KG_BEING_AT)]);
// A node this migration has ALREADY run on, written directly rather than by running it - so
// "already satisfied" is tested against the text and not against the code that produced it.
function appliedHome() {
  const h = home();
  writeFileSync(cfgPath(h), KG_AFTER);
  writeFileSync(roomsPath(h), KG_ROOMS_AFTER);
  return h;
}

describe('0024 on kg - the room that translates hands its work out', () => {
  it('plans both inserts, naming the room, the being and the folder', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${cfgPath(h)}:${KG_MAP_AT + 1}-${KG_MAP_AT + WHOLE_MAP.length}  insert the node's \`outbox_targets:\` map, with \`acim-drive\` (${WHOLE_MAP.length} lines):`,
      ...WHOLE_MAP.map((l) => `  + ${l}`),
      `${roomsPath(h)}:${KG_BEING_AT + 1}-${KG_BEING_AT + IN_BEING.length}  insert \`outbox_to: acim-drive\` at rooms.room/acim.agents.egpt (${IN_BEING.length} lines):`,
      ...IN_BEING.map((l) => `  + ${l}`),
      '`room/acim` on this node hands what `egpt` finishes there out to `acim-drive`, which is '
        + `${DEST} - the spine moves the files because it runs as the operator and the sandboxed account a being runs as has no such path at all`,
      'backup first, beside each: <file>.bak-0024-<timestamp>',
    ]);
  });

  it('apply: both files gain their half and every other byte - comments, CRLF, the other room - is untouched', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG_AFTER);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(KG_ROOMS_AFTER);
    // The trailing comments the inserts had to step over, and the rows nothing was written into.
    expect(readFileSync(cfgPath(h), 'utf8')).toContain('\r\n\r\n# nothing below this line is read by the spine\r\n');
    expect(readFileSync(roomsPath(h), 'utf8')).toContain('\r\n\r\n# nothing below this line is a room\r\n');
    expect(readFileSync(roomsPath(h), 'utf8')).toContain('  # the lobby - nobody was ever invited in, so it is one chat like any other\r\n');
    expect(readFileSync(cfgPath(h), 'utf8')).toContain('# kg names its own browser already - a 64-bit install, and its own brain profile\r\n');
    // conversations.yaml is not this migration's file and is not opened for writing.
    expect(readFileSync(convPath(h), 'utf8')).toBe(KG_CONV);
    // Two backups, one beside each file it wrote, with the originals in them.
    expect(baks(h).sort()).toEqual(['config.yaml.bak-0024-test', 'rooms.yaml.bak-0024-test']);
    expect(readFileSync(`${cfgPath(h)}.bak-0024-test`, 'utf8')).toBe(KG);
    expect(readFileSync(`${roomsPath(h)}.bak-0024-test`, 'utf8')).toBe(KG_ROOMS);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('nothing else in either file moved: the node, the other being and the other room read the same', async () => {
    const h = home();
    await (await plan(ctxFor(h))).apply();
    const cfg = YAML.parse(readFileSync(cfgPath(h), 'utf8'));
    expect(cfg.outbox_targets).toEqual({ [KEY]: DEST });
    expect(cfg.agents.egpt.conversation_defaults.access_level).toBe('sandbox');
    expect(cfg.agents.wren.conversation_defaults.compaction).toEqual({ ratio: 0.5 });
    expect(cfg.chrome.bin).toBe('C:/Program Files/Google/Chrome/Application/chrome.exe');
    const rows = YAML.parse(readFileSync(roomsPath(h), 'utf8')).rooms;
    expect(rows['room/acim'].agents.egpt).toEqual({ threadId: 'acim-kg-fixture', compaction: { ratio: 0.5 }, outbox_to: KEY });
    expect(rows['room/acim'].members).toEqual([{ kind: 'wa-group', id: KG_CHAT, state: 'active' }]);
    // The room nobody was invited into hands nothing out: the feature is per conversation.
    expect(rows['room/lobby'].agents.egpt).toEqual({ threadId: 'lobby-kg-fixture' });
  });

  // THE EVIDENCE TEST. Not "are the keys in the files" but "does the node READ them, and do they
  // agree": the same readState/getBeing pair boot.mjs hands brainpool, and then the ONE resolver
  // both the turn and the boot sweep walk (src/room-outbox.mjs). getBeing RENAMES the stored
  // `outbox_to` to `outboxTo`.
  it('the node READS it: getBeing hands back `outboxTo`, and resolveOutboxTarget turns it into the mapped path', async () => {
    const h = home();
    const before = getBeing(await readState(convPath(h)), 'room', 'acim', 'egpt');
    expect(before.outboxTo).toBeNull();
    expect(resolveOutboxTarget(before, 'egpt', YAML.parse(readFileSync(cfgPath(h), 'utf8')))).toBeNull();  // unset ⇒ OFF

    await (await plan(ctxFor(h))).apply();

    const after = getBeing(await readState(convPath(h)), 'room', 'acim', 'egpt');
    expect(after.outboxTo).toBe(KEY);                        // the KEY, never a path
    expect(after.compaction).toEqual({ ratio: 0.5 });        // the block it was written beside
    expect(after.threadId).toBe('acim-kg-fixture');
    // THE TWO HALVES AGREE: the name the room states resolves, through the node's own map, to
    // exactly the folder config.yaml approved.
    expect(resolveOutboxTarget(after, 'egpt', YAML.parse(readFileSync(cfgPath(h), 'utf8')))).toEqual({ key: KEY, to: DEST, unknown: null });
    // …and the room nobody was invited into still names nothing, so its drain never runs.
    const lobby = getBeing(await readState(convPath(h)), 'room', 'lobby', 'egpt');
    expect(lobby.outboxTo).toBeNull();
    expect(resolveOutboxTarget(lobby, 'egpt', YAML.parse(readFileSync(cfgPath(h), 'utf8')))).toBeNull();
  });

  // The being's KEY is whatever the ROW carries - on kg it is `egpt`, and that is 0018's doing and
  // not a thing this migration may assume.
  it('the being is read off the row, never spelled: a room keyed `wren` gets the line on `wren`', async () => {
    const keyed = KG_ROOMS.replace('  room/acim:\r\n    agents:\r\n      egpt:\r\n', '  room/acim:\r\n    agents:\r\n      wren:\r\n');
    const h = home({ rooms: keyed });
    const p = await plan(ctxFor(h));
    expect(p.changes.some((l) => l.includes('insert `outbox_to: acim-drive` at rooms.room/acim.agents.wren'))).toBe(true);
    await p.apply();
    expect(YAML.parse(readFileSync(roomsPath(h), 'utf8')).rooms['room/acim'].agents.wren.outbox_to).toBe(KEY);
    const being = getBeing(await readState(convPath(h)), 'room', 'acim', 'wren');
    expect(being.outboxTo).toBe(KEY);
    expect(resolveOutboxTarget(being, 'wren', YAML.parse(readFileSync(cfgPath(h), 'utf8')))).toEqual({ key: KEY, to: DEST, unknown: null });
  });

  // A room has ONE outbox/ and every being resident in it answers from that room, so every block
  // gets the name. The rung is per being because that is where getBeing looks, not because the
  // residents differ.
  it('every being block in the row is written, and each is named', async () => {
    const two = KG_ROOMS.replace(
      '          ratio: 0.50\r\n',
      '          ratio: 0.50\r\n      wren:\r\n        threadId: acim-wren-fixture\r\n',
    );
    const h = home({ rooms: two });
    const p = await plan(ctxFor(h));
    expect(p.changes.filter((l) => l.includes('  insert ')).length).toBe(3);   // the map, and one line per being
    await p.apply();
    const agents = YAML.parse(readFileSync(roomsPath(h), 'utf8')).rooms['room/acim'].agents;
    expect(agents.egpt.outbox_to).toBe(KEY);
    expect(agents.wren.outbox_to).toBe(KEY);
    expect(getBeing(await readState(convPath(h)), 'room', 'acim', 'wren').outboxTo).toBe(KEY);
  });
});

describe('0024: each half is independently satisfiable, and neither alone does anything', () => {
  // config.yaml already carries the map (a node where the operator wrote it by hand, or a second
  // room got there first). Only the room's half is written, and config.yaml is not even backed up.
  it('the map already there: only the room\'s half is written', async () => {
    const mine = crlf([
      ...KG_LINES.slice(0, KG_MAP_AT),
      '# the operator wrote this by hand',
      'outbox_targets:',
      `  ${KEY}: ${DEST} # approved 2026-09-22`,
      ...KG_LINES.slice(KG_MAP_AT),
    ]);
    const h = home({ config: mine });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes.filter((l) => l.includes('  insert ')).length).toBe(1);
    expect(p.changes).toContain(`\`outbox_targets.${KEY}\` in ${cfgPath(h)} already names ${DEST} - the destination this node approves is already written`);
    await p.apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(mine);       // byte for byte, comment included
    expect(baks(h)).toEqual(['rooms.yaml.bak-0024-test']);
    expect(getBeing(await readState(convPath(h)), 'room', 'acim', 'egpt').outboxTo).toBe(KEY);
  });

  // An `outbox_targets:` map that does not have THIS key gains the one entry, inside the map it
  // already has - not a second map, and not a re-indent of the first.
  it('a map naming some OTHER target gains the one entry, inside the block it already has', async () => {
    const mine = crlf([
      ...KG_LINES.slice(0, KG_MAP_AT),
      'outbox_targets:',
      '  scratch: D:/scratch # somewhere else entirely',
      ...KG_LINES.slice(KG_MAP_AT),
    ]);
    const h = home({ config: mine });
    const p = await plan(ctxFor(h));
    expect(p.changes[0]).toBe(`${cfgPath(h)}:${KG_MAP_AT + 3}-${KG_MAP_AT + 2 + IN_MAP.length}  insert \`outbox_targets.${KEY}\` (${IN_MAP.length} lines):`);
    await p.apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(crlf([
      ...KG_LINES.slice(0, KG_MAP_AT), 'outbox_targets:', '  scratch: D:/scratch # somewhere else entirely',
      ...IN_MAP, ...KG_LINES.slice(KG_MAP_AT),
    ]));
    expect(YAML.parse(readFileSync(cfgPath(h), 'utf8')).outbox_targets).toEqual({ scratch: 'D:/scratch', [KEY]: DEST });
  });

  it('the room\'s half already there: only the node\'s map is written', async () => {
    const h = home({ rooms: KG_ROOMS_AFTER });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes.filter((l) => l.includes('  insert ')).length).toBe(1);
    expect(p.changes).toContain(`rooms.room/acim.agents.egpt.outbox_to in ${roomsPath(h)} already names \`${KEY}\` - this conversation already hands its work out and is left alone`);
    await p.apply();
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(KG_ROOMS_AFTER);   // byte for byte
    expect(baks(h)).toEqual(['config.yaml.bak-0024-test']);
  });

  // WHY BOTH ARE WRITTEN TOGETHER. Each half alone resolves to nothing - one is a map nothing
  // selects from, the other a name that resolves to no destination and says so BY NAME.
  it('one half alone resolves to nothing, which is why the other is still written', async () => {
    const onlyMap = home({ config: crlf([...KG_LINES.slice(0, KG_MAP_AT), ...WHOLE_MAP, ...KG_LINES.slice(KG_MAP_AT)]) });
    const mapOnly = getBeing(await readState(convPath(onlyMap)), 'room', 'acim', 'egpt');
    expect(mapOnly.outboxTo).toBeNull();
    expect(resolveOutboxTarget(mapOnly, 'egpt', YAML.parse(readFileSync(cfgPath(onlyMap), 'utf8')))).toBeNull();

    const onlyName = home({ rooms: KG_ROOMS_AFTER });
    const nameOnly = getBeing(await readState(convPath(onlyName)), 'room', 'acim', 'egpt');
    expect(nameOnly.outboxTo).toBe(KEY);
    const unresolved = resolveOutboxTarget(nameOnly, 'egpt', YAML.parse(readFileSync(cfgPath(onlyName), 'utf8')));
    expect(unresolved.to).toBeNull();                       // a name, and no destination behind it
    expect(unresolved.unknown).toContain(`\`outbox_to: ${KEY}\` names no target in \`outbox_targets\``);
  });
});

describe('0024: "nothing to do here" is a note, never a refusal', () => {
  // The destination is what makes a node THE node. A node without that folder is told so by name,
  // and nothing is approved on it that is not there (0015: a path that is not there only lies).
  it('the destination is not a directory on this node: satisfied, and nothing is written', async () => {
    const h = home();
    const p = await plan(ctxFor(h, () => false));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([
      `${DEST} is not a directory on this node, so this is not the node that holds the folder \`${KEY}\` names - nothing is approved here that is not there`,
    ]);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(KG_ROOMS);
    expect(baks(h)).toEqual([]);
  });

  // do: `room/acim-do` is a different room, and the prefix is not the row key. Both properties are
  // missing there, and a node missing both is told both.
  it('do: no `room/acim` and no such drive - satisfied, naming both', async () => {
    const h = home({ rooms: DO_ROOMS });
    const p = await plan(ctxFor(h, () => false));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([
      `${roomsPath(h)} has no \`room/acim\` row, so this node is not the one whose room delivers to \`${KEY}\``,
      `${DEST} is not a directory on this node, so this is not the node that holds the folder \`${KEY}\` names - nothing is approved here that is not there`,
    ]);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(DO_ROOMS);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
  });

  // A node that HAS the folder but not the room is still not the one: the target belongs to the
  // room, and approving a destination no conversation selects would be a map nothing reads.
  it('the folder but no `room/acim`: satisfied, naming the room', async () => {
    const h = home({ rooms: DO_ROOMS });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([`${roomsPath(h)} has no \`room/acim\` row, so this node is not the one whose room delivers to \`${KEY}\``]);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
  });

  // A FRESH PROFILE HAS NO ROOMS REGISTRY AT ALL until its first room is made. Stopping every
  // later migration on that node over it would be a lie - the 0003/0007/0011/0012 lesson.
  it('a node with no rooms.yaml at all owes nothing here', async () => {
    const h = home({ rooms: null });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([`there is no ${roomsPath(h)}, so this node has no \`room/acim\` and no room here hands anything out`]);
    expect(existsSync(roomsPath(h))).toBe(false);
  });

  it('a `room/acim` with no per-being `agents:` block - no being has taken a turn there', async () => {
    const bare = crlf([
      '# rooms.yaml - kg (fixture)',
      'rooms:',
      '  room/acim:',
      '    members:',
      '      - kind: wa-group',
      `        id: ${KG_CHAT}`,
      '        state: active',
    ]);
    const h = home({ rooms: bare });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([
      `\`room/acim\` in ${roomsPath(h)} carries no per-being \`agents:\` block, so no being has taken a turn in that room and there is nothing here to hand work out`,
    ]);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(bare);
  });

  it('already applied: satisfied, naming both halves, and nothing is written', async () => {
    const h = appliedHome();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([
      `this node has \`room/acim\` (\`egpt\`) and the folder \`${KEY}\` names, and both halves are already in place`,
      `\`outbox_targets.${KEY}\` in ${cfgPath(h)} already names ${DEST} - the destination this node approves is already written`,
      `rooms.room/acim.agents.egpt.outbox_to in ${roomsPath(h)} already names \`${KEY}\` - this conversation already hands its work out and is left alone`,
    ]);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG_AFTER);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(KG_ROOMS_AFTER);
    expect(baks(h)).toEqual([]);
  });

  // src/rooms-file.mjs readRoomsFile tolerates BOTH shapes - the wrapped `rooms:` map and a bare
  // top-level map of rows - so the line is written at whichever column that file's rows sit at.
  it('a BARE rooms.yaml (no `rooms:` wrapper) is read the same way', async () => {
    const bareLines = [
      '# rooms.yaml - kg (fixture, unwrapped)',
      'room/acim:',
      '  agents:',
      '    egpt:',
      '      threadId: acim-kg-fixture',
    ];
    const h = home({ rooms: crlf(bareLines) });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    await p.apply();
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(crlf([...bareLines, ...OUTBOX_LINES('      ')]));
    expect(getBeing(await readState(convPath(h)), 'room', 'acim', 'egpt').outboxTo).toBe(KEY);
  });

  it('a being block that is not a mapping is named and left alone', async () => {
    const odd = KG_ROOMS.replace(
      '      egpt:\r\n        threadId: acim-kg-fixture\r\n        compaction:\r\n          ratio: 0.50\r\n',
      '      egpt:\r\n        threadId: acim-kg-fixture\r\n        compaction:\r\n          ratio: 0.50\r\n      ghost: null\r\n',
    );
    const h = home({ rooms: odd });
    const p = await plan(ctxFor(h));
    expect(p.changes).toContain(
      `rooms.room/acim.agents.ghost in ${roomsPath(h)} is null, not a per-being block - there is nothing here taking a turn in that room, so it is left alone`,
    );
    await p.apply();
    expect(YAML.parse(readFileSync(roomsPath(h), 'utf8')).rooms['room/acim'].agents.ghost).toBeNull();
  });
});

describe('0024 refuses, naming the place, only on what it cannot honestly edit', () => {
  it('no config.yaml at all', async () => {
    const h = home({ config: null });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0024 refuses: there is no .*config\.yaml/);
  });

  it('a config.yaml that does not parse, and one that is not valid UTF-8', async () => {
    const bad = home({ config: 'agents: [ broken\n' });
    await expect(plan(ctxFor(bad))).rejects.toThrow(/0024 refuses: .*config\.yaml does not parse/);

    const raw = home({ config: null });
    writeFileSync(cfgPath(raw), Buffer.from([0x61, 0x67, 0x65, 0x6e, 0x74, 0x73, 0x3a, 0x20, 0xff, 0x0a]));
    await expect(plan(ctxFor(raw))).rejects.toThrow(/0024 refuses: .*config\.yaml is not valid UTF-8/);
  });

  it('a rooms.yaml that does not parse, and one that is not valid UTF-8', async () => {
    const bad = home({ rooms: 'rooms: [ broken\n' });
    await expect(plan(ctxFor(bad))).rejects.toThrow(/0024 refuses: .*rooms\.yaml does not parse/);

    const raw = home({ rooms: null });
    writeFileSync(roomsPath(raw), Buffer.from([0x72, 0x6f, 0x6f, 0x6d, 0x73, 0x3a, 0x20, 0xff, 0x0a]));
    await expect(plan(ctxFor(raw))).rejects.toThrow(/0024 refuses: .*rooms\.yaml is not valid UTF-8/);
  });

  it('an `outbox_targets:` that is a SCALAR - this will not guess what a hand edit meant', async () => {
    const scalar = crlf([...KG_LINES.slice(0, KG_MAP_AT), `outbox_targets: ${DEST}`, ...KG_LINES.slice(KG_MAP_AT)]);
    const h = home({ config: scalar });
    await expect(plan(ctxFor(h))).rejects.toThrow(
      /0024 refuses: `outbox_targets:` in .*config\.yaml is "G:\/My Drive\/jose-lorenzo\/ACIM-ES\.v2", not a mapping/,
    );
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(scalar);
  });

  // WHICH FOLDER THIS NODE APPROVED is a human decision: repointing one would silently redirect
  // every delivery this room has ever made. Both paths are named.
  it('an `acim-drive` already naming a DIFFERENT path - both are named, and neither is overwritten', async () => {
    const other = crlf([...KG_LINES.slice(0, KG_MAP_AT), 'outbox_targets:', `  ${KEY}: G:/My Drive/jose-lorenzo/ACIM-ES.v1`, ...KG_LINES.slice(KG_MAP_AT)]);
    const h = home({ config: other });
    await expect(plan(ctxFor(h))).rejects.toThrow(
      /0024 refuses: `outbox_targets\.acim-drive` in .*config\.yaml already names "G:\/My Drive\/jose-lorenzo\/ACIM-ES\.v1" rather than "G:\/My Drive\/jose-lorenzo\/ACIM-ES\.v2" - which folder this node approved is a human decision, not a path to overwrite/,
    );
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(other);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(KG_ROOMS);   // and the other half is not written either
  });

  it('an `outbox_to:` already naming a DIFFERENT key - this will not repoint a conversation', async () => {
    const other = KG_ROOMS.replace('          ratio: 0.50\r\n', '          ratio: 0.50\r\n        outbox_to: somewhere-else\r\n');
    const h = home({ rooms: other });
    await expect(plan(ctxFor(h))).rejects.toThrow(
      /0024 refuses: `outbox_to:` at rooms\.room\/acim\.agents\.egpt in .*rooms\.yaml already names "somewhere-else" rather than "acim-drive" - which approved target this conversation hands its work to is a human decision, and this migration will not repoint one/,
    );
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(other);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
  });

  it('a file edited between plan and apply, and nothing is written', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    const edited = KG_ROOMS.replace('# rooms.yaml - kg (fixture)', '# rooms.yaml - kg (edited)');
    writeFileSync(roomsPath(h), edited);
    await expect(p.apply()).rejects.toThrow(/0024 refuses: .*rooms\.yaml changed since it was planned - re-run/);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(edited);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);      // the file it would have written FIRST
    expect(baks(h)).toEqual([]);
  });
});

describe('0024 through the runner', () => {
  // The Windows probes of 0001/0002/0004/0005 are told "nothing there", localAddresses is empty so
  // 0007 reads nothing as this node's own, Chrome is handed in (as tests/migrations-0021-*), and
  // the destination is handed in so the chain never stats a real drive.
  const ctx = {
    ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }),
    localAddresses: new Set(),
    findChrome: () => null,
    isDirectory: () => true,
  };
  const dir = join(import.meta.dirname, '..', 'migrations');
  const ledgerOf = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'));
  const ID = '0024-the-room-hands-its-work-out';
  // 0025 runs LAST in this chain and states an `access_level:` on every being that declares none,
  // so the live config.yaml is no longer the end state THIS migration is about. Its BACKUP is:
  // ctx.backup copies the file the instant before 0025 writes it, which is exactly what the chain
  // up to 0024 left behind - so the byte-for-byte assertions below are unchanged.
  const upTo0024 = (h) => {
    const d = join(h, 'config');
    return readFileSync(join(d, readdirSync(d).find((f) => f.startsWith('config.yaml.bak-0025-'))), 'utf8');
  };

  it('kg: applied and recorded, two files changed and a backup beside each', async () => {
    const h = home();
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledgerOf(h)[ID].outcome).toBe('applied');
    expect(upTo0024(h)).toBe(KG_AFTER);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(KG_ROOMS_AFTER);
    expect(baks(h).filter((f) => !f.includes('.bak-0025-')).map((f) => f.replace(/\d{8}T\d{6}$/, '<stamp>')).sort()).toEqual([
      'config.yaml.bak-0024-<stamp>', 'rooms.yaml.bak-0024-<stamp>',
    ]);
    // And the node READS what the chain left behind.
    const being = getBeing(await readState(convPath(h)), 'room', 'acim', 'egpt');
    expect(resolveOutboxTarget(being, 'egpt', YAML.parse(readFileSync(cfgPath(h), 'utf8')))).toEqual({ key: KEY, to: DEST, unknown: null });
  });

  it('a node without that folder converges too, recorded as already-satisfied with nothing written', async () => {
    const h = home();
    const { exitCode } = await runMigrations({
      dir, egptHome: h, elevated: false, platform: 'win32', log: () => {},
      ctx: { ...ctx, isDirectory: () => false },
    });
    expect(exitCode).toBe(0);
    expect(ledgerOf(h)[ID].outcome).toBe('already-satisfied');
    expect(upTo0024(h)).toBe(KG);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(KG_ROOMS);
    expect(baks(h).filter((f) => !f.includes('.bak-0025-'))).toEqual([]);
  });

  it('a node with no rooms.yaml converges too - a refusal here would stop every later migration', async () => {
    const h = home({ rooms: null });
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledgerOf(h)[ID].outcome).toBe('already-satisfied');
    expect(existsSync(roomsPath(h))).toBe(false);
  });

  it('EVERY earlier migration reads satisfied on these fixtures - one that acted would invalidate them', async () => {
    for (const h of [home(), home({ rooms: DO_ROOMS }), home({ rooms: null }), appliedHome()]) {
      await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
      const earlier = Object.entries(ledgerOf(h)).filter(([id]) => id < '0024');
      expect(earlier.length).toBeGreaterThanOrEqual(23);
      expect(earlier.filter(([, e]) => e.outcome !== 'already-satisfied')).toEqual([]);
      // At most two backups in the chain up to this migration, and they are this migration's:
      // nothing EARLIER wrote. 0025 runs after it and its own suite asserts what it writes.
      expect(baks(h).filter((f) => !f.includes('.bak-0025-')).map((f) => f.replace(/\d{8}T\d{6}$/, '<stamp>')).sort().map((f) => f.split('.bak-')[1])).toEqual(
        ledgerOf(h)[ID].outcome === 'applied' ? ['0024-<stamp>', '0024-<stamp>'] : [],
      );
      rmSync(dirname(h), { recursive: true, force: true });
    }
  });
});
