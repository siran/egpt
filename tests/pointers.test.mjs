// pointers.test.mjs — the POINTERS CARD is `config/skeletons/room/30-pointers.md`, and
// nothing else. It used to have a second, INLINE copy in src/pointers.mjs (POINTERS_TEXT +
// seedPointers); the two DIVERGED, and the module's only caller died with the old spine, so
// the tests here guarded a corpse while the live card rotted. src/pointers.mjs was deleted
// 2026-07-25 and this file now guards the surviving card.
//
// WHAT ROTS: the card is fed at kickoff AND copied to <conv>/directives/30-pointers.md, and
// E reads it while confined to its conversation folder. So every `./path` it names must be a
// path a conversation folder ACTUALLY has. It listed `./transcripts/` — a directory nothing
// in the codebase has ever created — sending E to a dead end.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import { Room } from '../src/room-core.mjs';
import { ASK_SPINE_ENV } from '../src/shell/being.mjs';

const CARD = readFileSync(fileURLToPath(new URL('../config/skeletons/room/30-pointers.md', import.meta.url)), 'utf8');

// What a conversation folder REALLY holds — DERIVED from the ONE owner of the tree
// (Room.treeDirs, room-core.mjs) plus the two files the Room declares (transcript.md,
// config.yaml), so this set can never drift from what is created on disk the way the
// hand-written copy did. Optional daily-YYYY-MM-DD.md summaries live here too.
const CONV = Room.forChat('whatsapp', 'x');
const REAL_PATHS = new Set([
  ...CONV.treeDirs().slice(1).map((d) => `./${basename(d)}/`),   // slice(1): baseDir itself is not a './' pointer
  `./${basename(CONV.transcriptPath)}`,   // no configPath: the room rung moved to config/rooms.yaml
]);

describe('the pointers card (config/skeletons/room/30-pointers.md)', () => {
  // 2026-09-10: the folder is `directives/`, and the identity is NOT in it — it is fed in
  // context (operator: "models get fed their identity in the beginning and on compaction, but
  // the file is not placed in identity.d. that folder needs to change name. directives/ ?").
  // The card must name the folder that exists and describe what is really in it; the old
  // "who I am here" gloss became a lie the moment the identity stopped being written.
  it('points at ./directives/ — the folder the layers are actually seeded into', () => {
    expect(CARD).toContain('./directives/');
    expect(CARD).not.toContain('identity.d');
    expect(CARD).not.toMatch(/who I am here/);
  });

  // Operator 2026-07-26: "an *.x.md goes in the scripts/ folder of a Room, so I can tell E,
  // do yyy and it knows to read the textecutable. we have to add to pointer file an
  // instruction like 'if you are asked to do something, check the x.md folder'." Being TOLD
  // is the whole feature — a scripts/ folder E never hears about is dead weight.
  it('tells E to look in ./scripts/ when it is asked to DO something', () => {
    expect(CARD).toContain('./scripts/');
    expect(CARD).toMatch(/\.x\.md/);
    expect(CARD).toMatch(/asked to DO something/);
  });

  // HONESTY: E's allowed_tools are Read/Write/Edit/Glob/Grep/WebSearch/WebFetch/Task — NO
  // Bash. It carries a textecutable out with ITS OWN tools; it cannot shell out to
  // src/tools/textecute.mjs. The card must not promise a run it cannot perform.
  it('does not promise E a shell it does not have', () => {
    expect(CARD).toMatch(/with my own tools/);
    expect(CARD).not.toMatch(/textecute\.mjs|node src\/tools|\bBash\b/);
  });

  it('names ONLY paths a conversation folder actually has', () => {
    const named = [...CARD.matchAll(/\.\/[A-Za-z0-9._-]+\/?/g)].map((m) => m[0]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((p) => !REAL_PATHS.has(p))).toEqual([]);
  });

  // 2026-07-26: ./transcripts/ is no longer the dead end that got this line deleted — it is
  // part of the Room tree (Room.treeDirs), so every conversation has the folder, and a thread
  // change archives the finished transcript into it. The card may name it again; the REAL_PATHS
  // check above is what keeps that honest (it is derived from the tree, not from this list).
  it('names ./transcripts/ — and the Room tree really creates it', () => {
    expect(CARD).toMatch(/\.\/transcripts\//);
    expect(CONV.treeDirs().map((d) => basename(d))).toContain('transcripts');
  });

  // 2026-09-20: the being's OWN surface. Everything else the card names belongs to someone
  // else — ./media/ is what the chat sent, ./directives/ and ./scripts/ are what it was
  // given, ./transcripts/ is its past — and a folder it is never told about is a folder it
  // does not have. The operator asked for this to sit in the CONVERSATION folder rather than
  // in the sandbox pool profile, because that profile is scratch (wiped on every lease) and
  // is not where the being works.
  it('names ./desktop/ — the being own working surface, and a real folder', () => {
    expect(CARD).toMatch(/\.\/desktop\//);
    expect(CONV.treeDirs().map((d) => basename(d))).toContain('desktop');
  });

  // 2026-10-04: where the being keeps its ssh keys. A sandboxed being's pool home ~/.ssh is wiped on
  // every lease, so a key left there vanishes between turns; the conversation folder's .ssh/ persists
  // and is backup-excluded, so the card names it (and how to use a key from it) — a being never told is
  // one that keeps keys where they disappear.
  it('names ./.ssh/ — the being\'s own ssh keys, and a real folder the Room tree creates', () => {
    expect(CARD).toMatch(/\.\/\.ssh\/ .*my ssh keys/);
    expect(CARD).toMatch(/PERSISTENT and backup-excluded/);
    expect(CARD).toMatch(/ssh -i \.ssh\/<key> -o StrictModes=no/);
    expect(CONV.treeDirs().map((d) => basename(d))).toContain('.ssh');
  });

  // 2026-09-25: a being asked for a reminder had nowhere a heartbeat could live. The card tells
  // it where, and what may go there — one file per beat. Since 2026-09-28 (operator: "there are
  // different types of yaml heartbeats") that is three kinds: a structural command run in the
  // being's own box, a browser turn, a pure-AI turn — never "turns only" again.
  it('names ./heartbeats/ — one file per beat, the three kinds — and the Room tree really creates it', () => {
    expect(CARD).toMatch(/\.\/heartbeats\/ .*one <name>\.yaml per beat, three kinds:/);
    expect(CARD).toMatch(/structural {2}when:\/daily: \+ command:, run as me in my box;/);
    expect(CARD).toMatch(/post: "\{stdout\}" says its output in this chat/);
    expect(CARD).toMatch(/browser {5}browser: true \+ agent: \+ prompt:/);
    expect(CARD).toMatch(/pure AI {5}agent: \+ prompt:/);
    expect(CARD).not.toContain('turns only');
    expect(CONV.treeDirs().map((d) => basename(d))).toContain('heartbeats');
  });

  // 2026-09-26: the brain Chrome died and a boxed E could not restart it. The spine now starts it
  // for a being that asks (src/spine/being-link.mjs) — "for now only the browser" — and the card is
  // where a being learns the exact command, through the variable its boxed session is handed, and
  // that launching chrome.exe on that profile itself is the thing NOT to do.
  it('tells a being to ask the spine for the browser, by the variable the spine hands it, and never to launch it', () => {
    expect(CARD).toContain(`\`node "$${ASK_SPINE_ENV}" browser start\``);
    expect(CARD).toMatch(/I never launch chrome\.exe on that\s+profile myself/);
    expect(CARD).toMatch(/logged out/);
  });

  // 2026-09-28: a sandboxed being's home holds read-only mounts beside its room — `src`, the eGPT
  // checkout (mounted since 2026-09-23 and named on no card until now), and one per entry of the
  // node's config.yaml global_read_paths (operator: "please frame this in config.yaml as
  // global_read_paths list"; kg's is `repos`, the operator's repositories). A card cannot render
  // that list (fillCardPlaceholders fills scalars), so it names the kind and how to see which -
  // true on a node with none as on kg. HOME-relative, not ./ paths: they are siblings of the room
  // in the pool profile, not folders in it, so the check above does not apply to them and must not
  // be bent to.
  it('names ~/src/ and the operator\'s shared folders — the read-only folders a sandboxed being has beside its room', () => {
    expect(CARD).toMatch(/When I run sandboxed, my home holds read-only folders beside this room/);
    expect(CARD).toMatch(/^ {2}~\/src\/ +my own code — the eGPT checkout$/m);
    expect(CARD).toMatch(/^ {2}~\/<name>\/ +folders the operator shares with every being on this$/m);
    expect(CARD).toMatch(/e\.g\. ~\/repos\/ \(his repositories\)/);
    expect(CARD).toMatch(/`ls ~` shows\s+which this node has/);
  });

});
