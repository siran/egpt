// 0023 — the node that has `don` drives its OWN browser, from its own room.
//
// Operator, 2026-09-22: *"stop KG to DO remote driving. configure an acim-do/ room in do. then don
// can drive the browser natively as E did it KG."* Cross-node remote driving was considered and
// DROPPED. What replaces it is not a bridge: it is do having the same three things kg has had all
// along — a browser it knows where to find, a profile to drive it in, and a room a being sits in
// while it does. Nothing here crosses a node boundary; that is the whole point.
//
// THE THREE PIECES, each measured on do 2026-09-22 and each INDEPENDENTLY SATISFIABLE — a node
// that already has one keeps it and only the missing parts are written:
//
//   1. config.yaml has NO `chrome:` BLOCK AT ALL. kg's is `chrome:` → `bin:` + `profile_dir:`,
//      read by src/spine/commands.mjs (chromeBinOf / chromeProfileOf) and quoted to a being by
//      config/skeletons/room/30-pointers.md. Without it the spine falls back to a DISCOVERY
//      heuristic (resolveBrainProfile scans for a profile that has been used on an AI site), so a
//      being is handed whatever that scan found rather than the browser it was promised.
//   2. rooms.yaml has `room/lobby` and `room/dj-son` and no room for this. So the room is created.
//   3. conversations.yaml does not register it, and an unregistered room is a row nothing resolves
//      to: src/rooms-file.mjs mergeRoomBeings hydrates a room's per-being block by walking the
//      `room` surface of THAT file and looking up `room/<slug>` here. No entry there, no room.
//
// THE BINARY IS FOUND, NEVER SPELLED. Chrome is installed on do at the **x86** path
// (`C:/Program Files (x86)/…`) and the 64-bit path does not exist there; on kg it is the other way
// round. Both are already in src/tools/chrome-launcher.mjs's CHROME_PATHS, so this asks THAT
// locator — findChromeExecutable, the same function the spawner falls back to — and writes what it
// answers. Spelling one of the two paths here would be a migration that is right on exactly one
// machine. A node where the locator finds nothing gets no `bin:` line and a note: a path that is
// not there is a line that only lies (0015's reading), and the fallback it leaves in place is the
// behaviour that node already has.
//
// THE PROFILE IS DERIVED FROM THE PROFILE DIR — `<EGPT_HOME>/chrome/profiles/brain` — so a node
// with its profile elsewhere names its own. Only the last segment is spelled, and the operator
// ruled it stays `brain`: kg has a `brain` directory of its own, these are separate machines, and
// there is nothing for two same-named directories on two boxes to collide over.
//
// THE ROOM IS `room/acim-do`, and its two contents are both rulings:
//
//   `agents.<the being that answers to don>.access_level: sandbox` — operator: *"don must be
//   access_level: sandbox in acim-do"*. This is the PER-CONVERSATION rung (src/spine/brainpool.mjs
//   resolveConv reads it OVER `conversation_defaults`, src/conversations-state.mjs getBeing is the
//   one reader of `entry.agents.<being>.access_level`). The being's NODE-LEVEL
//   `conversation_defaults` is NOT touched: it stays whatever it is, and this room alone is
//   sandboxed.
//
//   `members: [{ kind: wa-group, id: MMF7iTSSiR3fc7UbbgM9, state: active }]` — operator: *"we can
//   link acim-do to the whatsapp group as well"*. THAT ID IS DO'S OWN VIEW of the group "perrito
//   traduciones". kg sees the same group as `0MP97ovrD6XvVovMVx6v`. The asymmetry is real and
//   load-bearing (tests/cross-account-chat-key.test.mjs is the lock on it): two Beeper accounts
//   bridge one WhatsApp group into two different Matrix rooms, so an id lifted from the other
//   node's registry would name NOTHING here. It is also why this id is what QUALIFIES the node —
//   see below.
//
// NO `threadId` IS WRITTEN. A thread is minted by the spine on the first turn (brainpool's
// no-thread branch, recorded by recordThread) and never by a migration: a hand-written id names a
// session that does not exist, and the being would resume into nothing.
//
// THE `compaction.ratio` IS WRITTEN HERE, AND THAT IS A DECISION ABOUT 0022, not a copy of it.
// 0022 gives every room carrying a `wa-group` member `compaction.ratio: 0.50` for the beings in
// it — this room is exactly such a room. But migrations run in FILE ORDER and each is recorded
// once (setup/migrate.mjs): 0022 runs BEFORE this file and is in the ledger by the time the room
// exists, so on the same pass — and on every later pass — 0022 will never see the room this
// creates. Leaving the ratio out would mean the one room the operator built this week is the one
// room 0022's ruling does not reach. Writing it here is also the only way a node that has run this
// migration is GENUINELY converged: re-run the whole chain against a lost ledger and 0022 finds
// the ratio already stated and reads satisfied ("this conversation already states its own
// threshold and is left alone"), so the two never collide and neither writes twice.
//
// QUALIFIED BY WHAT THIS NODE IS, never by its name, and BOTH halves are required:
//   - a being ANSWERING TO `don` — asked of src/spine/router.mjs's wakeTokens, THE definition of an
//     agent's wake vocabulary (0011/0016/0018/0019/0020/0021 all ask it), NEVER the map key. On do
//     that being is keyed `don` since 0018; on a node where it is keyed something else, the room's
//     `agents:` block is keyed by the KEY, because that is what getBeing looks a being up by.
//   - a CONVERSATION RECORD for chat id `MMF7iTSSiR3fc7UbbgM9` — this node's account actually has
//     that group. Resolved with the node's own getContact over its own parse(), and its own
//     shortChatId, so a full `!…:beeper.local` key matches the short id either way.
// kg has NEITHER, so kg reads SATISFIED WITH A NOTE and its own `chrome:` block is not disturbed.
//
// SATISFIED, NOT REFUSED — A REFUSAL STOPS EVERY LATER MIGRATION on that node (setup/migrate.mjs;
// the 0003/0007/0011/0012 lesson, which 0021 nearly repeated this week). "Nothing to do here" is a
// note: no `agents:` mapping; no being answering to `don`; no conversations.yaml at all; no record
// for that chat; each of the three pieces already in place; a `chrome:` key already stating a value
// (whatever it states — widening or repointing an operator's own path is a human decision, and
// 0022's precedent for an already-stated number is to leave it); a map with no column to match and
// no sibling to follow (an empty or flow `chrome:`, `rooms:` or `contacts.room:`), where the line
// would have to be placed by guess.
//
// IT REFUSES, NAMING THE PLACE, only on what it cannot honestly edit: no config.yaml, or a
// config.yaml / rooms.yaml / conversations.yaml that is not valid UTF-8 or does not parse (a splice
// would re-encode bytes it never meant to touch, and whether the node already holds these rows
// cannot be read); no rooms.yaml on a node that DOES qualify (the room has nowhere to go); MORE
// THAN ONE being answering to `don` (which one drives is a human decision, not a guess); an
// existing `chrome:` that is not a mapping; an existing `room/acim-do` that does not already say
// what this would write — a room half-built by hand is somebody's work in progress and splicing
// into it would produce a room neither of us designed; and an existing `contacts.room.acim-do`
// pointing at some other folder.
//
// THE PATH IS `rooms/`, NOT `conversations/room/`, and it is derived rather than chosen: src/
// room-core.mjs's ROOMS_ROOT is `<EGPT_HOME>/rooms`, so `<profile>/rooms/<slug>` is where a room's
// folder IS (conversations/ is the Beeper tree). kg's `acim`, `lobby` and `roger` read that way;
// `lu2`, `radio` and `dj-son` still carry the older `.egpt/conversations/room/<slug>` because they
// were minted before the roots split. This matches `acim`. conversations-state's own
// conversationPathOf computes exactly this — it is not CALLED because it reads the frozen
// process-wide EGPT_HOME, not the profile this migration was pointed at.
//
// THE EDITS ARE BYTE SPLICES (src/tools/config-io.mjs spliceYamlInsertKey, the whole-nested-block
// insertion 0015/0016/0022 use): nothing is re-serialized — a no-op `parseDocument().toString()`
// already rewrites these files — so CRLF, alignment, every other row and EVERY COMMENT survive,
// and each splice re-parses to prove the edit is that one key and nothing else.
//
// THE REASON TRAVELS WITH THE YAML in config.yaml and rooms.yaml, and NOWHERE ELSE: the spine
// rewrites conversations.yaml from memory on every state change (src/conversations-state.mjs
// serialize — "COMMENTS YOU ADD HERE DO NOT SURVIVE", config/skeletons/conversations.yaml), so a
// comment written there is erased by the next turn. NOTHING WRITTEN HERE COUNTS ANYTHING (0021's
// lesson): a comment that enumerates members becomes a lie the day a second group is invited, and
// `/members add group` will never come back to fix it.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlInsertKey } from '../src/tools/config-io.mjs';
import { wakeTokens } from '../src/spine/router.mjs';
import { findChromeExecutable } from '../src/tools/chrome-launcher.mjs';
import { parse, getContact, toMsysPath } from '../src/conversations-state.mjs';
import { shortChatId } from '../src/bridges/chat-id.mjs';

export const elevated = false;
export const summary = 'the node that has `don` drives its OWN Chrome: a `chrome:` block naming this machine\'s binary and profile, a `room/acim-do` the being sits in with the WhatsApp group invited, and the registry row that makes that room resolve';

const ID = '0023';
// The being this room is for, by HANDLE — never by key (on do it is keyed `don`, but that is
// 0018's doing and not a thing this may assume).
const HANDLE = 'don';
// THIS node's account's view of the group "perrito traduciones". kg's account sees the same group
// as 0MP97ovrD6XvVovMVx6v — see the header.
const CHAT = 'MMF7iTSSiR3fc7UbbgM9';
const SURFACE = 'room';
const SLUG = 'acim-do';
const NS = `${SURFACE}/${SLUG}`;
// The member kind that joins a chat to a room, written as the LITERAL the reader matches on
// (src/spine/boot.mjs's reverse lookup, `m.kind === 'wa-group'`; one of src/room-core.mjs's
// ROOM_MEMBER_KINDS), and the member state that means "everything it says enters".
const KIND = 'wa-group';
const STATE = 'active';
// The per-conversation level, and the block it lives in.
const LEVEL = 'sandbox';
// 0022's number, for 0022's reason — see the header on why it is written from here. `0.50` because
// that is how it reads everywhere else in these profiles; YAML loads it as 0.5 either way.
const RATIO = '0.50';
// The one segment of the profile path that is spelled rather than derived (operator: reuse it).
const PROFILE = 'brain';
// config.yaml's browser block and its two keys, as src/spine/commands.mjs reads them.
const CHROME = 'chrome';
const BIN = 'bin';
const PROFILE_DIR = 'profile_dir';
// conversations.yaml's registry rung.
const CONTACTS = 'contacts';
const PATH_KEY = 'conversation_path';
const HOME_KEY = 'home_dir';

const refuse = (why) => { throw new Error(`${ID} refuses: ${why}`); };
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// JSON.stringify prints undefined as nothing and NaN/Infinity as `null`, which would name the
// wrong thing in a refusal.
const show = (v) => (v === undefined ? 'undefined' : (typeof v === 'number' && !Number.isFinite(v) ? String(v) : JSON.stringify(v)));
// These files write paths with forward slashes; node's join hands back the platform's.
const slash = (p) => String(p).replace(/\\/g, '/');
// ONE scalar as the library itself would write it: plain when YAML's own rules allow it, quoted the
// moment it would otherwise be misread. Every value below happens to come out plain, and none of
// them is trusted to stay that way.
const scalar = (v) => YAML.stringify(v, { lineWidth: 0 }).trim();
const agentEntries = (agents) => Object.entries(agents).filter(([n, a]) => isMap(a) && !n.startsWith('_'));

// A config file, read the ONE way every migration reads one: bytes first (so a splice can never
// re-encode what it did not touch), then a parse that must succeed.
function open(file) {
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; a splice would re-encode bytes it never meant to touch`);
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);
  return { file, bytes, text, doc, data: doc.toJS(), next: text };
}

const nodeAt = (f, path) => (path.length ? f.doc.getIn(path, true) : f.doc.contents);
// The column a mapping's own keys sit at, read off the file: spliceYamlInsertKey refuses text that
// is indented for a different map, which is how an insertion silently nests one block inside its
// neighbour. Read from the ORIGINAL document — an insertion elsewhere moves offsets but never a
// surviving line's indent.
const columnOf = (f, path) => {
  const node = nodeAt(f, path);
  const keyAt = node.items[0].key.range[0];
  return ' '.repeat(keyAt - (f.text.lastIndexOf('\n', keyAt - 1) + 1));
};
// A map this layer can insert into at all: block style (a flow `{}` puts its entries on one line)
// and carrying at least one key (there is no column to match and no sibling to follow otherwise).
const writable = (f, path) => {
  const node = nodeAt(f, path);
  return YAML.isMap(node) && !node.flow && node.items.length > 0;
};

// The lines ONE splice added, read off the two texts rather than guessed — the same rendering
// 0015/0016/0022 use, so a `changes` list reads identically across migrations.
function addedLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = b.length - a.length;
  let s = 0;
  while (s < a.length && a[s] === b[s]) s++;
  return { first: s + 1, last: s + n, lines: b.slice(s, s + n).map((l) => l.replace(/\r$/, '')) };
}

// ── the text, AS IT WILL READ in the operator's files ────────────────────────────────────────
// Every block below is written by hand rather than serialized from data, for the reason the splice
// layer's own header gives: the caller owns the comment lines, the alignment and the quoting.

const binLines = (pad, bin) => [
  `${pad}# WHERE CHROME IS ON THIS NODE, found by the node's OWN locator`,
  `${pad}# (src/tools/chrome-launcher.mjs findChromeExecutable) rather than spelled here: the`,
  `${pad}# 64-bit and the x86 install paths are both real and a machine has whichever it has.`,
  `${pad}# A being is TOLD this path (config/skeletons/room/30-pointers.md), so it launches the`,
  `${pad}# browser instead of guessing where Chrome lives.`,
  `${pad}${BIN}: ${scalar(bin)}`,
];
const profileLines = (pad, dir) => [
  `${pad}# THE --user-data-dir A BEING DRIVES OVER CDP. Chrome refuses CDP on its own DEFAULT`,
  `${pad}# profile (an anti-hijack guardrail), and a blank profile launches fine but is logged in`,
  `${pad}# to nothing - so this names a profile kept for the purpose, under THIS node's own`,
  `${pad}# profile dir. The name \`${PROFILE}\` is reused deliberately (${ID}, operator 2026-09-22):`,
  `${pad}# another node's \`${PROFILE}\` is a different directory on a different machine, so there is`,
  `${pad}# nothing here to collide with. The directory is created on first launch; logging it in`,
  `${pad}# is a hand gesture this migration does not pretend to make.`,
  `${pad}${PROFILE_DIR}: ${scalar(dir)}`,
];
const chromeBlock = (pad, parts) => [
  `${pad}# THE BROWSER THIS NODE DRIVES ITSELF (${ID}, operator 2026-09-22: "stop KG to DO remote`,
  `${pad}# driving. configure an acim-do/ room in do. then don can drive the browser natively as E`,
  `${pad}# did it KG"). Read by src/spine/commands.mjs (chromeBinOf / chromeProfileOf) and quoted to`,
  `${pad}# a being by the pointers card. A node stating neither key falls back to a per-platform`,
  `${pad}# path search and a profile-scanning HEURISTIC; naming them makes "the browser I was`,
  `${pad}# promised" the browser that actually launches.`,
  `${pad}${CHROME}:`,
  ...parts.map((l) => `${pad}${l}`),
].join('\n');

const roomLines = (pad, being) => [
  `${pad}# A BEING DRIVES THIS NODE'S OWN BROWSER FROM HERE (${ID}, operator 2026-09-22: "stop KG`,
  `${pad}# to DO remote driving. configure an acim-do/ room in do. then don can drive the browser`,
  `${pad}# natively as E did it KG"). The browser is this node's own - config.yaml's \`${CHROME}:\``,
  `${pad}# block names the binary and the profile - so nothing here is driven across a node`,
  `${pad}# boundary, which is the whole point of the room rather than a bridge.`,
  `${pad}${NS}:`,
  `${pad}  agents:`,
  `${pad}    ${being}:`,
  `${pad}      # SANDBOXED IN THIS ROOM, whatever this being's node-level default says (${ID},`,
  `${pad}      # operator 2026-09-22: "don must be access_level: sandbox in acim-do"). This is the`,
  `${pad}      # PER-CONVERSATION rung src/spine/brainpool.mjs resolveConv reads OVER the being's`,
  `${pad}      # conversation_defaults, so its level everywhere else is untouched.`,
  `${pad}      access_level: ${scalar(LEVEL)}`,
  `${pad}      # HALF THE WINDOW, NOT THE NODE'S RATIO (0022's ruling, written here because 0022`,
  `${pad}      # runs BEFORE this file and so can never see a room this migration creates). A chat`,
  `${pad}      # joined below as a \`${KIND}\` member resolves to THIS conversation's one thread`,
  `${pad}      # (src/spine/identity-scope.mjs), so the thread is trimmed well before brainpool's`,
  `${pad}      # overflow backstop can RESET it to a fresh session.`,
  `${pad}      compaction:`,
  `${pad}        ratio: ${RATIO}`,
  `${pad}  # The WhatsApp group invited into this room, as THIS node's account sees it. Two Beeper`,
  `${pad}  # accounts bridge one group into two different rooms, so the id another node's registry`,
  `${pad}  # carries for the same group would name nothing here.`,
  `${pad}  members:`,
  `${pad}    - kind: ${scalar(KIND)}`,
  `${pad}      id: ${scalar(CHAT)}`,
  `${pad}      state: ${scalar(STATE)}`,
];

// conversations.yaml carries NO comment from this migration - the spine rewrites the file from
// memory on every state change and erases them (see the header).
const entryLines = (pad, path, home) => [
  `${pad}${SLUG}:`,
  `${pad}  ${PATH_KEY}: ${scalar(path)}`,
  `${pad}  ${HOME_KEY}: ${scalar(home)}`,
];
const surfaceLines = (pad, path, home) => [
  `${pad}${SURFACE}:`,
  ...entryLines(`${pad}  `, path, home),
];

export async function plan(ctx) {
  // ── who this node is ────────────────────────────────────────────────────────────────────────
  const configFile = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(configFile)) refuse(`there is no ${configFile}`);
  const config = open(configFile);

  const agents = isMap(config.data) ? config.data.agents : undefined;
  if (!isMap(agents)) return { satisfied: true, notes: [`${configFile} has no \`agents:\` mapping, so nothing here answers to \`${HANDLE}\``] };

  // THE HANDLE, NOT THE KEY (see the header). The KEY is what comes back, because that is what a
  // room's per-being block is keyed by (src/conversations-state.mjs getBeing).
  const answering = agentEntries(agents).filter(([name, a]) => wakeTokens(name, a).includes(HANDLE)).map(([name]) => name);
  if (!answering.length) {
    return { satisfied: true, notes: [`no being in ${configFile} answers to \`${HANDLE}\`, so this node is not the one that drives a browser from \`${NS}\``] };
  }
  if (answering.length > 1) {
    refuse(`${answering.length} beings in ${configFile} answer to \`${HANDLE}\` (${answering.join(', ')}) - which one drives this node's browser is a human decision, not a guess`);
  }
  const being = answering[0];

  // ── does this node's account actually have that group ───────────────────────────────────────
  const convFile = join(ctx.egptHome, 'config', 'conversations.yaml');
  if (!existsSync(convFile)) {
    return { satisfied: true, notes: [`there is no ${convFile}, so this node has no conversation for chat ${CHAT} and no group to invite into \`${NS}\``] };
  }
  const conv = open(convFile);
  // The node's OWN reading of its own registry: parse() re-hydrates the slim file, getContact
  // resolves an alias row to its primary, and shortChatId normalizes a legacy full
  // `!…:beeper.local` key to the short id these registries use.
  const state = parse(conv.text);
  let record = null;
  for (const [surface, bucket] of Object.entries(state?.contacts ?? {})) {
    if (!isMap(bucket)) continue;
    for (const key of Object.keys(bucket)) {
      if (shortChatId(key) !== CHAT) continue;
      const c = getContact(state, surface, key);
      if (c) { record = { surface, key, slug: c.slug }; break; }
    }
    if (record) break;
  }
  if (!record) {
    return { satisfied: true, notes: [`no conversation in ${convFile} is chat ${CHAT}, so this node's account is not in that group and has nothing to invite into \`${NS}\``] };
  }

  const notes = [];
  const edits = [];   // { f, path, key, text, label }

  // ── 1. the browser this node drives ─────────────────────────────────────────────────────────
  const existing = isMap(config.data) ? config.data[CHROME] : undefined;
  if (existing !== undefined && !isMap(existing)) {
    refuse(`\`${CHROME}:\` in ${configFile} is ${show(existing)}, not a mapping - src/spine/commands.mjs reads \`${BIN}\`/\`${PROFILE_DIR}\` inside it, and this migration will not guess what a hand edit meant`);
  }
  // The node's own locator, with a test seam (the pattern 0007 set with ctx.localAddresses):
  // production asks src/tools/chrome-launcher.mjs, which is what the spawner itself falls back to.
  const found = (ctx.findChrome ?? findChromeExecutable)();
  const bin = found ? slash(found) : null;
  const profileDir = slash(join(ctx.egptHome, CHROME, 'profiles', PROFILE));

  const wantChrome = [];   // [key, lines(pad)]
  if (existing === undefined || !Object.hasOwn(existing, BIN)) {
    if (bin) wantChrome.push([BIN, (pad) => binLines(pad, bin)]);
    else notes.push(`no Chrome is installed where src/tools/chrome-launcher.mjs looks on this node, so no \`${CHROME}.${BIN}\` is written into ${configFile} - a path that is not there is a line that only lies, and the platform search it falls back to is what this node already does`);
  } else {
    notes.push(`\`${CHROME}.${BIN}\` in ${configFile} already reads ${show(existing[BIN])} - this node already names its own browser and is left alone`);
  }
  if (existing === undefined || !Object.hasOwn(existing, PROFILE_DIR)) {
    wantChrome.push([PROFILE_DIR, (pad) => profileLines(pad, profileDir)]);
  } else {
    notes.push(`\`${CHROME}.${PROFILE_DIR}\` in ${configFile} already reads ${show(existing[PROFILE_DIR])} - this node already names the profile a being drives and is left alone`);
  }

  if (wantChrome.length) {
    if (existing === undefined) {
      if (!writable(config, [])) {
        notes.push(`${configFile} has no top-level keys to follow, so where a \`${CHROME}:\` block belongs would be a guess - not added here`);
      } else {
        const pad = columnOf(config, []);
        edits.push({
          f: config,
          path: [],
          key: CHROME,
          text: chromeBlock(pad, wantChrome.flatMap(([, lines]) => lines('  '))),
          label: `the node's \`${CHROME}:\` block (${wantChrome.map(([k]) => `\`${k}\``).join(' and ')})`,
        });
      }
    } else if (!writable(config, [CHROME])) {
      notes.push(`\`${CHROME}:\` in ${configFile} is an empty or flow mapping - there is no column to match and no sibling to follow, so where a \`${wantChrome[0][0]}:\` line belongs would be a guess`);
    } else {
      const pad = columnOf(config, [CHROME]);
      for (const [key, lines] of wantChrome) {
        edits.push({ f: config, path: [CHROME], key, text: lines(pad).join('\n'), label: `\`${CHROME}.${key}\`` });
      }
    }
  }

  // ── 2. the room itself ──────────────────────────────────────────────────────────────────────
  const roomsFile = join(ctx.egptHome, 'config', 'rooms.yaml');
  // A node that QUALIFIES and has no rooms registry has nowhere to put the room, and pretending
  // otherwise would report a converged node that has no room. Unqualified nodes never reach here.
  if (!existsSync(roomsFile)) refuse(`there is no ${roomsFile}, so \`${NS}\` has nowhere to live on a node that answers to \`${HANDLE}\``);
  const rooms = open(roomsFile);
  // BOTH SHAPES src/rooms-file.mjs readRoomsFile tolerates, read its way: the wrapped `rooms:` map
  // when there is one, else a bare top-level map of rows.
  const wrapped = isMap(rooms.data) && isMap(rooms.data.rooms);
  const rows = wrapped ? rooms.data.rooms : (isMap(rooms.data) ? rooms.data : null);
  const base = wrapped ? ['rooms'] : [];
  const row = rows ? rows[NS] : undefined;

  if (row !== undefined) {
    // AN EXISTING ROW IS CHECKED AGAINST THE TWO THINGS THIS ROOM IS FOR, and nothing else: a
    // ratio somebody tightened by hand is their decision (0022's precedent), and so is any other
    // key. Anything less than these two is a room half-built by a hand this cannot second-guess.
    if (!isMap(row)) refuse(`\`${NS}\` in ${roomsFile} is ${show(row)}, not a room row - this migration will not guess what a hand edit meant`);
    const block = isMap(row.agents) ? row.agents[being] : undefined;
    if (!isMap(block) || block.access_level !== LEVEL) {
      refuse(`\`${NS}\` already exists in ${roomsFile} but its \`agents.${being}\` is ${show(isMap(row.agents) ? row.agents[being] : undefined)} rather than a block stating \`access_level: ${LEVEL}\` - a room half-built by hand is a human decision, and splicing into one would make a room neither this migration nor its author designed`);
    }
    const members = Array.isArray(row.members) ? row.members : [];
    if (!members.some((m) => isMap(m) && m.kind === KIND && shortChatId(m.id) === CHAT)) {
      refuse(`\`${NS}\` already exists in ${roomsFile} but its \`members:\` carries no \`{ kind: ${KIND}, id: ${CHAT} }\` - the roster is the operator's (\`/members add group\`), so which group this room is for is a human decision`);
    }
    notes.push(`\`${NS}\` in ${roomsFile} already has \`${being}\` at \`access_level: ${LEVEL}\` with the \`${KIND}\` member ${CHAT} - the room is already what this would make it`);
  } else if (!rows || !writable(rooms, base)) {
    notes.push(`${roomsFile} holds no room rows to follow, so where \`${NS}\` belongs would be a guess - not added here`);
  } else {
    const pad = columnOf(rooms, base);
    edits.push({ f: rooms, path: base, key: NS, text: roomLines(pad, being).join('\n'), label: `the room \`${NS}\`, with \`${being}\` sandboxed in it and the \`${KIND}\` member ${CHAT}` });
  }

  // ── 3. the registry row that makes the room resolve ─────────────────────────────────────────
  // `<profile>/rooms/<slug>`, paired with the home it is relative to — src/room-core.mjs's
  // ROOMS_ROOT rendered the way src/conversations-state.mjs stores a pointer (see the header).
  const convPath = `${slash(basename(ctx.egptHome))}/rooms/${SLUG}`;
  const homeDir = toMsysPath(dirname(ctx.egptHome));
  const contacts = isMap(conv.data) ? conv.data[CONTACTS] : undefined;
  const bucket = isMap(contacts) ? contacts[SURFACE] : undefined;
  const already = isMap(bucket) ? bucket[SLUG] : undefined;

  if (already !== undefined) {
    if (!isMap(already) || already[PATH_KEY] !== convPath) {
      refuse(`\`${CONTACTS}.${SURFACE}.${SLUG}\` in ${convFile} already reads ${show(isMap(already) ? already[PATH_KEY] : already)} rather than ${show(convPath)} - a conversation that is registered somewhere else is a human decision, not a path to overwrite`);
    }
    notes.push(`\`${CONTACTS}.${SURFACE}.${SLUG}\` in ${convFile} already points at ${convPath} - the room is already registered`);
  } else if (!isMap(contacts)) {
    // Unreachable while a chat record qualified this node above, and named rather than assumed.
    notes.push(`${convFile} has no \`${CONTACTS}:\` mapping, so where \`${SURFACE}.${SLUG}\` belongs would be a guess - not added here`);
  } else if (bucket === undefined) {
    if (!writable(conv, [CONTACTS])) {
      notes.push(`\`${CONTACTS}:\` in ${convFile} is an empty or flow mapping - there is no column to match and no sibling to follow, so where a \`${SURFACE}:\` block belongs would be a guess`);
    } else {
      const pad = columnOf(conv, [CONTACTS]);
      edits.push({ f: conv, path: [CONTACTS], key: SURFACE, text: surfaceLines(pad, convPath, homeDir).join('\n'), label: `the \`${SURFACE}\` surface and \`${SLUG}\` in it, pointing at ${convPath}` });
    }
  } else if (!writable(conv, [CONTACTS, SURFACE])) {
    notes.push(`\`${CONTACTS}.${SURFACE}:\` in ${convFile} is an empty or flow mapping - there is no column to match and no sibling to follow, so where \`${SLUG}\` belongs would be a guess`);
  } else {
    const pad = columnOf(conv, [CONTACTS, SURFACE]);
    edits.push({ f: conv, path: [CONTACTS, SURFACE], key: SLUG, text: entryLines(pad, convPath, homeDir).join('\n'), label: `\`${CONTACTS}.${SURFACE}.${SLUG}\`, pointing at ${convPath}` });
  }

  if (!edits.length) {
    return {
      satisfied: true,
      notes: [`this node answers to \`${HANDLE}\` (agents.${being}) and has chat ${CHAT} as \`${record.surface}/${record.slug}\`, and every piece \`${NS}\` needs is already in place`, ...notes],
    };
  }

  // Applied in document order, each onto the last, and each file is written ONCE — after a backup
  // and a changed-since-planned guard.
  const changes = [];
  for (const e of edits) {
    const before = e.f.next;
    try { e.f.next = spliceYamlInsertKey(before, e.path, { key: e.key, text: e.text }); }
    catch (err) { refuse(`${e.label} cannot be written into ${e.f.file} (${err?.message ?? err})`); }
    const { first, last, lines } = addedLines(before, e.f.next);
    changes.push(`${e.f.file}:${first}-${last}  insert ${e.label} (${lines.length} lines):`, ...lines.map((l) => `  + ${l}`));
  }
  changes.push(
    `agents.${being} answers to \`${HANDLE}\`, and this node's account has chat ${CHAT} as \`${record.surface}/${record.slug}\` - so that group's turns reach \`${NS}\`, where this being drives THIS machine's own Chrome`,
    ...notes,
    `backup first, beside each: <file>.bak-${ID}-<timestamp>`,
  );

  const touched = [...new Set(edits.map((e) => e.f))];
  return {
    satisfied: false,
    changes,
    apply: async () => {
      for (const f of touched) if (!readFileSync(f.file).equals(f.bytes)) refuse(`${f.file} changed since it was planned - re-run`);
      for (const f of touched) {
        ctx.log(`backup: ${ctx.backup(f.file)}`);
        writeFileSync(f.file, f.next, 'utf8');
      }
    },
  };
}
