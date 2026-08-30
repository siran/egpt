// tests/spine-transcript.test.mjs — the §3.1 stats-collector chokepoint: transcript.log()
// fires recordMemberStat fire-and-forget on every received message, and NEVER throws/rejects
// even when the collector's io read/write blows up. Same createTranscript harness shape as
// spine-v1.test.mjs (fake contacts resolver + fake io).
import { describe, it, expect, vi } from 'vitest';
import { createTranscript } from '../src/spine/transcript.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { editAction } from '../src/dispatch-line.mjs';
import { Room } from '../src/room-core.mjs';

// The collector is fire-and-forget (not awaited by log()); give its async read-merge-write
// a beat to land before asserting on the written stats.yaml.
const settle = () => new Promise((r) => setTimeout(r, 25));

// resolveStatFilename (inside recordMemberStat) scans the surface dir by body id to find a
// possibly-renamed stats file — so the collector io must virtualize readdir over the same
// Map its readFile/writeFile use (else it would fall back to the REAL fs). Lists the basenames
// of the map keys living directly under `dir` (paths normalized so Windows backslashes match).
const readdirOver = (files) => async (dir) => {
  const norm = (p) => String(p).replace(/\\/g, '/');
  const prefix = norm(dir).replace(/\/$/, '') + '/';
  const out = new Set();
  for (const k of files.keys()) {
    const nk = norm(k);
    if (nk.startsWith(prefix)) { const rest = nk.slice(prefix.length); if (!rest.includes('/')) out.add(rest); }
  }
  return [...out];
};

// A fake contacts resolver: chatId → a fixed slug (no rename self-heal needed here).
const fakeContacts = { resolve: async () => 'fam-1234567890' };

const ev = {
  surface: 'whatsapp', node: 'wa', chatId: '!room:beeper.com', chatName: 'fam',
  senderId: '@whatsapp_555:beeper.local', ts: Date.UTC(2026, 6, 3, 14, 22),
  line: 'An@[fam].wa (14:22) #m1: hola', body: 'hola',
};

describe('transcript.log — §3.1 stats collector chokepoint', () => {
  it('fires the member collector into BOTH the per-chat and per-contact stats files (fire-and-forget)', async () => {
    const files = new Map();
    const io = {
      appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); },
      mkdir: async () => {},
      existsSync: (p) => files.has(p),
      readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
      writeFile: async (p, d) => { files.set(p, d); },
      readdir: readdirOver(files),
    };
    const t = createTranscript({ contacts: fakeContacts, io });
    expect(await t.log(ev)).toBe(true);
    await settle();
    // per-CHAT file: named by the chat DISPLAY name now (ev.chatName='fam' → fam.yaml), not the
    // opaque chatId — the members: map counter + the chat name land in it.
    const chat = [...files.entries()].find(([p]) => p.endsWith('fam.yaml'));
    expect(chat).toBeTruthy();
    expect(chat[1]).toContain('@whatsapp_555:beeper.local');   // the senderId keyed the counter
    expect(chat[1]).toContain('count: 1');
    expect(chat[1]).toContain('2026-07-03T14:22');             // last_seen = isoFromMs(ev.ts)
    expect(chat[1]).toContain('name: fam');                    // chat display name written onto the per-chat file
    // per-CONTACT file: keyed by the SANITIZED senderId (':' -> ~3a), flat rollup, NO name (ev has none)
    const contact = [...files.entries()].find(([p]) => p.endsWith('@whatsapp_555~3abeeper.local.yaml'));
    expect(contact).toBeTruthy();
    expect(contact[1]).toContain('count: 1');
    expect(contact[1]).toContain('2026-07-03T14:22');
    expect(contact[1]).not.toContain('name:');                 // ev carries no senderName → name never invented
  });

  it('threads ev.senderName into the per-contact file when the event carries one', async () => {
    const files = new Map();
    const io = {
      appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); },
      mkdir: async () => {},
      existsSync: (p) => files.has(p),
      readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
      writeFile: async (p, d) => { files.set(p, d); },
      readdir: readdirOver(files),
    };
    const t = createTranscript({ contacts: fakeContacts, io });
    expect(await t.log({ ...ev, senderName: 'Andrés' })).toBe(true);
    await settle();
    // present senderName → the contact file is NAMED by it (Andrés.yaml), and name is on the body.
    const contact = [...files.entries()].find(([p]) => p.endsWith('Andrés.yaml'));
    expect(contact).toBeTruthy();
    expect(contact[1]).toContain('name: Andrés');              // present senderName → refreshed onto the contact rollup
    expect(contact[1]).toContain('@whatsapp_555:beeper.local');  // body sender_id anchor preserved
  });

  // THE BEING'S LABEL IS ITS NAME (operator 2026-08-28: "the only agent named egpt lives in kg.
  // in do there is don" / "the agent name is the identifier"). The reply line's speaker is
  // labelOf(being) — the agents-registry `name:`, else the map key — and nothing else: no
  // `.<node_name>` qualifier any more, because names are unique across the shared account by
  // construction. Unwired labelOf (tests) falls back to the key.
  const mkIo = (files) => ({
    appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); },
    mkdir: async () => {},
    existsSync: (p) => files.has(p),
    readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
    writeFile: async (p, d) => { files.set(p, d); },
    readdir: readdirOver(files),
  });
  const transcriptText = (files) => [...files.entries()].find(([p]) => p.endsWith('transcript.md'))?.[1] ?? '';

  // THE LIVE DEFECT (2026-07-26): this append — the only writer of a transcript's front
  // matter — passed the CHAT id as the thread, so conversations/shell/lobby/transcript.md
  // opened with `thread_id: main` (the shell chat id) and `chat_id` was never written at all.
  // Two DIFFERENT static keys (operator: "in beeper we have the chat-id, for agents the
  // thread-id"): ingestion knows only the chat id, and the thread slot stays empty until a
  // thread exists (stampThreadId fills it).
  it('the ingestion header carries chat_id — the thread slot is NOT the chat id', async () => {
    const files = new Map();
    const t = createTranscript({ contacts: fakeContacts, io: mkIo(files) });
    expect(await t.log(ev)).toBe(true);
    const text = transcriptText(files);
    expect(text).toContain(`chat_id: ${ev.chatId}`);
    expect(text).not.toContain('thread_id:');
  });

  it('labels the PERSONA reply with its NAME, bare — no sigil, no node qualifier', async () => {
    const files = new Map();
    const t = createTranscript({ contacts: fakeContacts, io: mkIo(files), defaultKey: 'egpt', labelOf: (b) => b });
    expect(await t.log(ev, { text: 'hi from egpt', being: 'egpt', surfaced: true })).toBe(true);
    const text = transcriptText(files);
    expect(text).toContain('egpt@[fam].wa ');
    expect(text).not.toContain('@egpt@[');          // the sigil is gone
    expect(text).not.toContain('egpt.kg@[');        // …and so is the node qualifier
  });

  // REPRODUCE-FIRST (operator 2026-08-28, live on DOLLY): the persona is KEYED `egpt` but is
  // `name: don` and wakes on [d, don], so the record used to read `@egpt.do` for an agent nobody
  // calls egpt. The label routes through the SAME labelOf boot hands createSender, so the
  // transcript and the chat now call the agent one name.
  it('a being whose config `name:` differs from its map key is recorded by the NAME', async () => {
    const files = new Map();
    const agents = { egpt: { name: 'don', handles: ['d', 'don'], default: true } };
    const labelOf = (b) => agents[String(b).toLowerCase()]?.name ?? String(b);
    const t = createTranscript({ contacts: fakeContacts, io: mkIo(files), defaultKey: 'egpt', labelOf });
    await t.log(ev, { text: 'dale', being: 'egpt' });
    const text = transcriptText(files);
    expect(text).toContain('don@[fam].wa (');
    expect(text).not.toContain('egpt');
  });

  it('a LOCAL SIBLING is labelled the same way (one resolver for every being)', async () => {
    const files = new Map();
    const t = createTranscript({ contacts: fakeContacts, io: mkIo(files) });
    await t.log(ev, { text: 'sibling line', being: 'wren' });
    expect(transcriptText(files)).toContain('wren@[fam].wa ');
  });

  // The reply line's clock reads in the node's configured zone (config `default_time_zone`,
  // boot-resolved with the heartbeat loader's resolveTimeZone) — the same clock the inbound
  // line renders. Unset -> UTC, exactly as before (operator 2026-07-26).
  it('renders the reply-line clock in the injected time zone', async () => {
    const files = new Map();
    const t = createTranscript({ contacts: fakeContacts, io: mkIo(files), defaultKey: 'egpt', timeZone: 'America/New_York', now: () => new Date(Date.UTC(2026, 6, 25, 19, 7)) });
    await t.log(ev, { text: 'hi', being: 'egpt' });
    expect(transcriptText(files)).toContain('egpt@[fam].wa (15:07): hi');
  });

  it('never throws/rejects when the collector io read/write throws — transcript still appended', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const files = new Map();
    const io = {
      appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); },
      mkdir: async () => {},
      existsSync: (p) => files.has(p),
      readFile: async () => { throw new Error('read blew up'); },
      writeFile: async () => { throw new Error('write blew up'); },
      readdir: readdirOver(files),
    };
    try {
      const t = createTranscript({ contacts: fakeContacts, io });
      await expect(t.log(ev)).resolves.toBe(true);   // collector failure is swallowed, log() still succeeds
      await settle();
      const transcript = [...files.entries()].find(([p]) => p.endsWith('transcript.md'));
      expect(transcript[1]).toContain('hola');        // the transcript append path is untouched by the collector
      expect(consoleError).toHaveBeenCalledTimes(2);
      expect(consoleError.mock.calls.every(([message]) => String(message).includes('write blew up'))).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });
});

// A LIVING-MIRROR STREAM FRAME IS NOT HISTORY (operator 2026-07-26: "it's better if the
// streaming is not logged"). A bot reply on this shared Beeper account is ONE message
// progressively rewritten in place (src/spine/sender.mjs `update()` stamps every
// intermediate frame with the ⏳ live marker; `finish()` posts the settled text without
// it). Each rewrite re-upserts the message, so a node OBSERVING a peer's reply saw every
// frame as an incoming `edited #<id>` stage-direction: 492 of them / 35% of the live
// SPOILER transcript, five-plus giant near-identical blocks per reply, burying the
// operator's own messages between them.
//
// A genuine human edit of an earlier message is REAL HISTORY and must still be logged —
// so the guard keys on the frame marker sender.mjs itself stamps, nothing else.
describe('transcript.log — living-mirror stream frames are not recorded', () => {
  const mkIo = (files) => ({
    appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); },
    mkdir: async () => {},
    existsSync: (p) => files.has(p),
    readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
    writeFile: async (p, d) => { files.set(p, d); },
    readdir: readdirOver(files),
  });
  const transcriptText = (files) => [...files.entries()].find(([p]) => p.endsWith('transcript.md'))?.[1] ?? '';
  const identity = createIdentity({ now: () => Date.UTC(2026, 6, 25, 19, 10) });
  const peer = {
    chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp',
    userId: 'u1', senderName: 'An', isStageDirection: true, msgKey: '176209',
  };
  const editEv = (targetId, oldText, newText, from = peer) =>
    identity.build({ body: editAction({ targetId, oldText, newText }), from: { ...from, msgKey: targetId } });

  it('a stream sequence logs ONE settled entry and no frame blocks; a human edit of an older message still logs', async () => {
    const files = new Map();
    const t = createTranscript({ contacts: fakeContacts, io: mkIo(files) });

    // 1. the peer's placeholder arrives as an ordinary message (recorded, as today)
    await t.log(identity.build({ body: '🤝 don\n⏳ Thinking…', from: { ...peer, isStageDirection: false } }));

    // 2. its living-mirror frames — every intermediate carries the ⏳ marker
    const frames = [
      '🤝 don Buen lugar random para ⏳',
      '🤝 don Buen lugar random para verla — ¿la disfrutaste o se sint ⏳',
    ];
    let prev = '🤝 don ⏳ Thinking…';
    for (const f of frames) { await t.log(editEv('176209', prev, f)); prev = f; }

    // 3. the SETTLE — sender.finish() posts the answer with no ⏳
    const settled = '🤝 don Buen lugar random para verla — ¿la disfrutaste o se sintió como fan service comparada con la original?';
    await t.log(editEv('176209', prev, settled));

    // 4. a HUMAN correcting a typo in an OLDER message — real history, must survive
    await t.log(editEv('155403', 'parece la corte frances', 'parece la corte francesa', { ...peer, senderName: 'Andrés' }));

    const text = transcriptText(files);
    expect(text.match(/edited #\d+/g)).toEqual(['edited #176209', 'edited #155403']);
    expect(text).toContain(`+ ${settled}`);             // the settled text IS on the record
    expect(text).toContain('parece la corte francesa'); // the human edit IS on the record
    expect(text).not.toContain('Buen lugar random para ⏳');   // frame 1 is gone entirely

    // KNOWN RESIDUE, deliberately not asserted away: the settle entry's `-` side is the
    // LAST partial. The baseline an edit diffs against is the BRIDGE's per-message
    // _seenText (src/bridges/beeper.mjs), which advances on every frame — so the settle
    // diffs against frame N, not against the placeholder. Suppressing the frames at that
    // baseline instead would make this entry read "placeholder → settled"; it is a
    // two-line change in a file this chunk does not own.
  });

  // THE REAL SHAPE ON A LIVE NODE (2026-07-26): the bridge signature is structural, so every
  // frame — placeholder and intermediate alike — is wrapped, open ABOVE the core and close
  // BELOW it. ⏳ is therefore never the last character of a real frame, and the close differs
  // per node. An unsigned-only fixture set would leave this guard green while it suppressed
  // nothing in production.
  it('recognises SIGNED frames too — the marker is not at the end of a real frame', async () => {
    const files = new Map();
    const t = createTranscript({ contacts: fakeContacts, io: mkIo(files) });
    const wrap = (core) => `🌉kg\n${core}\n🌉`;                    // this node's bridge layer
    const placeholder = wrap('🤝 don\n⏳ Thinking…');
    const frames = [wrap('🤝 don\nBuen lugar random para ⏳'), wrap('🤝 don\nBuen lugar random para verla — ¿la disfrutaste ⏳')];
    const settled = wrap('🤝 don\nBuen lugar random para verla — ¿la disfrutaste o se sintió como fan service?');

    let prev = placeholder;
    for (const f of [...frames, settled]) { await t.log(editEv('176209', prev, f)); prev = f; }

    const text = transcriptText(files);
    expect(text.match(/edited #\d+/g)).toEqual(['edited #176209']);   // the settle only
    expect(text).toContain('se sintió como fan service?');
    expect(text).not.toContain('Buen lugar random para ⏳');
  });

  it('a stream frame is not a received message either — no stats side-effect', async () => {
    const files = new Map();
    const t = createTranscript({ contacts: fakeContacts, io: mkIo(files) });
    expect(await t.log(editEv('176209', '🤝 don ⏳ Thinking…', '🤝 don Buen lugar ⏳'))).toBe(false);
    await settle();
    expect([...files.keys()].some((p) => p.endsWith('.yaml'))).toBe(false);
  });
});

// STRUCTURAL EQUALITY (operator 2026-08-07): the transcript path must come from the Room
// abstraction (room-core.mjs), not a hand-rolled join — an operator-named room created by
// `/rooms create` got a full tree and NO WAY to ever receive a transcript, because the old code
// asked conversations-state.slugDir + a local join() for the path instead of asking the Room.
// Routing an inbound message TO a named room is a separate feature (out of scope here) — what
// this locks down is that the PATH-RESOLUTION code the service now runs is Room-derived, so a
// chat room and a named room are interchangeable the moment routing exists.
describe('transcript.log — resolves its path through the Room abstraction (structural equality)', () => {
  const mkIo = (files) => ({
    appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); },
    mkdir: async () => {},
    existsSync: (p) => files.has(p),
    readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
    writeFile: async (p, d) => { files.set(p, d); },
    readdir: readdirOver(files),
  });

  it('the ConversationRoom write lands EXACTLY at Room.forChat(surface, slug).transcriptPath', async () => {
    const files = new Map();
    const t = createTranscript({ contacts: fakeContacts, io: mkIo(files) });
    expect(await t.log(ev)).toBe(true);
    const expected = Room.forChat(ev.surface, 'fam-1234567890').transcriptPath;
    expect(files.has(expected)).toBe(true);
  });

  // Today nothing routes an ev to a named room (that syntax is unruled — out of scope), but the
  // service's write PRIMITIVE (baseDir()/transcriptPath from Room, mkdir + appendFile through the
  // same io seam) must already be capable of landing a named room's transcript at its own root,
  // structurally identical to a chat conversation's. This is what "cannot be expressed at all
  // through the service" meant before this change: the old code only ever knew the ONE surface
  // it was handed, because it asked slugDir instead of the Room.
  it('a named room resolves its own baseDir()/transcript.md through the SAME Room getters, distinct from a chat room', async () => {
    const files = new Map();
    const io = mkIo(files);
    const conv = Room.forChat('whatsapp', 'fam-1234567890');
    const named = Room.forChat('room', 'acim');

    await io.mkdir(conv.baseDir(), { recursive: true });
    await io.appendFile(conv.transcriptPath, 'conversation line\n\n', 'utf8');
    await io.mkdir(named.baseDir(), { recursive: true });
    await io.appendFile(named.transcriptPath, 'room line\n\n', 'utf8');

    expect(conv.transcriptPath).not.toBe(named.transcriptPath);
    expect(conv.transcriptPath.endsWith('transcript.md')).toBe(true);
    expect(named.transcriptPath.endsWith('transcript.md')).toBe(true);
    expect(files.get(conv.transcriptPath)).toBe('conversation line\n\n');
    expect(files.get(named.transcriptPath)).toBe('room line\n\n');
  });
});

// ROOM-JOIN RECORD-KEEPING (operator, room-join transcript-routing fix): a joined room wins over
// ev's own native (surface, chatId) for WHERE a write lands — the redirect decision lives HERE,
// inside createTranscript (the service's ONE ingestion point), not at either call site (spine.mjs's
// handleFast, boot.mjs's wrapCommandsForTranscript both just call plain `transcript.log(ev, ...)`
// — see tests/spine-ingestion.test.mjs / tests/command-transcript.test.mjs for the thin wiring
// checks that those callers still get the redirect for free). `currentRoomOf` mirrors
// commands.mjs's own currentRoomOf(surface) -> slug|null exactly (a fake here, no createCommands
// wiring needed to pin the contract at this boundary).
describe('transcript.log — currentRoomOf redirects WHERE a write lands, ev itself never touched', () => {
  const mkIo = (files) => ({
    appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); },
    mkdir: async () => {},
    existsSync: (p) => files.has(p),
    readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
    writeFile: async (p, d) => { files.set(p, d); },
    readdir: readdirOver(files),
  });
  // Discriminates the write by SURFACE (room vs native), same shape as the two callers' own thin
  // wiring tests: fakeContacts ignores its arguments, so the redirect is visible only through
  // which root the path lands under — rooms/… for surface `room` (it does not arrive through
  // Beeper, so it sits outside the Beeper tree, operator 2026-08-28) vs conversations/<native>/….
  const contacts = { resolve: async () => 'fam-1' };
  const rootSeg = (seg) => (seg === 'room' ? '/rooms/' : `/conversations/${seg}/`);
  const transcriptText = (files, seg) => [...files.entries()].find(([p]) => p.replace(/\\/g, '/').includes(rootSeg(seg)) && p.endsWith('transcript.md'))?.[1] ?? '';

  it('room joined on ev.surface → the inbound line lands in the ROOM\'s transcript, not the native chat\'s', async () => {
    const files = new Map();
    // Frozen: log() must never assign onto ev — only its own local target vars change.
    const inEv = Object.freeze({ ...ev, surface: 'whatsapp', chatId: '!room:beeper.com' });
    const t = createTranscript({ contacts, io: mkIo(files), currentRoomOf: (surface) => (surface === 'whatsapp' ? 'acim' : null) });
    expect(await t.log(inEv)).toBe(true);
    expect(transcriptText(files, 'room')).toContain('hola');
    expect(transcriptText(files, 'whatsapp')).toBe('');
    // ev is provably untouched: frozen, so any attempted write would have thrown inside log().
    expect(inEv.surface).toBe('whatsapp');
    expect(inEv.chatId).toBe('!room:beeper.com');
  });

  it('a reply write (log(ev, reply)) redirects the same way as an inbound write', async () => {
    const files = new Map();
    const inEv = Object.freeze({ ...ev, surface: 'shell', chatId: 'main' });
    const t = createTranscript({ contacts, io: mkIo(files), currentRoomOf: (surface) => (surface === 'shell' ? 'acim' : null) });
    expect(await t.log(inEv, { text: 'reset done', being: 'system' })).toBe(true);
    expect(transcriptText(files, 'room')).toContain('reset done');
    expect(transcriptText(files, 'shell')).toBe('');
  });

  it('no room joined (currentRoomOf → null) → the write lands in the native chat\'s transcript exactly as before', async () => {
    const files = new Map();
    const t = createTranscript({ contacts, io: mkIo(files), currentRoomOf: () => null });
    expect(await t.log(ev)).toBe(true);
    expect(transcriptText(files, 'whatsapp')).toContain('hola');
    expect([...files.keys()].some((p) => p.replace(/\\/g, '/').includes('/rooms/'))).toBe(false);
  });

  it('currentRoomOf omitted entirely (default) — byte-identical to before this option existed', async () => {
    const files = new Map();
    const t = createTranscript({ contacts, io: mkIo(files) });   // no currentRoomOf at all
    expect(await t.log(ev)).toBe(true);
    expect(transcriptText(files, 'whatsapp')).toContain('hola');
  });

  it("'lobby' means no room (sugar for the surface's own native identity) — no redirect", async () => {
    const files = new Map();
    const t = createTranscript({ contacts, io: mkIo(files), currentRoomOf: () => 'lobby' });
    expect(await t.log(ev)).toBe(true);
    expect(transcriptText(files, 'whatsapp')).toContain('hola');
    expect([...files.keys()].some((p) => p.replace(/\\/g, '/').includes('/rooms/'))).toBe(false);
  });

  // The regression most likely to silently break: PROSE while a room is joined already arrives
  // with ev.surface === 'room' (redirectShellToRoom rewrote it upstream, boot.mjs — out of scope,
  // untouched). currentRoomOf('room') must be a no-op (currentRoom is keyed by 'shell', never
  // 'room'), so this must not re-target an already-redirected ev a second time or double-write it.
  it("already-redirected prose (ev.surface === 'room') is not re-targeted — currentRoomOf('room') no-ops, logs exactly once", async () => {
    const files = new Map();
    const proseEv = { ...ev, surface: 'room', chatId: 'acim' };
    // Even with a (misleading, hypothetical) currentRoomOf keyed by 'shell' still wired, a
    // surface-'room' ev must never consult it under its OWN surface key.
    const t = createTranscript({ contacts, io: mkIo(files), currentRoomOf: (surface) => (surface === 'shell' ? 'acim' : null) });
    expect(await t.log(proseEv)).toBe(true);
    const text = transcriptText(files, 'room');
    expect(text).toContain('hola');
    expect((text.match(/hola/g) ?? []).length).toBe(1);   // exactly once — no double record
  });

  // REPRODUCE-FIRST (operator 2026-08-30): logRoomTranscript (boot.mjs) calls transcript.log
  // with an event that ALREADY names its final destination — surface 'room', chatId the
  // SPECIFIC room a wa-group tunnels through (never LOBBY_SLUG). But surface 'room' is ALSO
  // identity.SHELL_SURFACE, so currentRoomOf('room') answers the SAME map key as the shell's
  // own joined room. Before this fix, `redirected` fired unconditionally whenever something was
  // joined under that key — so a tunnelled write landed wherever the console's OWN /rooms join
  // happened to sit, not where the caller explicitly targeted it.
  it("an event that already names its OWN room under surface 'room' (e.g. logRoomTranscript) is NOT reinterpreted onto a DIFFERENT room joined on that surface", async () => {
    const files = new Map();
    // Mirrors production room slugging (fixedSlugFor: surface 'room' -> sanitizeName(chatId)) —
    // the slug tracks the specific chatId, so 'dj-son' and 'other-room' resolve to distinct paths.
    const roomContacts = { resolve: async (surface, chatId) => chatId };
    const tunnelEv = { ...ev, surface: 'room', chatId: 'dj-son', chatName: 'dj-son' };
    const t = createTranscript({ contacts: roomContacts, io: mkIo(files), currentRoomOf: (surface) => (surface === 'room' ? 'other-room' : null) });
    expect(await t.log(tunnelEv)).toBe(true);
    const norm = (p) => p.replace(/\\/g, '/');
    const ownText = [...files.entries()].find(([p]) => norm(p).includes('/rooms/dj-son/') && p.endsWith('transcript.md'))?.[1] ?? '';
    const otherText = [...files.entries()].find(([p]) => norm(p).includes('/rooms/other-room/') && p.endsWith('transcript.md'))?.[1] ?? '';
    expect(ownText).toContain('hola');     // lands in the room the caller actually named
    expect(otherText).toBe('');            // never redirected onto the unrelated joined room
  });
});
