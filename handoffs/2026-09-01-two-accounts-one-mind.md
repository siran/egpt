# Two accounts, one mind — 2026-08-31 / 2026-09-01

Nineteen commits over two days. The through-line: the two nodes stopped sharing a
Beeper account, and almost everything that broke afterwards broke because some
piece of the system had quietly assumed they did.

**Everything is deployed to both nodes (`d4be10a`), and global wren is LIVE.**

Read `git log` for the changes. This is the shape and the open work.

---

## Where we are

### The account split

`kg` (reve, the laptop) runs on **anrodz42@gmail.com**.
`do` (dolly, always home) runs on **dolly.egpt@gmail.com**, whose WhatsApp is
**+1 347-257-6794**, and which everyone else sees as "Rodz".

Before 2026-08-31 both spines rode one account and heard every message. They no
longer do. `do` sees only chats the 347 account is in.

This was discovered as an outage, not planned: do's configured Beeper token was
returning **401** because its Desktop had already been switched. don had been
cut off and nobody had noticed.

### How addressing works now

```
@e / @egpt   in a chat where Rodz IS present  → do's relay agent `e` takes it,
                                                meshes to kg, kg's persona
                                                answers, do posts the reply from
                                                the 347 account
@e / @egpt   where Rodz is ABSENT (1:1s, rooms) → kg answers directly, as you
@ekg @egptkg  always kg, everywhere
@d / @don    where do is ABSENT → kg's `don` relay carries it to do
@d / @don    where do is PRESENT → do answers directly from its own account
```

The gate is `fallback_handle`, on the agent:

```yaml
fallback_handle: { handle: [ e, egpt ], unless_present: "+13472576794" }
```

The token is *borrowed*. Where the named account is a participant, it belongs to
that account's agent and this node stays silent. Where it is absent, this node
answers on it. **A room has no participant list at all, which counts as a
definite absence** — that is what makes `@e` work on the shell with no lookup.

Unknown membership does **not** wake: a borrowed token goes back to its owner
when there is no evidence. The cost of that being wrong is one retyped `@ekg`;
the cost the other way is two accounts answering one mention.

### Rooms and groups are one being

A WhatsApp group invited into a room (`/members add group <name|id>`) is, for
identity purposes, **that room**. Same thread, same warm process, same turn
queue, same `access_level`. `src/spine/identity-scope.mjs` resolves a
conversation to a scope before any of those four keys is derived; default `null`
means "the conversation is its own instance", so nothing changes without config.

Live: `perrito traduciones` is a member of `room/acim`, and acim's E — thread
`892d0ee4`, `access_level: all` — answers there.

**All four keys or none.** Sharing the thread while leaving the warm key
per-chat means two `claude --resume` processes on one session file.

### The mesh is transport

A relayed turn runs in the **origin conversation**, not the relay channel. The
envelope's `from:` is the origin chat's *name*, which is the only identifier
that crosses accounts — ids do not. The responder resolves that name to its own
local id.

A relay channel is **transit**: no conversation, no transcript, no thread.

`don` and `e` are relay agents. They have no threads. Only the terminal being's
turn has one.

---

## Measured facts worth keeping

These cost time to establish. Do not re-derive them.

- **Beeper chat ids are per-account.** HFM is `!6ljZJkx0Oa…` on anrodz42 and
  `!HuXFQeZSY1…` on dolly.egpt.
- **Message ids are per-account too.** Same chat: `localChatID` 13 on do, ~69,000
  on kg. A model on do naming `#563` and a human reading `#204778` are both
  right.
- **There is no cross-account message id.** The payload has only
  `id`, `chatID`, `accountID`, `senderID`, `senderName`, `timestamp`,
  `linkedMessageID`.
- **Timestamps are not shared.** Measured on 14 messages matched by body: 10
  agreed, 4 did not, and one differed by a whole *second* (12:20:19 on kg,
  12:20:18 on do). WhatsApp gives second granularity and each account appears to
  stamp its own receipt time. **Any hash including the timestamp fails, and fails
  silently** — most messages match, a minority don't.
  What *is* identical on both sides: the **chat name** and the **body**.
- **`config.yaml` is read once at boot** (`boot.mjs`, `const cfg = readConfig()`).
  Every change needs a spine restart. `rooms.yaml` and heartbeats do reload live.
- **dolly's ssh is msys bash on port 2222** (`~/.ssh/config` pins it; port 22 is
  a cmd.exe sshd). `%USERPROFILE%` is not expanded there — that broke
  `upgrade.ps1`'s peer hop, now fixed with `~`.
- **A Claude Code session file is keyed by WORKING DIRECTORY**, at
  `~/.claude/projects/<sanitised-cwd>/<id>.jsonl` plus a sidecar directory of the
  same name holding subagent transcripts and tool results. A being whose type
  file pins a `cwd` therefore keeps all its threads under that one project dir
  (wren: `C:/Users/an/bin/egpt`), and `--resume` cannot reach a thread created
  under a different cwd. Moving a thread between beings means moving both the
  file and the sidecar.
- **The identity card reaches the PROMPT only on a fresh thread** (brainpool's
  `wrapFresh`). `identity.d/` is copied into the conversation folder every turn
  for local consult, but a RESUMED thread is never told who it is. An adopted
  thread has to be fed the layers by hand.
- **`egpt-daemon` is Stopped *and* Disabled on both nodes.** Both run from the
  Startup-folder supervisor. `setup/deploy.ps1` cannot work; **`setup/upgrade.ps1
  -Peer an@dolly` is the deploy** and does both nodes including their source
  trees.

---

## Open work

### 1. The mesh stamp — DONE, `8ffc6e0`

`mesh.mjs` renders the reply label. It rendered the raw map key instead of the
display name, so do's persona (keyed `egpt`, named `don`) answered as `don:`
locally and `egpt:` relayed.

**It regressed three times in two days** and nothing tested it — the suite was
3296 before the real fix and 3296 after. Fixed (`c13db3f`), reverted (`7dad417`)
on a ruling made when kg's key and name happened to be identical, then re-fixed
*inertly* twice (`24c2a7d`, `c346d8e` — a patch script wrote the option but not
the change), and finally landed in `e782524`.

The lock is now in `tests/spine-mesh.test.mjs`, on its own fixture carrying do's
live shape: keyed `egpt`, named `don`, with a `body_emoji`. Both are load-bearing
and the comment above the block says so — keying the persona the same as its name
reproduces exactly the blind spot `7dad417` was ruled under, and dropping the
emoji stops the stamp rendering at all, which is why the earlier attempt (riding
on the neighbouring `e` fixture) had nothing to assert on.

### 2. `beeper-bridge.test.mjs` is flaky under load

Three *different* tests failed on different runs today, one at 5096 ms against
vitest's 5000 ms default. The file passes 3/3 in isolation, at HEAD and with
changes. Three of its real-timer tests were given `{ timeout: 15_000 }` in
`aec1ab5`; more need it, or the file needs splitting.

### 3. E's reply reaches the group but not the room

A group message wakes acim's E through the tunnel, and E answers — but into the
room. Its reply is a *send* into `room/<name>`, not an inbound, so nothing fans
it out. Brain members' replies do reach the groups because they re-enter.

### 4. `ev.result` versus the accumulated stream

`warm-cli-session` now separates consecutive assistant messages with a newline
(`d87aab7`), but `ev.result` still keeps only the **last** message while the
stream carries all of them. So a limb-only settled reply can drop prose the
stream already showed.

Flipping the settled reply to the accumulator is one line and would end the whole
disagreement class — but the accumulator carries every intermediate narration an
agentic turn emits, which is exactly `verbose_thinking`, deliberately default-off
since 2026-08-29. They answer different questions. A middle path exists: settle on
`ev.result` but take *action lines* from the accumulator. That belongs in
`reply-actions`. **Operator's call, not an agent's.**

Same shape in `codex-cli-session` (welds *and* clobbers) and `pi-cli-session`
(welds, resolves with the accumulator, so no disagreement).

### 5. Partial name matching, with a strict ambiguity refusal

`resolveChatId` matches names **exactly** (`beeper.mjs:587`), so a group's title
must be reproduced character for character — including other people's typos.
`perrito traduciones` has one `c`, and finding that cost four attempts.

Partial matching needs `resolveChatId` to **refuse on ambiguity** rather than log
and take the first match. That refusal is worth having on its own: the mesh now
uses the same resolver to find a relayed message's origin chat, where first-match
could silently key a turn on the wrong conversation. One `{ strict: true }`
serves `/members add group`, `canonRoute` and the mesh origin lookup.

### 6. A message id both nodes can say

Decided, not built. Hash **chat name + body**. Not the timestamp (see above), not
the sender (its representation differs per account). Collisions — two identical
messages in one chat — are acceptable and disambiguable: this is a *reference*,
not a primary key.

The local id stays as plumbing (every Beeper write needs it) and stops being what
anyone reads. Each node keeps a private map from the stable id to its own local
one.

Verify first: that the raw body really is byte-identical on both accounts. Our
own messages carry invisible node-signature characters and it is not established
that both accounts receive them unchanged. If one normalises anything, the hashes
diverge silently.

### 7. Smaller

- The relay path holds the shared FIFO but runs without the spine's 10-minute
  turn timeout.
- An in-flight relay record leaks if a responder crashes mid-stream — the next
  line then posts fresh instead of under a placeholder. Degradation, not silence.
- Media on a relay channel still registers a conversation by a different path
  (`onMedia → media.save`), which never passes through `handleFast`.
- The on-disk `identity.d/` consult copies keep raw `{{…}}`; only the fed copy is
  filled.
- `@ev` is half-redundant: replying `e` to a text now reads it aloud. Its other
  role (speaking E's whole generated reply) is a different operation.

---

## Global wren — LIVE since 2026-09-01 14:00

wren is the meta-engineer: one mind over egpt, the radio, and the machine. It had
**six conversations and five threads**, so "wren" in one chat knew nothing of
"wren" in another:

| conversation | thread |
| --- | --- |
| `whatsapp/yz3kJjWXsQJofK9naaVb` — @anrodz, the self-DM | `2a3975c2` |
| `whatsapp/9M8DhdjMm3Qc3hFm3NVy` — Radio WnL | `2a3975c2` — the same one |
| `whatsapp/UuY6K6ly3BV3Ye7QqIne` — SPOILER ALERT: chat de EyAy | `0c701e7e` |
| `whatsapp/6ljZJkx0OaY9ZVhEzFgi` — HFM | `35db53b0` |
| `whatsapp/bWv3isJYZMzDwJzQWDLr` — Reencuentro CRC 1991-2026 | `ee8a293a` |
| `room/lobby` | `f953fc6f` |

**Wanted:** one thread, node-wide. Operator: *"wren should always be the same. he
is a meta engineer."* And: *"warm cli is not so important, since the thread is
going to be replaced by this one, thus the memory — a new warm thread can live
and substitute all other wrens."* The thread is the memory; the process is
disposable.

### What shipped

The seam was already there and had been built for exactly this: `resolveScope`
took `being` unused, and its header said the rule would read `being`, sit ahead
of the membership rule, and need no contract change. All three held.

```yaml
agents:
  wren:
    scope: agent/wren
```

Flat on the agent, deliberately NOT under `conversation_defaults` — that means
"a node-wide default a conversation may override", the opposite of a pin. When
the pin fires, no membership lookup happens at all: it is an explicit operator
declaration about a BEING, while membership is an inference about a CHAT.

Because all four identity keys already derive from the scope, pinning it is the
whole job. The thread, the warm process, the turn FIFO and the run config follow.

**A note the earlier scoping got wrong:** a `thread_id` on the agent is the WRONG
knob, and it is the corruption `identity-scope.mjs`'s header warns about. A
thread is not configuration — it lives in state, in `conversations.yaml` or
`rooms.yaml`, at the conversation's address. Pin the scope and the shared thread
follows; pin the thread alone and you get one session file with several warm keys
on it.

The surface goes through `surfaceOf`, so `shell/lobby` and `room/lobby` are the
same address. The console's NETWORK is `shell` and its SURFACE is `room`, and
either name looks right in config.yaml — without the normalisation, writing the
wrong one opens a second instance that shares nothing with the first.

**The address is `agent/wren`, not `room/wren`** (operator, 2026-09-01, rejecting
the first proposal): *"wren is just an opus. above egpt, above the radio. full
access to everything… basically a super human being with real existence and
agency in the world."* He is not a room. So `agent` became the third entity root
(`67d227e`), beside the Beeper tree and `rooms/`:

```
conversations/<surface>/<slug>/   the Beeper tree
rooms/<slug>/                    a room, which does not arrive through Beeper
agents/<name>/                   an agent's own conversation, likewise
```

`rooms-file.mjs` was GENERALIZED, not copied — every surface-specific thing in it
was one of three values (the surface, the file, the file's root key) — so
`config/agents.yaml` is the same rung over a second registry, holding a pinned
being's global thread and its access configuration. It routes off the namespace
itself, which is what lets `room-core`'s `loadConfig` reach it unchanged.

`fixedSlugFor` gained `agent` beside `room`: the folder is `agents/wren/`, never
`agents/wren-2609011200/`, and never re-slugged — that folder IS the address every
chat resolves to.

**And a pinned being is prompted with the message, never the accumulated cycle**
(`198b151`). This is what "the same thread" means to the operator: *"when in a
chat he is mentioned, the model is prompted with that message, not with the
accumulated."* Without it the pin made things WORSE — `pushCycle` keys on the turn
key, which the pin has just made the scope, so every pinned chat's chatter lands
in one bucket and a single queue means most turns are queued.

The condition is the PIN, not the shared key. The operator ruled directly: *"wren
is the same in all groups/rooms (including acim and perrito traducciones), but E
remains independent per conversation, as always."* A wa-group joined to a room
shares a key by MEMBERSHIP and keeps accumulating exactly as today.

`allow_new_input` is now keyed on `(sender, chat)` (`aee43c0`), which a shared
scope makes necessary and which fixed a live defect at acim on the way — see the
commit.

### How it was wired, and how to verify it again

```
wren in HFM            -> agent/wren   pinned=true
wren in Radio WnL      -> agent/wren   pinned=true
wren in SPOILER ALERT  -> agent/wren   pinned=true
wren in the console    -> agent/wren   pinned=true
egpt in HFM            -> null              (unpinned: untouched)

thread   : 3fddb61c-72f1-41d1-8ee9-328645c89084
folder   : C:Usersan.egptagentswren
warm key : wren:ccode:agent:wren
```

Resolved against the LIVE config and state, not asserted. Note `readConfigSync`,
not `readConfig` — the latter is async and returns a Promise, which silently
reads as "no config at all" and made the pin look broken on the first attempt.

1. `~/.egpt/agents/wren/` created. It starts EMPTY: `seedLayers` copies the
   `skeletons/room/` layers into `identity.d/` on the first turn.
2. `config.yaml`: `scope: agent/wren`, flat on the agent. Needed the restart.
3. The thread was written into `conversations.yaml` under `contacts.agent.wren`
   with `conversation_path: .egpt/agents/wren` — `parse()` re-derives the slug as
   that path's basename, and `fixedSlugFor` keeps it fixed. NOT hand-written into
   `agents.yaml`: the read-through migration lifts it there on the first write,
   which is the designed path and needs no entry to exist first.
4. `3fddb61c-….jsonl` (4053 records, 33 MB) and its sidecar copied into
   `~/.claude/projects/C--Users-an-bin-egpt/`, the project dir wren's pinned
   `cwd` puts it in. The source was LIVE and being appended to, so the copy drops
   a trailing partial line and validates the last complete one — a half-written
   record would make `--resume` fail to parse.

Backups: `config.yaml.bak-wren-0901`, `conversations.yaml.bak-wren-0901`,
`egpt-xhigh.yaml.bak-opus-0901` (wren is `model: opus`, `effort: xhigh` — type
files are `readFileSync` per turn with no cache, so that needed no restart).

**The adopted thread is a FORK, not a share.** Two files in two project dirs. The
Claude Code window it came from kept running on the original; wren continues the
same conversation from the snapshot. No branch was needed. And because the thread
is adopted rather than fresh, the identity card never reaches its prompt — the
four skeleton layers were read INTO the conversation before the handover instead.
4. Move the session file. **wren's type file pins `cwd: C:/Users/an/bin/egpt`**,
   and Claude Code files sessions by working directory, so every wren thread lives
   in `~/.claude/projects/C--Users-an-bin-egpt/`. A thread created anywhere else
   must be copied there — the `.jsonl` **and its sidecar directory** — or
   `--resume` simply will not find it.

### Two things to know before doing it

**The identity card only reaches the prompt on a FRESH thread.** A resumed one
never gets it, so a thread adopted from elsewhere does not know it is wren, on kg,
with the room limbs and rules. Feed it the four `skeletons/room/` layers (about
2 KB) into the conversation before the handover, or it starts blind.

**One queue means head-of-line blocking.** A long turn in the radio room delays a
message in HFM. That is inherent to being one mind, not a bug to engineer around.

**And wren's memory now spans chats.** Something said in SPOILER ALERT is visible
to wren answering in HFM. `allowed_users` gates who can WAKE it, not what it
remembers.

### The threads that get abandoned

All five. That includes `35db53b0`, the HFM one, measured at **882,608 tokens of
a 1,000,000 window** — 88% full, and it would not have compacted until 95%.
Overshooting does not compact, it **resets**: `brainpool` starts a fresh session,
so wren would have lost that conversation rather than compressing it. `ratio` was
lowered 0.95 → 0.80 on kg for that reason.

**Do not hand-set the same thread id in several conversations instead.** That is
the unsafe version of exactly this: N conversations, N warm-pool keys, N
`claude --resume` processes on one session file. It is already configured that
way in one place — `2a3975c2` sits on both the self-DM and Radio WnL — and has
not visibly broken, but that is luck, not design. The pin is what makes it safe.

---


## The guard outage — 2026-09-01, and what it taught

E went silent in *perrito traduciones*, a chat the guard had never looked at.

```
guard: whatsapp:EWlUhmXiFZTYGiKdbfRP stopped — mesh turn suppressed
[perrito traduciones] Rodz: "⚠ ekg.kg did not answer"
```

`EWlUhmXiFZTYGiKdbfRP` is `egpt-mesh-do-kg` — and it is the SECOND chat by that
name, created by the account split. The first, `vcRg7Jh6cLBnQaceeyCP`, has carried
`guard: { turns: -1 }` since July. That override is keyed by chat id, so it did
not come along.

**The counter is a loop detector resting on one assumption**, in `stop-guard.mjs`'s
own header: *"a human turn resets the count, so normal conversation never trips
it."* On a wire that is structurally false — every message is an envelope, so the
count only ever climbs. It was not a loop detector there; it was a countdown to a
permanent stop, and unrecoverable in practice, because clearing it needs a
`resume` typed into a machine-to-machine channel nobody watches.

Fixed in `f013bea` (the guard) and `d4be10a` (the record), both by the same
ruling: **ask about the MESSAGE, never about the chat.**

### Why the obvious predicate was the wrong one

`isTransit` / `isRelayChannelChat` looks like the natural test and is the weaker
one: it matches the configured `relay_channel` NAME against `ev.chatName`, so it
only recognises a wire whose name this node has already learned. The new channel's
`pushedName` was never recorded — its `conversations.yaml` entry still carries the
raw id as its comment — so it answered false, which is ALSO how that channel came
to have a conversation, a transcript and thread `30688631` that transit never gets.

**A chat-identity test fails exactly when a channel is new, which is exactly when
it must not.**

And the case no chat-identity test can ever cover: `mesh.mjs`'s `selfRoute` posts
envelopes into the SELF chat by design when a relay channel does not resolve. The
operator's own command channel is not a wire, so the mesh's own failure path is
precisely the one the narrow reading would miss — filling his transcript with wire
frames exactly when things are already going wrong.

### Still open

The RECORD half is closed. Non-envelope traffic on an unnamed wire — a human
line, our own placeholder escaping the echo gate, a peer's mirror frame — is not
recognisable in the frame, so only the name test can catch it, and on that chat
the name test is blind. That path still registers a conversation. It is locked as
a test so it is not mistaken for fixed. Closing it means teaching
`isRelayChannelChat` the id.

Also still open, and now live rather than theoretical: **two chats share the name
`egpt-mesh-do-kg`**, and `relay_channel` resolves by name with `resolveChatId`
taking the FIRST match. Which chat kg relays into is currently decided by
iteration order — see open item 5.

---

## Traps

- **A patch script that asserts after it edits and before it writes** will print
  success and save nothing. That shipped two green, inert commits. Verify the
  *deployed* file, not the intent.
- **A transcript format change breaks readers silently.** Three times in two days:
  `bodyForMessageId`, `contextSinceLastTurn`, and `transcriptionForNoteId` (whose
  voice mark must be first in the body). Check every parser, every time.
- **Line endings are MIXED in this repo.** `router.mjs`, `mesh.mjs`,
  `dispatch-line.mjs` are LF; `spine.mjs`, `boot.mjs`, `beeper.mjs` are CRLF.
  MSYS `grep -c $'\r$'` reports **every** line as CRLF even for an LF file — use
  Node: `(s.match(/\r\n/g)||[]).length`. Two agents have turned a 130-line diff
  into a 2,700-line one this way.
- **A ccode being cannot be sandboxed.** It authenticates from `~/.claude`, which
  a pool account cannot read. `sandboxed` defaults to **true**, so omitting
  `sandboxed: false` kills every turn before the model runs — that was don, all
  day, invisibly.
- **`access_level: all` with `allowed_users: []` answers nobody.** The structural
  gate refuses the turn. `["*"]` is how you say "anyone" out loud.
- **A rule that stops a loop can also stop a feature.** The blanket "never wake on
  another node's frame" (`39ea8b3`) killed the echo *and* inter-agent addressing;
  reverted in `c691bf2`. Loop safety is the guard's counter and `/rules`, not a
  refusal to hear.
