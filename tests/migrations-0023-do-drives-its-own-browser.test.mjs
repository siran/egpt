// tests/migrations-0023-do-drives-its-own-browser.test.mjs — migrations/0023-do-drives-its-own-browser.mjs.
//
// ONE ruling, in three pieces: the node that has `don` drives its OWN Chrome — a `chrome:` block
// naming this machine's binary and the profile a being drives, a `room/acim-do` with that being
// sandboxed in it and the WhatsApp group invited, and the conversations.yaml row that makes the
// room resolve at all. Cross-node remote driving was considered and dropped; nothing here crosses
// a node boundary.
//
// THE FIXTURES ARE MINIATURES OF REAL STATE, in temp dirs, and every one of them is a node that
// every EARLIER migration has nothing left to do on (the runner describe at the bottom proves
// exactly that — a fixture an earlier migration acts on fails these tests for the wrong reason,
// which is how the 0003, 0010, 0018, 0019, 0021 and 0022 fixtures broke in turn). do reads as it
// does AFTER 0018/0019/0020/0021; kg reads as it does after 0022, WITH its own `chrome:` block and
// its own `room/acim` carrying the OTHER account's id for the same group — the asymmetry this
// migration is qualified on.
//
// The assertions are on the FULL text, never a re-parse: the comments beside these rows and every
// other byte are what the splice layer exists to protect. CRLF throughout, as the live files are.
//
// AND ONE TEST DOES NOT READ THE FILE AT ALL — it drives the node's own readState/getBeing over the
// edited profile, so what is written is proved to be what src/spine/brainpool.mjs's resolveConv
// hands the turn as this conversation's access level. getBeing reports it as `accessLevel` (it
// renames the stored `access_level`), which is the name asserted below.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as YAML from 'yaml';
import { plan } from '../migrations/0023-do-drives-its-own-browser.mjs';
import { runMigrations } from '../setup/migrate.mjs';
import { readState, getBeing } from '../src/conversations-state.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');
const slash = (p) => String(p).replace(/\\/g, '/');
// `C:\Users\an` → `/c/Users/an`, the shape conversations.yaml stores a home_dir in. One line,
// re-derived here rather than imported, so the test states the expected form instead of agreeing
// with the migration's.
const msys = (p) => { const s = slash(p); const m = s.match(/^([A-Za-z]):\/(.*)$/); return m ? `/${m[1].toLowerCase()}/${m[2]}` : s; };

// do's Chrome, at the x86 path — the 64-bit one does not exist there. Handed in through the ctx
// seam so the suite does not depend on where Chrome happens to be on the machine running it;
// production asks src/tools/chrome-launcher.mjs findChromeExecutable, the locator the spawner
// itself falls back to. Backslashed here, as that locator returns it.
const CHROME_EXE = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const CHAT = 'MMF7iTSSiR3fc7UbbgM9';          // do's account's view of "perrito traduciones"
const KG_CHAT = '0MP97ovrD6XvVovMVx6v';       // kg's account's view of the SAME group

// ── what the migration writes, at the columns it writes it at ────────────────────────────────
const BIN_LINES = (pad, bin) => [
  `${pad}# WHERE CHROME IS ON THIS NODE, found by the node's OWN locator`,
  `${pad}# (src/tools/chrome-launcher.mjs findChromeExecutable) rather than spelled here: the`,
  `${pad}# 64-bit and the x86 install paths are both real and a machine has whichever it has.`,
  `${pad}# A being is TOLD this path (config/skeletons/room/30-pointers.md), so it launches the`,
  `${pad}# browser instead of guessing where Chrome lives.`,
  `${pad}bin: ${bin}`,
];
const PROFILE_LINES = (pad, dir) => [
  `${pad}# THE --user-data-dir A BEING DRIVES OVER CDP. Chrome refuses CDP on its own DEFAULT`,
  `${pad}# profile (an anti-hijack guardrail), and a blank profile launches fine but is logged in`,
  `${pad}# to nothing - so this names a profile kept for the purpose, under THIS node's own`,
  `${pad}# profile dir. The name \`brain\` is reused deliberately (0023, operator 2026-09-22):`,
  `${pad}# another node's \`brain\` is a different directory on a different machine, so there is`,
  `${pad}# nothing here to collide with. The directory is created on first launch; logging it in`,
  `${pad}# is a hand gesture this migration does not pretend to make.`,
  `${pad}profile_dir: ${dir}`,
];
const CHROME_BLOCK = (parts) => [
  '# THE BROWSER THIS NODE DRIVES ITSELF (0023, operator 2026-09-22: "stop KG to DO remote',
  '# driving. configure an acim-do/ room in do. then don can drive the browser natively as E',
  '# did it KG"). Read by src/spine/commands.mjs (chromeBinOf / chromeProfileOf) and quoted to',
  '# a being by the pointers card. A node stating neither key falls back to a per-platform',
  '# path search and a profile-scanning HEURISTIC; naming them makes "the browser I was',
  '# promised" the browser that actually launches.',
  'chrome:',
  ...parts,
];
const ROOM_LINES = (pad, being) => [
  `${pad}# A BEING DRIVES THIS NODE'S OWN BROWSER FROM HERE (0023, operator 2026-09-22: "stop KG`,
  `${pad}# to DO remote driving. configure an acim-do/ room in do. then don can drive the browser`,
  `${pad}# natively as E did it KG"). The browser is this node's own - config.yaml's \`chrome:\``,
  `${pad}# block names the binary and the profile - so nothing here is driven across a node`,
  `${pad}# boundary, which is the whole point of the room rather than a bridge.`,
  `${pad}room/acim-do:`,
  `${pad}  agents:`,
  `${pad}    ${being}:`,
  `${pad}      # SANDBOXED IN THIS ROOM, whatever this being's node-level default says (0023,`,
  `${pad}      # operator 2026-09-22: "don must be access_level: sandbox in acim-do"). This is the`,
  `${pad}      # PER-CONVERSATION rung src/spine/brainpool.mjs resolveConv reads OVER the being's`,
  `${pad}      # conversation_defaults, so its level everywhere else is untouched.`,
  `${pad}      access_level: sandbox`,
  `${pad}      # HALF THE WINDOW, NOT THE NODE'S RATIO (0022's ruling, written here because 0022`,
  `${pad}      # runs BEFORE this file and so can never see a room this migration creates). A chat`,
  `${pad}      # joined below as a \`wa-group\` member resolves to THIS conversation's one thread`,
  `${pad}      # (src/spine/identity-scope.mjs), so the thread is trimmed well before brainpool's`,
  `${pad}      # overflow backstop can RESET it to a fresh session.`,
  `${pad}      compaction:`,
  `${pad}        ratio: 0.50`,
  `${pad}  # The WhatsApp group invited into this room, as THIS node's account sees it. Two Beeper`,
  `${pad}  # accounts bridge one group into two different rooms, so the id another node's registry`,
  `${pad}  # carries for the same group would name nothing here.`,
  `${pad}  members:`,
  `${pad}    - kind: wa-group`,
  `${pad}      id: ${CHAT}`,
  `${pad}      state: active`,
];
// conversations.yaml carries NO comment from this migration: the spine rewrites that file from
// memory on every state change and erases them.
const CONV_ENTRY = (pad, home) => [
  `${pad}acim-do:`,
  `${pad}  conversation_path: .egpt/rooms/acim-do`,
  `${pad}  home_dir: ${home}`,
];
const CONV_SURFACE = (pad, home) => [`${pad}room:`, ...CONV_ENTRY(`${pad}  `, home)];

const IN_ROOMS = (being = 'don') => ROOM_LINES('  ', being);      // a row's key sits at column 2
const IN_CHROME = (dir) => PROFILE_LINES('  ', dir);              // an existing chrome: block's keys, at 2
const WHOLE_CHROME = (dir) => CHROME_BLOCK([...BIN_LINES('  ', slash(CHROME_EXE)), ...PROFILE_LINES('  ', dir)]);

// ── do's config.yaml as it reads after 0018/0019/0020/0021 ───────────────────────────────────
const OPERATOR = '[ "16468217865", "34836563681438", "@anrodriguez:beeper.com" ]';
const DRIVEN = '[ "16468217865", "34836563681438", "@anrodriguez:beeper.com", "@dolly-egpt:beeper.com" ]';
const DO_LINES = [
  '# config.yaml - do (fixture)',
  'node_name: do',
  'agents:',
  '  # the WORKER, do\'s persona. Since 0020 it answers to `rodz` as well - a HANDLE, not an id.',
  '  don:',
  '    configuration: sonnet-default # config/agents/sonnet-default.yaml',
  '    handles: [ d, don, rodz ] # the worker, addressed either way',
  '    default: true',
  '    name: "D"',
  '    conversation_defaults:',
  '      access_level: regular',
  `      allowed_users: ${OPERATOR} # who may wake the worker`,
  '  # DREN - do\'s meta engineer',
  '  dren:',
  '    configuration: sonnet-high # config/agents/sonnet-high.yaml',
  '    personality: dren # config/agents/identities/dren.md',
  '    handles: [ dren ]',
  '    name: "Dren"',
  '    scope: agent/dren # one agent/dren node-wide',
  '    sandboxed: false',
  '    conversation_defaults:',
  '      access_level: all',
  `      allowed_users: ${DRIVEN} # who may drive this being`,
  '  # DJH - the radio agent, unsandboxed and pinned to nothing. Off since 0006.',
  '  djh:',
  '    configuration: haiku-low # config/agents/haiku-low.yaml',
  '    handles: [ djh ]',
  '    mode: off',
  '    conversation_defaults:',
  '      access_level: all',
  '      allowed_users: [ "16468217865" ] # who may wake the radio',
  '  codex:',
  '    configuration: codex',
  '    handles: [ codex ]',
  'compaction:',
  '  ratio: 0.80 # the node default',
  '  cooling_ms: 600000',
  '',
  '# nothing below this line is read by the spine',
];
const DO = crlf(DO_LINES);
// The block goes in after the LAST top-level key's own lines - the blank line and the comment
// below describe what comes NEXT and stay where they are.
const DO_CHROME_AT = DO_LINES.indexOf('  cooling_ms: 600000') + 1;

// ── do's rooms.yaml: two rooms, neither of them a tunnel ─────────────────────────────────────
const DO_ROOMS_LINES = [
  '# rooms.yaml - do (fixture)',
  'rooms:',
  '  # the lobby - the shell seat, one chat like any other',
  '  room/lobby:',
  '    agents:',
  '      don:',
  '        threadId: lobby-do-fixture',
  '',
  '  # dj-son - the radio room. Its members are brains, not chats.',
  '  room/dj-son:',
  '    members:',
  '      - id: don',
  '        kind: brain',
  '    heartbeats:',
  '      alive: true',
  '',
  '# nothing below this line is a room',
];
const DO_ROOMS = crlf(DO_ROOMS_LINES);
const DO_ROOM_AT = DO_ROOMS_LINES.indexOf('      alive: true') + 1;

// ── do's conversations.yaml: the group is there, the room is not ─────────────────────────────
const DO_CONV_LINES = [
  'contacts:',
  '  whatsapp:',
  `    ${CHAT}: # perrito traduciones`,
  '      conversation_path: .egpt/conversations/whatsapp/perrito-traduciones',
  '      home_dir: /c/Users/an',
  '      agents:',
  '        don:',
  '          threadId: perrito-do-fixture',
  '  room:',
  '    lobby:',
  '      conversation_path: .egpt/rooms/lobby',
  '      home_dir: /c/Users/an',
  '  shell:',
  '    main:',
  '      conversation_path: .egpt/conversations/shell/lobby',
  '      home_dir: /c/Users/an',
];
const DO_CONV = crlf(DO_CONV_LINES);
const DO_CONV_AT = DO_CONV_LINES.indexOf('      home_dir: /c/Users/an', DO_CONV_LINES.indexOf('    lobby:')) + 1;

// ── kg, post-0021/0022: no `don`, its OWN chrome: block, and the same group under ITS id ─────
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
  '  ratio: 0.80',
  '  cooling_ms: 600000',
];
const KG = crlf(KG_LINES);
const KG_ROOMS = crlf([
  '# rooms.yaml - kg (fixture)',
  'rooms:',
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
]);
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

// The type files the `configuration:` lines name. None pins a `cwd:`, so 0014 has nothing to move.
const TYPES = {
  'sonnet-default': 'type: ccode\nmodel: sonnet\neffort: high\n',
  'sonnet-high': 'type: ccode\nmodel: sonnet\neffort: high\n',
  'haiku-low': 'type: ccode\nmodel: haiku\neffort: low\n',
};
const IDENTITIES = { wren: '# I am Wren\n', dren: '# I am Dren\n' };

// `.egpt` nested inside the temp dir, so `<parent>/src` does not exist and 0015 stays satisfied.
function home({ config = DO, rooms = DO_ROOMS, conversations = DO_CONV } = {}) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0023-')), '.egpt');
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
const ctxFor = (h, findChrome = () => CHROME_EXE) => ({
  egptHome: h,
  findChrome,
  log: () => {},
  backup: (f) => { const to = `${f}.bak-0023-test`; writeFileSync(to, readFileSync(f)); return to; },
});
// The two values that are DERIVED from the profile this migration was pointed at, not spelled.
const profileDir = (h) => slash(join(h, 'chrome', 'profiles', 'brain'));
const homeDir = (h) => msys(dirname(h));

// The three files as this migration leaves a do-shaped node.
const doAfter = (h) => ({
  config: crlf([...DO_LINES.slice(0, DO_CHROME_AT), ...WHOLE_CHROME(profileDir(h)), ...DO_LINES.slice(DO_CHROME_AT)]),
  rooms: crlf([...DO_ROOMS_LINES.slice(0, DO_ROOM_AT), ...IN_ROOMS(), ...DO_ROOMS_LINES.slice(DO_ROOM_AT)]),
  conversations: crlf([...DO_CONV_LINES.slice(0, DO_CONV_AT), ...CONV_ENTRY('    ', homeDir(h)), ...DO_CONV_LINES.slice(DO_CONV_AT)]),
});
// A node this migration has ALREADY run on, written directly rather than by running it — so
// "already satisfied" is tested against the text and not against the code that produced it.
function appliedHome() {
  const h = home();
  const after = doAfter(h);
  writeFileSync(cfgPath(h), after.config);
  writeFileSync(roomsPath(h), after.rooms);
  writeFileSync(convPath(h), after.conversations);
  return h;
}

describe('0023 on do - the node that has `don` gains a browser, a room and the row that resolves it', () => {
  it('plans all three inserts, naming the being, the group and the browser', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${cfgPath(h)}:${DO_CHROME_AT + 1}-${DO_CHROME_AT + WHOLE_CHROME(profileDir(h)).length}  insert the node's \`chrome:\` block (\`bin\` and \`profile_dir\`) (${WHOLE_CHROME(profileDir(h)).length} lines):`,
      ...WHOLE_CHROME(profileDir(h)).map((l) => `  + ${l}`),
      `${roomsPath(h)}:${DO_ROOM_AT + 1}-${DO_ROOM_AT + IN_ROOMS().length}  insert the room \`room/acim-do\`, with \`don\` sandboxed in it and the \`wa-group\` member ${CHAT} (${IN_ROOMS().length} lines):`,
      ...IN_ROOMS().map((l) => `  + ${l}`),
      `${convPath(h)}:${DO_CONV_AT + 1}-${DO_CONV_AT + 3}  insert \`contacts.room.acim-do\`, pointing at .egpt/rooms/acim-do (3 lines):`,
      ...CONV_ENTRY('    ', homeDir(h)).map((l) => `  + ${l}`),
      `agents.don answers to \`don\`, and this node's account has chat ${CHAT} as \`whatsapp/perrito-traduciones\` - `
        + 'so that group\'s turns reach `room/acim-do`, where this being drives THIS machine\'s own Chrome',
      'backup first, beside each: <file>.bak-0023-<timestamp>',
    ]);
  });

  it('apply: all three files gain their piece and every other byte - comments, CRLF, the other rooms - is untouched', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    const after = doAfter(h);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(after.config);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(after.rooms);
    expect(readFileSync(convPath(h), 'utf8')).toBe(after.conversations);
    // The trailing comments the inserts had to step over, and the rows nothing was written into.
    expect(readFileSync(cfgPath(h), 'utf8')).toContain('\r\n\r\n# nothing below this line is read by the spine\r\n');
    expect(readFileSync(roomsPath(h), 'utf8')).toContain('\r\n\r\n# nothing below this line is a room\r\n');
    expect(readFileSync(roomsPath(h), 'utf8')).toContain('  # dj-son - the radio room. Its members are brains, not chats.\r\n');
    expect(readFileSync(convPath(h), 'utf8')).toContain(`    ${CHAT}: # perrito traduciones\r\n`);
    // Three backups, one beside each file, and the originals in them.
    expect(baks(h).sort()).toEqual(['config.yaml.bak-0023-test', 'conversations.yaml.bak-0023-test', 'rooms.yaml.bak-0023-test']);
    expect(readFileSync(`${cfgPath(h)}.bak-0023-test`, 'utf8')).toBe(DO);
    expect(readFileSync(`${roomsPath(h)}.bak-0023-test`, 'utf8')).toBe(DO_ROOMS);
    expect(readFileSync(`${convPath(h)}.bak-0023-test`, 'utf8')).toBe(DO_CONV);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('the NODE-LEVEL defaults are not touched: `don` stays `regular` everywhere else', async () => {
    const h = home();
    await (await plan(ctxFor(h))).apply();
    const cfg = YAML.parse(readFileSync(cfgPath(h), 'utf8'));
    expect(cfg.agents.don.conversation_defaults.access_level).toBe('regular');
    expect(cfg.chrome).toEqual({
      bin: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      profile_dir: profileDir(h),
    });
    const rows = YAML.parse(readFileSync(roomsPath(h), 'utf8')).rooms;
    expect(rows['room/acim-do']).toEqual({
      agents: { don: { access_level: 'sandbox', compaction: { ratio: 0.5 } } },
      members: [{ kind: 'wa-group', id: CHAT, state: 'active' }],
    });
    // NO threadId: a thread is minted by the spine on the first turn, never by a migration.
    expect(rows['room/acim-do'].agents.don.threadId).toBeUndefined();
    expect(rows['room/lobby'].agents.don).toEqual({ threadId: 'lobby-do-fixture' });
  });

  // THE EVIDENCE TEST. Not "is the key in the file" but "does the node READ it": the same
  // readState/getBeing pair boot.mjs hands brainpool, whose resolveConv reads this block OVER the
  // being's conversation_defaults. getBeing renames the stored `access_level` to `accessLevel`.
  it('the node READS it: getBeing on surface `room` hands back the sandbox override', async () => {
    const h = home();
    expect(getBeing(await readState(convPath(h)), 'room', 'acim-do', 'don')).toBeNull();  // no such room yet

    await (await plan(ctxFor(h))).apply();

    const being = getBeing(await readState(convPath(h)), 'room', 'acim-do', 'don');
    expect(being.present).toBe(true);
    expect(being.accessLevel).toBe('sandbox');
    expect(being.compaction).toEqual({ ratio: 0.5 });
    expect(being.threadId).toBeNull();
    // …and the room the being already had is unchanged, so it keeps this node's defaults there.
    expect(getBeing(await readState(convPath(h)), 'room', 'lobby', 'don').accessLevel).toBeNull();
  });

  // The being is found by its HANDLE and the room block is keyed by its KEY - the two are not the
  // same question, and on a node built by copying another's keys they are not the same word.
  it('a node where the being answering to `don` is KEYED something else gets the row keyed by the KEY', async () => {
    const keyed = DO.replace('  don:\r\n', '  rodz:\r\n');
    const h = home({ config: keyed });
    const p = await plan(ctxFor(h));
    expect(p.changes.some((l) => l.includes('insert the room `room/acim-do`, with `rodz` sandboxed in it'))).toBe(true);
    await p.apply();
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(
      crlf([...DO_ROOMS_LINES.slice(0, DO_ROOM_AT), ...IN_ROOMS('rodz'), ...DO_ROOMS_LINES.slice(DO_ROOM_AT)]),
    );
    expect(getBeing(await readState(convPath(h)), 'room', 'acim-do', 'rodz').accessLevel).toBe('sandbox');
  });
});

describe('0023: each of the three pieces is independently satisfiable', () => {
  it('a `chrome:` block already there keeps BOTH its values - only the room and the row are written', async () => {
    const mine = DO.replace(
      'compaction:\r\n',
      'chrome:\r\n  bin: C:/Program Files/Google/Chrome/Application/chrome.exe # a hand-set path\r\n  profile_dir: D:/profiles/brain\r\ncompaction:\r\n',
    );
    const h = home({ config: mine });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes.filter((l) => l.includes('  insert ')).length).toBe(2);   // the room and the row, not chrome
    expect(p.changes).toContain(
      `\`chrome.bin\` in ${cfgPath(h)} already reads "C:/Program Files/Google/Chrome/Application/chrome.exe" - this node already names its own browser and is left alone`,
    );
    expect(p.changes).toContain(
      `\`chrome.profile_dir\` in ${cfgPath(h)} already reads "D:/profiles/brain" - this node already names the profile a being drives and is left alone`,
    );
    await p.apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(mine);           // byte for byte, comment included
    expect(baks(h).sort()).toEqual(['conversations.yaml.bak-0023-test', 'rooms.yaml.bak-0023-test']);
    expect(YAML.parse(readFileSync(roomsPath(h), 'utf8')).rooms['room/acim-do'].agents.don.access_level).toBe('sandbox');
  });

  it('a `chrome:` block stating only `bin` gains the ONE missing line, inside the block it already has', async () => {
    const lines = [...DO_LINES];
    const at = lines.indexOf('compaction:');
    lines.splice(at, 0, '# the browser, half-named', 'chrome:', '  bin: C:/Program Files/Google/Chrome/Application/chrome.exe');
    const h = home({ config: crlf(lines) });
    const p = await plan(ctxFor(h));
    expect(p.changes[0]).toBe(
      `${cfgPath(h)}:${at + 4}-${at + 3 + IN_CHROME(profileDir(h)).length}  insert \`chrome.profile_dir\` (${IN_CHROME(profileDir(h)).length} lines):`,
    );
    await p.apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(crlf([
      ...lines.slice(0, at + 3), ...IN_CHROME(profileDir(h)), ...lines.slice(at + 3),
    ]));
    expect(YAML.parse(readFileSync(cfgPath(h), 'utf8')).chrome).toEqual({
      bin: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      profile_dir: profileDir(h),
    });
  });

  it('the room already there and only the registry row missing: just the row is written', async () => {
    const withRoom = crlf([...DO_ROOMS_LINES.slice(0, DO_ROOM_AT), ...IN_ROOMS(), ...DO_ROOMS_LINES.slice(DO_ROOM_AT)]);
    const h = home({ rooms: withRoom });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes.filter((l) => l.includes('  insert ')).length).toBe(2);   // chrome and the row
    expect(p.changes).toContain(
      `\`room/acim-do\` in ${roomsPath(h)} already has \`don\` at \`access_level: sandbox\` with the \`wa-group\` member ${CHAT} - the room is already what this would make it`,
    );
    await p.apply();
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(withRoom);     // byte for byte
    expect(getBeing(await readState(convPath(h)), 'room', 'acim-do', 'don').accessLevel).toBe('sandbox');
  });

  it('a node with NO `contacts.room:` bucket gains the surface and the entry in one block', async () => {
    const noRoom = crlf(DO_CONV_LINES.filter((l, i) => i < DO_CONV_LINES.indexOf('  room:') || i >= DO_CONV_LINES.indexOf('  shell:')));
    const h = home({ conversations: noRoom });
    const p = await plan(ctxFor(h));
    expect(p.changes.some((l) => l.includes('insert the `room` surface and `acim-do` in it, pointing at .egpt/rooms/acim-do'))).toBe(true);
    await p.apply();
    const parsed = YAML.parse(readFileSync(convPath(h), 'utf8'));
    expect(parsed.contacts.room['acim-do']).toEqual({ conversation_path: '.egpt/rooms/acim-do', home_dir: homeDir(h) });
    expect(parsed.contacts.shell.main.conversation_path).toBe('.egpt/conversations/shell/lobby');
    expect(getBeing(await readState(convPath(h)), 'room', 'acim-do', 'don').accessLevel).toBe('sandbox');
  });

  // src/rooms-file.mjs readRoomsFile tolerates BOTH shapes - the wrapped `rooms:` map and a bare
  // top-level map of rows - so the row is written at whichever column that file's rows sit at.
  it('a BARE rooms.yaml (no `rooms:` wrapper) gets the row at the document root', async () => {
    const bareLines = [
      '# rooms.yaml - do (fixture, unwrapped)',
      'room/lobby:',
      '  agents:',
      '    don:',
      '      threadId: lobby-do-fixture',
    ];
    const h = home({ rooms: crlf(bareLines) });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    await p.apply();
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(crlf([...bareLines, ...ROOM_LINES('', 'don')]));
    expect(getBeing(await readState(convPath(h)), 'room', 'acim-do', 'don').accessLevel).toBe('sandbox');
  });

  it('no Chrome on this node: no `bin:` line is invented, and the rest is still written', async () => {
    const h = home();
    const p = await plan(ctxFor(h, () => null));
    expect(p.changes).toContain(
      `no Chrome is installed where src/tools/chrome-launcher.mjs looks on this node, so no \`chrome.bin\` is written into ${cfgPath(h)} `
        + '- a path that is not there is a line that only lies, and the platform search it falls back to is what this node already does',
    );
    await p.apply();
    expect(YAML.parse(readFileSync(cfgPath(h), 'utf8')).chrome).toEqual({ profile_dir: profileDir(h) });
    expect(readFileSync(cfgPath(h), 'utf8')).not.toContain('bin:');
    expect(YAML.parse(readFileSync(roomsPath(h), 'utf8')).rooms['room/acim-do'].members).toEqual([{ kind: 'wa-group', id: CHAT, state: 'active' }]);
  });
});

describe('0023: "nothing to do here" is a note, never a refusal', () => {
  it('kg: no being answers to `don`, so nothing is touched - including kg\'s own chrome: block', async () => {
    const h = home({ config: KG, rooms: KG_ROOMS, conversations: KG_CONV });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([
      `no being in ${cfgPath(h)} answers to \`don\`, so this node is not the one that drives a browser from \`room/acim-do\``,
    ]);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(KG_ROOMS);
    expect(readFileSync(convPath(h), 'utf8')).toBe(KG_CONV);
    expect(baks(h)).toEqual([]);
  });

  // The two accounts see the SAME group under different ids. A node that has `don` but not THIS
  // id is not the node the operator linked, and inviting a group it cannot see would be a guess.
  it('a node that has `don` but only the OTHER account\'s id for the group', async () => {
    const h = home({ conversations: KG_CONV });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([
      `no conversation in ${convPath(h)} is chat ${CHAT}, so this node's account is not in that group and has nothing to invite into \`room/acim-do\``,
    ]);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(DO_ROOMS);
  });

  it('a legacy full `!…:beeper.local` key for the same chat still qualifies the node', async () => {
    const full = DO_CONV.replace(`    ${CHAT}:`, `    "!${CHAT}:beeper.local":`);
    const h = home({ conversations: full });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes.some((l) => l.includes('insert the room `room/acim-do`'))).toBe(true);
  });

  it('already applied: satisfied, naming every piece, and nothing is written', async () => {
    const h = appliedHome();
    const before = { c: readFileSync(cfgPath(h), 'utf8'), r: readFileSync(roomsPath(h), 'utf8'), v: readFileSync(convPath(h), 'utf8') };
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([
      `this node answers to \`don\` (agents.don) and has chat ${CHAT} as \`whatsapp/perrito-traduciones\`, and every piece \`room/acim-do\` needs is already in place`,
      `\`chrome.bin\` in ${cfgPath(h)} already reads "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe" - this node already names its own browser and is left alone`,
      `\`chrome.profile_dir\` in ${cfgPath(h)} already reads ${JSON.stringify(profileDir(h))} - this node already names the profile a being drives and is left alone`,
      `\`room/acim-do\` in ${roomsPath(h)} already has \`don\` at \`access_level: sandbox\` with the \`wa-group\` member ${CHAT} - the room is already what this would make it`,
      `\`contacts.room.acim-do\` in ${convPath(h)} already points at .egpt/rooms/acim-do - the room is already registered`,
    ]);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(before.c);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(before.r);
    expect(readFileSync(convPath(h), 'utf8')).toBe(before.v);
    expect(baks(h)).toEqual([]);
  });

  // A hand-tightened ratio is somebody's decision, whatever it says - 0022's own precedent. The
  // room is judged on the two things this migration is FOR, and the number is not one of them.
  it('an already-applied room whose ratio was tightened by hand still reads satisfied', async () => {
    const h = appliedHome();
    writeFileSync(roomsPath(h), readFileSync(roomsPath(h), 'utf8').replace('        ratio: 0.50\r\n', '        ratio: 0.35 # tighter still\r\n'));
    expect(await plan(ctxFor(h))).toMatchObject({ satisfied: true });
  });

  it('a node with no conversations.yaml at all owes nothing here', async () => {
    const h = home({ conversations: null });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([
      `there is no ${convPath(h)}, so this node has no conversation for chat ${CHAT} and no group to invite into \`room/acim-do\``,
    ]);
    expect(existsSync(convPath(h))).toBe(false);
  });

  it('a config.yaml with no `agents:` mapping', async () => {
    const h = home({ config: crlf(['node_name: fresh', 'compaction:', '  ratio: 0.80']) });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([`${cfgPath(h)} has no \`agents:\` mapping, so nothing here answers to \`don\``]);
  });
});

describe('0023 refuses, naming the place, only on what it cannot honestly edit', () => {
  it('no config.yaml at all', async () => {
    const h = home({ config: null });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0023 refuses: there is no .*config\.yaml/);
  });

  it('a config.yaml that does not parse, and one that is not valid UTF-8', async () => {
    const bad = home({ config: 'agents: [ broken\n' });
    await expect(plan(ctxFor(bad))).rejects.toThrow(/0023 refuses: .*config\.yaml does not parse/);

    const raw = home({ config: null });
    writeFileSync(cfgPath(raw), Buffer.from([0x61, 0x67, 0x65, 0x6e, 0x74, 0x73, 0x3a, 0x20, 0xff, 0x0a]));
    await expect(plan(ctxFor(raw))).rejects.toThrow(/0023 refuses: .*config\.yaml is not valid UTF-8/);
  });

  it('a conversations.yaml that does not parse - whether this node has that group cannot be read', async () => {
    const h = home({ conversations: 'contacts: [ broken\n' });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0023 refuses: .*conversations\.yaml does not parse/);
  });

  it('a qualifying node with no rooms.yaml: the room has nowhere to live', async () => {
    const h = home({ rooms: null });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0023 refuses: there is no .*rooms\.yaml, so `room\/acim-do` has nowhere to live on a node that answers to `don`/);
    expect(existsSync(roomsPath(h))).toBe(false);
  });

  it('a rooms.yaml that does not parse', async () => {
    const h = home({ rooms: 'rooms: [ broken\n' });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0023 refuses: .*rooms\.yaml does not parse/);
  });

  it('TWO beings answering to `don` - which one drives is a human decision', async () => {
    const two = DO.replace('    handles: [ dren ]\r\n', '    handles: [ dren, don ]\r\n');
    const h = home({ config: two });
    await expect(plan(ctxFor(h))).rejects.toThrow(
      /0023 refuses: 2 beings in .*config\.yaml answer to `don` \(don, dren\) - which one drives this node's browser is a human decision, not a guess/,
    );
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(two);
  });

  it('a `chrome:` that is a SCALAR - this will not guess what a hand edit meant', async () => {
    const scalar = DO.replace('compaction:\r\n', 'chrome: C:/Program Files/Google/Chrome/Application/chrome.exe\r\ncompaction:\r\n');
    const h = home({ config: scalar });
    await expect(plan(ctxFor(h))).rejects.toThrow(
      /0023 refuses: `chrome:` in .*config\.yaml is "C:\/Program Files\/Google\/Chrome\/Application\/chrome\.exe", not a mapping/,
    );
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(scalar);
  });

  it('an existing `room/acim-do` whose being is at some OTHER level', async () => {
    const wrong = crlf([
      ...DO_ROOMS_LINES.slice(0, DO_ROOM_AT),
      '  room/acim-do:',
      '    agents:',
      '      don:',
      '        access_level: all',
      '    members:',
      '      - kind: wa-group',
      `        id: ${CHAT}`,
      ...DO_ROOMS_LINES.slice(DO_ROOM_AT),
    ]);
    const h = home({ rooms: wrong });
    await expect(plan(ctxFor(h))).rejects.toThrow(
      /0023 refuses: `room\/acim-do` already exists in .*rooms\.yaml but its `agents\.don` is \{"access_level":"all"\} rather than a block stating `access_level: sandbox`/,
    );
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(wrong);
  });

  it('an existing `room/acim-do` carrying some OTHER group - the roster is the operator\'s', async () => {
    const other = crlf([
      ...DO_ROOMS_LINES.slice(0, DO_ROOM_AT),
      '  room/acim-do:',
      '    agents:',
      '      don:',
      '        access_level: sandbox',
      '    members:',
      '      - kind: wa-group',
      `        id: ${KG_CHAT}`,
      ...DO_ROOMS_LINES.slice(DO_ROOM_AT),
    ]);
    const h = home({ rooms: other });
    await expect(plan(ctxFor(h))).rejects.toThrow(
      /0023 refuses: `room\/acim-do` already exists in .*rooms\.yaml but its `members:` carries no `\{ kind: wa-group, id: MMF7iTSSiR3fc7UbbgM9 \}`/,
    );
  });

  it('an existing `contacts.room.acim-do` pointing somewhere else', async () => {
    const elsewhere = crlf([
      ...DO_CONV_LINES.slice(0, DO_CONV_AT),
      '    acim-do:',
      '      conversation_path: .egpt/conversations/room/acim-do',
      '      home_dir: /c/Users/an',
      ...DO_CONV_LINES.slice(DO_CONV_AT),
    ]);
    const h = home({ conversations: elsewhere });
    await expect(plan(ctxFor(h))).rejects.toThrow(
      /0023 refuses: `contacts\.room\.acim-do` in .*conversations\.yaml already reads "\.egpt\/conversations\/room\/acim-do" rather than "\.egpt\/rooms\/acim-do"/,
    );
    expect(readFileSync(convPath(h), 'utf8')).toBe(elsewhere);
  });

  it('a file edited between plan and apply, and nothing is written', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    const edited = DO_ROOMS.replace('# rooms.yaml - do (fixture)', '# rooms.yaml - do (edited)');
    writeFileSync(roomsPath(h), edited);
    await expect(p.apply()).rejects.toThrow(/0023 refuses: .*rooms\.yaml changed since it was planned - re-run/);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(edited);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO);      // the file it would have written FIRST
    expect(baks(h)).toEqual([]);
  });
});

describe('0023 through the runner', () => {
  // The Windows probes of 0001/0002/0004/0005 are told "nothing there", localAddresses is empty so
  // 0007 reads nothing as this node's own, and Chrome is handed in (as tests/migrations-0021-*).
  // `isDirectory` says neither fixture node holds 0024's Drive folder - without it the chain would
  // stat a real `G:` and the kg fixture below would gain an outbox target on the one machine that
  // has that folder, which is exactly the machine-dependence these seams exist to keep out.
  const ctx = {
    ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }),
    localAddresses: new Set(),
    findChrome: () => CHROME_EXE,
    isDirectory: () => false,
  };
  const dir = join(import.meta.dirname, '..', 'migrations');
  const ledgerOf = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'));
  const ID = '0023-do-drives-its-own-browser';

  it('do: applied and recorded, three files changed and a backup beside each', async () => {
    const h = home();
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledgerOf(h)[ID].outcome).toBe('applied');
    const after = doAfter(h);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(after.config);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(after.rooms);
    expect(readFileSync(convPath(h), 'utf8')).toBe(after.conversations);
    expect(baks(h).map((f) => f.replace(/\d{8}T\d{6}$/, '<stamp>')).sort()).toEqual([
      'config.yaml.bak-0023-<stamp>', 'conversations.yaml.bak-0023-<stamp>', 'rooms.yaml.bak-0023-<stamp>',
    ]);
  });

  it('kg converges too, recorded as already-satisfied with nothing written', async () => {
    const h = home({ config: KG, rooms: KG_ROOMS, conversations: KG_CONV });
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledgerOf(h)[ID].outcome).toBe('already-satisfied');
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
    expect(baks(h)).toEqual([]);
  });

  // THE ORDERING TEST. 0022 runs BEFORE this migration, so a room created here is never seen by
  // it — which is exactly why 0023 writes `compaction.ratio` itself. Re-run the WHOLE chain
  // against a node this has already converged (a lost ledger is survivable, setup/migrate.mjs)
  // and 0022 must find that ratio already stated and read satisfied, not write a second one.
  it('0022 has nothing to do on the room 0023 creates - on the same pass and on a later one', async () => {
    const fresh = home();
    await runMigrations({ dir, egptHome: fresh, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(ledgerOf(fresh)['0022-a-room-that-carries-every-chat-compacts-sooner'].outcome).toBe('already-satisfied');

    // …and again from scratch, this time with the room already in place before 0022 is asked.
    const converged = appliedHome();
    const text = readFileSync(roomsPath(converged), 'utf8');
    const { exitCode } = await runMigrations({ dir, egptHome: converged, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledgerOf(converged)['0022-a-room-that-carries-every-chat-compacts-sooner'].outcome).toBe('already-satisfied');
    expect(readFileSync(roomsPath(converged), 'utf8')).toBe(text);
    expect((text.match(/ratio: 0\.50/g) ?? [])).toHaveLength(1);
  });

  it('EVERY earlier migration reads satisfied on these fixtures - one that acted would invalidate them', async () => {
    for (const h of [home(), home({ config: KG, rooms: KG_ROOMS, conversations: KG_CONV }), appliedHome()]) {
      await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
      const earlier = Object.entries(ledgerOf(h)).filter(([id]) => id < '0023');
      expect(earlier.length).toBeGreaterThanOrEqual(22);
      expect(earlier.filter(([, e]) => e.outcome !== 'already-satisfied')).toEqual([]);
      // At most three backups in the whole chain, and they are this migration's: nothing earlier wrote.
      expect(baks(h).map((f) => f.replace(/\d{8}T\d{6}$/, '<stamp>')).sort().map((f) => f.split('.bak-')[1])).toEqual(
        ledgerOf(h)[ID].outcome === 'applied' ? ['0023-<stamp>', '0023-<stamp>', '0023-<stamp>'] : [],
      );
      rmSync(dirname(h), { recursive: true, force: true });
    }
  });
});
