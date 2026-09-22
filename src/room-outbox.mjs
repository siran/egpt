// room-outbox.mjs — THE SPINE-SIDE COPY out of a room's `outbox/` (operator 2026-09-22).
//
// THE MEASUREMENT THAT CAUSED IT. A sandboxed being (E, running as pool account egpt-sbx-NN)
// finished six translation files and could not deliver them to `G:\My Drive\jose-lorenzo\…`.
// The volume reports FAT32 — there are no ACLs on it to grant — and GoogleDriveFS.exe runs as
// `reve\an`, so the drive letter lives in THAT user's session and the pool account has no `G:`
// at all. There was no permission to grant: the path is simply absent from the being's world.
// The spine already runs as `an` and can see `G:`, so the operator ruled a spine-side copy.
//
// ── THE INVARIANT THAT GOVERNS EVERY DECISION HERE ───────────────────────────────────────────
// THE BEING CHOOSES WHAT, NEVER WHERE. It writes files into its OWN room's outbox/ (room-core
// .mjs, part of the tree); the destination comes from operator config it cannot write. Nothing
// in this module ever reads a destination, or a FRAGMENT of one, out of a message, a filename or
// a file the being wrote. A design where it did would hand a sandboxed account a write path onto
// the operator's disk and defeat the sandbox entirely — which is the one thing the sandbox
// exists for. Every rule below is a consequence of that sentence, not an independent preference:
//
//   · ONE LEVEL, FILES ONLY. No recursion, no directories, no symlinks and no junctions. A link
//     inside the outbox is a destination the BEING named, wearing a file's clothes: follow one
//     and the move lands wherever it points. lstat (never stat) is what refuses to follow it.
//   · NEVER OVERWRITE. A destination file of the same name leaves that entry in the outbox,
//     reported by name. Silent overwrite could destroy the operator's or Joyce's work, and the
//     FILENAME is the one thing the being does choose — so a collision is a thing it can cause.
//   · REFUSE THE WHOLE DRAIN, NAMING THE PLACE, when the destination does not exist, is not a
//     directory or cannot be written. NEVER create it: the operator names a real folder or
//     nothing happens. A drain that makes its own destination would happily materialise a typo.
//   · MOVE, NOT COPY. An emptied outbox is how the being and the operator both see what is
//     still pending; a copy would leave every delivered file looking undelivered forever.
//   · NEVER THROWS into the turn — it logs and reports, exactly as rollTranscript and
//     seedIdentityLayers do ("a failed archive logs and the turn continues").
//
// WHY copyFile+unlink AND NOT rename. The destination is on ANOTHER VOLUME by construction —
// that is the entire premise of this feature (C: profile → G: Drive) — and fs.rename across
// volumes is EXDEV on every platform. copyFile with COPYFILE_EXCL is the one primitive that
// crosses volumes AND refuses to clobber in the same call, so "never overwrite" is enforced by
// the filesystem rather than by a check that could race a writer. unlink afterwards is what
// makes it a move; a copy that lands and then fails to unlink is reported as exactly that,
// never counted as delivered.
//
// This module does NOT post anything. It returns a result and the caller says it, through the
// ONE placement every reaction, reply and node line already takes (sender.mjs makeOutbound, via
// boot's sayOnce) — see createOutboxDrain below, which is wired into the ONE post-turn hook
// brainpool already fires (compaction.mjs's afterTurn is the other rider on it).
import { readdir, lstat, stat, access, copyFile, unlink, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { Room } from './room-core.mjs';
import { getBeing, residentsOf } from './conversations-state.mjs';

// ── WHERE, resolved: A KEY INTO A NODE-LEVEL MAP — never a path (operator 2026-09-22) ────────
// *"we have to configure a map: acim-drive -> G:/My Drive/jose-lorenzo/ACIM-ES.v2 … key -> path/
// per conversation, configured by meta engineer or by hand"*.
//
// THE MAP IS THE ONLY PLACE A PATH IS EVER WRITTEN. config.yaml's root `outbox_targets:` —
// sibling of the node-level `allowed_paths:` grant (brainpool.mjs's withNodeAllowedPaths) and
// there for the same stated reason: ONE place the node grants a folder, and therefore one place
// to revoke it. The conversation says only WHICH approved target, by name:
//
//   config.yaml        outbox_targets: { acim-drive: G:/My Drive/jose-lorenzo/ACIM-ES.v2 }
//   the room's row     agents: → <being>: → outbox_to: acim-drive
//
// WHY A KEY AND NOT THE PATH, which is the whole point of this indirection: with a raw path,
// ANYTHING that can write the conversation record can name any directory on the operator's disk.
// With a key it can only SELECT among destinations the operator already approved, so the
// invariant survives even if a conversation record is one day writable by something that should
// not be able to write it. The key is used as a LOOKUP and nothing else: it never contributes a
// path fragment, a `..`, a suffix or a separator to the answer. `outbox_to: ../../etc`,
// `outbox_to: G:\anywhere` and `outbox_to: acim-drive/sub` are therefore not traversals to be
// sanitised — they are simply names the map does not have, and they resolve to NOTHING. That is
// a property of doing a lookup rather than building a path, which is why there is no sanitiser
// here to get wrong. Object.entries (own enumerable keys only) is what the lookup reads, so a
// `__proto__`/`constructor`-shaped name cannot reach through to anything either.
//
// THE TIER WALK for the key itself MIRRORS `compaction` at src/spine/brainpool.mjs:803 —
//   b?.compaction ?? getConfig()?.agents?.[being]?.conversation_defaults?.compaction ?? null
// — because that is the walk that already reaches a ROOM. Migration 0022 traced it and wrote the
// finding down: the per-conversation rung is `rooms: → room/<slug>: → agents: → <being>:` in
// config/rooms.yaml, because getBeing reads ONE place (`entry.agents.<being>`) and
// rooms-file.mergeRoomBeings is what hydrates a surface-`room` entry's `agents:` block from
// there. A key on the room ROW instead would be read by NOTHING — the row's own keys are the
// config-resolver's room rung, whose resolved doc reaches exactly one reader in brainpool
// (readWarmTtl's `warm:` block) — it would look correct in the file forever and do nothing.
//
// A FUNCTION rather than a second inline `??` chain, because there are TWO readers: the turn
// (resolveConv) and the boot sweep below. One rule, one place; a chain copied into both is how
// the two tiers drift.
//
// THREE ANSWERS, and the middle one is why this returns an object rather than a string:
//   null                         nothing names a target ⇒ THE FEATURE IS OFF. No default
//                                destination, ever: a default would start moving files off a
//                                being's disk on a node whose operator never asked for it.
//   { key, to, unknown: null }   the named target, resolved to EXACTLY the mapped path.
//   { key, to: null, unknown }   a key the map does not have. NOT silently off — a typo must be
//                                visible, not mysterious, so the name travels with the refusal
//                                and gets reported (see drainOutbox).
export function resolveOutboxTarget(being_block, being, config) {
  const named = being_block?.outboxTo ?? config?.agents?.[being]?.conversation_defaults?.outbox_to ?? null;
  const key = typeof named === 'string' ? named.trim() : '';
  if (!key) return null;
  const map = (config?.outbox_targets && typeof config.outbox_targets === 'object' && !Array.isArray(config.outbox_targets))
    ? new Map(Object.entries(config.outbox_targets))
    : new Map();
  const raw = map.get(key);
  const to = (typeof raw === 'string' && raw.trim()) ? raw.trim() : null;
  if (to) return { key, to, unknown: null };
  const known = [...map.keys()];
  return {
    key,
    to: null,
    unknown: map.has(key)
      ? `\`outbox_to: ${key}\` names a target in \`outbox_targets\` whose value is not a path — nothing was moved`
      : `\`outbox_to: ${key}\` names no target in \`outbox_targets\`${known.length ? ` (this node has: ${known.join(', ')})` : ' (this node declares none)'} — nothing was moved`,
  };
}

// ── WHAT MAY BE SAID IN A CHAT: THE KEY. WHAT GOES IN THE LOG: THE PATH ──────────────────────
// (operator 2026-09-22, ruling the concrete case rather than the principle.) The first room this
// ships to is room/acim, whose invited wa-group is "perrito traduciones" — and JOYCE IS IN THAT
// GROUP. She is a translation collaborator, not the operator. A refusal line naming
// `G:\My Drive\jose-lorenzo\ACIM-ES.v2` would tell her the operator's filesystem layout, how his
// Drive is organised, and a third party's folder name, none of which is any of her business.
// That is not a hypothetical: it is the only destination configured.
//
// So every string that can reach a chat names the TARGET KEY and never the resolved path, and
// `onLog` — which only the operator reads — carries the path, the per-file detail and the whole
// error. "Name the place" still holds; it holds in the log.
//
// AND THE LEAK HAS A BACK DOOR, which is what this helper is for: a Node fs error stringifies
// WITH THE PATH IN IT ("ENOENT: no such file or directory, stat 'G:\My Drive\…'"), so passing
// e.message through into a chat-bound sentence would put the destination straight back. Only the
// errno CODE crosses into a chat; the full error goes to the log, at the point it happened.
const codeOf = (e) => (typeof e?.code === 'string' && e.code) ? e.code : 'failed';

// The destination, checked ONCE for the whole drain. Returns a CHAT-SAFE refusal sentence naming
// the target KEY (never the path), or null when it is usable. The raw error is logged here, where
// the path is still in hand.
//
// access(W_OK) IS THE WEAK RUNG ON WINDOWS and that is written here rather than pretended away:
// for a directory it largely reports the read-only ATTRIBUTE and not the ACL, so a folder this
// process genuinely cannot write can still pass. It is still the right check (it catches the
// ordinary cases and costs one syscall), and the per-file copy below reports its own EACCES/
// EPERM by name — so an unwritable destination that slips past here still ends with every file
// still in the outbox and every failure named, which is the outcome that matters.
async function checkDestination(dest, key, { statFn, accessFn, onLog }) {
  let st = null;
  try { st = await statFn(dest); }
  catch (e) {
    // THE EXPLANATION IS THE OPERATOR'S, so it goes in the log with the path. The room only
    // needs to know its files did not go; "nothing was created, the operator names a real folder
    // or the drain does not run" is a sentence for whoever can act on it, and a long line in a
    // group chat is how a useful signal turns into something people learn to scroll past.
    onLog(`\`${key}\` → ${dest}: ${e?.message ?? e} — nothing was moved, and nothing was created: the operator names a real folder or the drain does not run`);
    return `\`${key}\`: the destination is not there (${codeOf(e)}) — nothing was moved`;
  }
  if (!st.isDirectory()) {
    onLog(`\`${key}\` → ${dest}: not a directory`);
    return `\`${key}\`: the destination is not a folder — nothing was moved`;
  }
  try { await accessFn(dest, constants.W_OK); }
  catch (e) {
    onLog(`\`${key}\` → ${dest}: not writable — ${e?.message ?? e}`);
    return `\`${key}\`: the destination cannot be written to (${codeOf(e)}) — nothing was moved`;
  }
  return null;
}

/**
 * Drain ONE room's outbox into ONE approved destination. Pure of policy: it is told the room and
 * the RESOLVED target, and decides nothing about either.
 *
 * @param target  what resolveOutboxTarget returned: null (off), or { key, to, unknown }.
 * @returns null when there is NOTHING TO SAY — no target named, no outbox folder, or an empty
 *          one. Otherwise { key, to, moved: [name], skipped: [{name, why}], refused }.
 */
export async function drainOutbox({ room, target, io = {}, onLog = () => {} } = {}) {
  const readdirFn = io.readdir  ?? readdir;
  const lstatFn   = io.lstat    ?? lstat;
  const statFn    = io.stat     ?? stat;
  const accessFn  = io.access   ?? access;
  const copyFn    = io.copyFile ?? copyFile;
  const unlinkFn  = io.unlink   ?? unlink;

  const key = target?.key ?? null;
  const dest = target?.to ?? null;
  if (!room || !key) return null;                      // UNSET ⇒ OFF: not a stat, not a mkdir, nothing.

  try {
    // NOTHING IS TOUCHED BEFORE THE OUTBOX IS READ, and the ORDER is load-bearing: the
    // destination is validated only once there is something to move. Checking it first would
    // put a refusal line in the chat after every single turn on a node whose Drive folder is
    // momentarily away, and would stat a network/Drive path on every turn for nothing.
    let names = [];
    try { names = await readdirFn(room.outboxDir); }
    catch { return null; }                             // no outbox folder → nothing pending (never created here)
    // A readdir entry is ONE path component by definition — no separator can be in a filename on
    // any filesystem — so `join(dest, name)` below is always INSIDE the destination and a being
    // cannot traverse out of it by what it calls a file. That is a property of readdir, not a
    // check kept here; the escape it would have to use is the link case, refused below.
    names = [...names].sort();                         // deterministic order; the report reads the same twice
    if (!names.length) return null;                    // empty outbox → the being has handed nothing out

    // A KEY THE MAP DOES NOT HAVE stops here — before the destination is looked at, because
    // there is no destination. It is REPORTED rather than silently skipped (operator: a typo
    // must be visible, not mysterious), and it is reported HERE rather than every turn for the
    // same reason every other refusal is: a name only costs something once a file is waiting on
    // it, and a line after every turn forever would be the noise that gets the feature muted.
    if (!dest) return { key, to: null, moved: [], skipped: [], refused: target?.unknown ?? `\`outbox_to: ${key}\` resolved to no destination — nothing was moved` };

    const refused = await checkDestination(dest, key, { statFn, accessFn, onLog });
    if (refused) return { key, to: dest, moved: [], skipped: [], refused };

    const moved = [];
    const skipped = [];
    for (const name of names) {
      const src = join(room.outboxDir, name);
      let st = null;
      try { st = await lstatFn(src); }
      catch (e) { onLog(`\`${key}\` ${src}: ${e?.message ?? e}`); skipped.push({ name, why: `could not be read (${codeOf(e)})` }); continue; }
      // lstat, so a link is seen AS a link. On Windows a junction is a reparse point and lstat
      // reports it as a symbolic link too, which is exactly what must be refused: a being that
      // can plant one could otherwise redirect the move to any path the SPINE can write.
      if (st.isSymbolicLink()) { skipped.push({ name, why: 'a link — the drain never follows one' }); continue; }
      if (st.isDirectory())    { skipped.push({ name, why: 'a folder — the outbox is files only, one level deep' }); continue; }
      if (!st.isFile())        { skipped.push({ name, why: 'not a regular file' }); continue; }
      try {
        await copyFn(src, join(dest, name), constants.COPYFILE_EXCL);
      } catch (e) {
        // The PATH and the whole error to the log; the chat gets the filename (which the being
        // chose and everyone in the room can already see) and the errno code.
        onLog(`\`${key}\` ${name} → ${join(dest, name)}: ${e?.message ?? e}`);
        if (e?.code === 'EEXIST') skipped.push({ name, why: 'a file of that name is already at the destination — it was left alone and this one stays in the outbox' });
        else skipped.push({ name, why: `could not be copied to the destination (${codeOf(e)})` });
        continue;
      }
      // THE MOVE IS ONLY A MOVE ONCE THIS LANDS. A copy whose unlink failed is reported as
      // copied-but-not-removed and NOT counted as moved: the next drain will find it again and
      // say "already there", which is a legible state — claiming it was delivered would not be.
      try { await unlinkFn(src); }
      catch (e) { onLog(`\`${key}\` ${src}: copied to ${join(dest, name)} but not removed — ${e?.message ?? e}`); skipped.push({ name, why: `copied to the destination, but could not be taken out of the outbox (${codeOf(e)})` }); continue; }
      moved.push(name);
    }
    return { key, to: dest, moved, skipped, refused: null };
  } catch (e) {
    // The last net. Everything above already handles its own failure per entry, so reaching here
    // means something unforeseen. The message is the one thing that MUST NOT reach the chat (an
    // fs error carries the path inside it), so the log takes the whole error and the chat gets
    // the key and the code.
    onLog(`\`${key}\` → ${dest}: ${e?.message ?? e}`);
    return { key, to: dest, moved: [], skipped: [], refused: `\`${key}\`: the drain failed (${codeOf(e)}) — nothing can be assumed delivered` };
  }
}

/**
 * The drain's result AS A LINE FOR THE CHAT — pure, so what a room actually reads is testable
 * without a bridge. null when there is nothing worth saying (a silent drain is the normal case:
 * the outbox is empty after almost every turn, and a line per turn would be noise).
 *
 * THE TARGET KEY IS WHAT IT NAMES, NEVER THE RESOLVED PATH — see the ruling above checkDestination
 * (Joyce is in the room this ships to). Everything this function reads is already chat-safe by
 * construction: `refused` and each `skipped[].why` are built path-free at the point of failure,
 * with the path sent to the log there instead. So there is no filtering here to forget, and
 * nothing that could be "improved" back into a leak by editing this function alone — but the test
 * that asserts no path survives into this string is the lock that says so out loud.
 */
export function describeDrain(result) {
  if (!result) return null;
  // The refusal sentences carry their own `key` prefix (and the unknown-key one names it as
  // `outbox_to: <key>`, which says where to go and fix it), so this adds the marker and nothing
  // else — a second "outbox:" in front would just read as a stutter before the backtick.
  if (result.refused) return `⚠️ ${result.refused}`;
  const { moved = [], skipped = [], key } = result;
  if (!moved.length && !skipped.length) return null;
  const lines = [];
  // THE TARGET NAME ALONE. It is what the operator wrote in the conversation record, so it is the
  // word they will recognise — and it is a name, not a location: it tells the room WHICH approved
  // destination was used without telling it where that is on the operator's disk.
  if (moved.length) lines.push(`📤 outbox → \`${key}\`: delivered ${moved.length} file${moved.length === 1 ? '' : 's'} — ${moved.join(', ')}`);
  for (const s of skipped) lines.push(`⚠️ ${s.name} is still in the outbox: ${s.why}`);
  return lines.join('\n');
}

/**
 * THE SERVICE — the shape createCompaction has, for the same reason: it rides the ONE post-turn
 * hook brainpool fires (`createBrainPool({ afterTurn })`), and a hook needs a thing to call.
 *
 * WHY NOT fs.watch: this repo already measured that "Windows fs.watch misses some renames under
 * load" (src/tools/outbox-send.mjs's header, about the OTHER outbox — ~/.egpt/state/outbox, the
 * daemon's JSON event drop, which is an unrelated mechanism that happens to share the word). A
 * watcher that misses the rename of a finished translation loses it silently; a drain that runs
 * after every turn and once at boot cannot.
 *
 * @param say  (chatId, text) — boot's `sayOnce`, i.e. sender.mjs makeOutbound: THE one placement
 *             every reaction, reply and node line already goes through. Nothing here posts.
 */
export function createOutboxDrain({
  drain = drainOutbox,
  roomFor = (surface, slug) => Room.forChat(surface, slug),
  say = null,
  loadState = null,                 // the boot sweep's enumerator; without it there is no sweep
  getConfig = () => ({}),
  io = {},
  onLog = () => {},
} = {}) {
  async function run({ surface, slug, being, target, chatId = null }) {
    const result = await drain({ room: roomFor(surface, slug), target, io, onLog });
    if (!result) return null;
    const where = `${surface}/${slug} (${being})`;
    // THE LOG LINE FIRST, ALWAYS — it is the record that does not depend on a network, the same
    // order boot's alertOperator keeps. AND IT IS WHERE THE PATH LIVES: only the operator reads
    // the log, so this is the one line that says which folder on disk the key resolved to. The
    // per-file detail and the raw errors were already logged by the drain, where they happened.
    //
    // THE BOOT SWEEP LANDS IN THE SELF DM, which is operator-only and could safely carry the
    // path — but giving it a line of its own would mean a SECOND formatter, and two renderings of
    // one event are exactly how the chat-safe one ends up the stale one. It is not worth a
    // duplicate: the path is in the log for every drain, boot sweep included.
    if (result.refused) onLog(`${where} → \`${result.key}\` (${result.to ?? 'no destination — the key names none'}): REFUSED — ${result.refused}`);
    else onLog(`${where} → \`${result.key}\` (${result.to}): moved ${result.moved.length}, left ${result.skipped.length}`);
    const line = describeDrain(result);
    if (line && say && chatId != null) {
      try { await say(chatId, line); }
      catch (e) { onLog(`${where}: could not say what the drain did — ${e?.message ?? e}`); }
    }
    return result;
  }

  return {
    /**
     * AFTER A TURN. Called from the ONE hook (boot wires it beside compaction.afterTurn on the
     * same `createBrainPool({ afterTurn })` — not a second post-turn mechanism), with the
     * `outbox` descriptor brainpool resolved for this turn, or nothing when the key is unset.
     *
     * NEVER THROWS, and never rejects: brainpool's call site is `try { afterTurn?.(…) } catch {}`
     * and then returns the reply, so a rejection here would surface as an unhandled one rather
     * than as a broken turn — either way the turn must not pay for a failed delivery. Returns
     * the promise so a caller that wants to wait (a test) can, without anyone having to.
     */
    afterTurn({ outbox } = {}) {
      // A NAMED TARGET IS ENOUGH to run — not a resolved path. A key the node's map does not
      // have must still reach the drain, because reporting the typo by name is the whole
      // difference between "nothing happened" and "nothing happened, and here is why".
      if (!outbox?.target?.key) return null;
      return run(outbox).catch((e) => { onLog(`afterTurn: ${e?.message ?? e}`); return null; });
    },

    /**
     * ONCE AT BOOT — what the being handed out while the spine was down, and the retry for a
     * destination that was away last time. Walks the SAME reader the turn does (getBeing over
     * the hydrated registry + resolveOutboxTarget over the node's map), so boot and the turn can
     * never disagree about where a room's outbox goes. A being that names no target costs one
     * object lookup and no filesystem call at all.
     *
     * `chatId` is where a boot sweep SAYS what it did — the Self chat, where every other boot
     * line already lands. Absent, it only logs.
     */
    async atBoot({ chatId = null } = {}) {
      if (!loadState) return [];
      let state = null;
      try { state = await loadState(); }
      catch (e) { onLog(`boot sweep: could not read the registry — ${e?.message ?? e}`); return []; }
      let cfg = {};
      try { cfg = getConfig() ?? {}; } catch { cfg = {}; }
      const out = [];
      for (const surface of Object.keys(state?.contacts ?? {})) {
        if (surface.includes('@')) continue;            // an unmigrated JID-keyed state — recentContacts skips these by the same '@'
        for (const [jid, entry] of Object.entries(state.contacts[surface] ?? {})) {
          if (!entry || entry.aliasOf || !entry.slug) continue;
          for (const being of residentsOf(entry)) {
            const target = resolveOutboxTarget(getBeing(state, surface, jid, being), being, cfg);
            if (!target) continue;
            try {
              const r = await run({ surface, slug: entry.slug, being, target, chatId });
              if (r) out.push({ surface, slug: entry.slug, being, ...r });
            } catch (e) { onLog(`boot sweep ${surface}/${entry.slug} (${being}): ${e?.message ?? e}`); }
          }
        }
      }
      return out;
    },
  };
}
