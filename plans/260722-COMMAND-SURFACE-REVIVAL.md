# egpt Command Surface — What we're building

**Status:** design LOCKED (F, G resolved). Roadmap:
`plans/260722-COMMAND-SURFACE-ROADMAP.md`. No commit yet.

The heart of it: **a room holds members; every member is backed by an adapter;
member mode decides who hears the chatter.** Browser commands, channels, and ops
all hang off that spine.

---

## The model — rooms, members, adapters, modes

**Room** — a conversation with its own `base_dir`. A new Beeper conversation is
just a room with a different `base_dir`. A room holds **members**.

**Adapter** — the general driver for one external system: how the spine talks to
it, both directions. Not web-brain-only — **Beeper is an adapter** (it feeds
chats in and sends out); a future **gmail adapter** would feed email the same
way; a **web-brain adapter** drives a Chrome tab. One interface, many backends:

| adapter | feeds the spine | today |
|---|---|---|
| **beeper** | chats across whatsapp/telegram/signal/matrix | `src/bridges/beeper.mjs` (a bridge = an adapter) |
| **web-brain** | a chatgpt/claude/grok tab as a member | `config/brains/chatgpt-cdp.mjs`, `claude-cdp.mjs` |
| **shell** | the terminal surface | `src/shell/server.mjs` |
| **gmail** (future) | email in/out | — |

A **web-brain adapter** is `{ name, urlMatch, homeUrl, injectScript, pollScript }`.
A tab can become a member **only if an adapter's `urlMatch` matches its URL** — a
random tab (Gmail, a news site) has no adapter, so it can't be a brain. Adding a
site = writing an adapter. (A shared adapter *interface* is the direction; we
don't need to refactor Beeper into it to ship phase 1.)

**Member** — an adapter bound into a room:

| kind | is | added via |
|---|---|---|
| **surface** | the shell, a Beeper Self-DM | present when connected |
| **chat** | a Beeper chat (any network) | `/join <slug>` |
| **tab / web-brain** | a Chrome tab + its adapter | `/members add tab <id>` |

**Member mode** — the contribute gate, per member. A tab is added **disabled** so
chatter can't reach it until you say so:

- `disable` — receives nothing (**default on add**)
- `mention` — receives only when addressed (`@chatgpt …`)
- `all` — receives every message in the room

**Active (presence)** is separate from mode: a tab member is *active* when its
Chrome tab is open (live targetId). If Chrome closed it, the member is *inactive*
until `/activate <id>` reopens its saved URL.

**Falls out for free:** a reply lands in the room and fans out to every member
per its mode, and `@e` is identical on the shell and on Beeper (same room, same
routing).

---

## Flagship usage — open the shell, wire a web brain into a room

```
$ node egpt-shell.mjs      # the operator SHELL (egpt.mjs is the spine itself — don't run that by hand)
🧠 egpt shell · spine connected · :23375

🦅 you   /rooms
🧠 egpt  rooms:
           · scratch      2 members   (current)
           · devwork      4 members

🦅 you   /rooms devwork join
🧠 egpt  joined 'devwork' — now current. this shell is a member.

🦅 you   /members
🧠 egpt  devwork:
           · shell            surface   active   mode:all
           · an (whatsapp)    chat      joined   mode:all

🦅 you   /tabs
🧠 egpt  tabs:
           1 · ChatGPT     https://chatgpt.com/c/abc    adapter:chatgpt ✓
           2 · Claude      https://claude.ai/chat/def   adapter:claude  ✓
           3 · Gmail       https://mail.google.com      adapter:none    ✗

🦅 you   /members add tab 1
🧠 egpt  added 'chatgpt' (tab 1 · adapter:chatgpt) — mode:disable (no chatter reaches it yet)

🦅 you   /members chatgpt mode mention
🧠 egpt  chatgpt → mode:mention (reached only when you @chatgpt)

🦅 you   @chatgpt summarize the last 10 messages in this room
🤖 chatgpt  …                                   ← streamed live from tab 1

🦅 you   /members add tab 3
🧠 egpt  can't add tab 3 — no adapter matches mail.google.com.
         adapters are per-site drivers (chatgpt, claude, grok…); add one to support it.

# a member whose tab you later closed:
🦅 you   /activate chatgpt
🧠 egpt  reopened https://chatgpt.com/c/abc · tab 4 · active
```

Set `mode:all` and the brain sees every message — a room can hold `chatgpt`
**and** `claude` at once, each gated independently. Because the reply lands in
the room, it also fans out to the whatsapp member and the shell.

**Grammar:** `/rooms` lists; `/room <slug> <sub>` operates on a named room
(`join|leave|members|…`); `/members …` is shorthand for the **current** room.
`/rooms <slug> join` is accepted as an alias of `/room <slug> join`.

---

## How the relay works (verified)

`/members add tab <id>` → match adapter by URL → the member's turns run through
`streamFromTab(targetId, adapter.injectScript, adapter.pollScript)`
(`src/tools/cdp.mjs`): inject text into the web UI, submit, poll the DOM until the
reply stabilizes (locale-stable stop-button + streaming-flag heuristics), stream
it back into the room.

- **Survives (VERIFIED):** the `streamFromTab` engine, the `chatgpt`/`claude`
  adapters, and the logged-in 205 MB Chrome profile (sessions authenticated).
- **Cut (the wiring):** the brainpool routes only `type: ccode` today (seed
  template: *"only ccode wired in v2"*). Consolidating = route a tab member's
  turn through its adapter + `streamFromTab`, and add the member commands.

### Guards — one guard, one knob (VERIFIED landscape)

Decision (yours): with **E in auto** and a brain at `mode:all`, both answer every
message, and brains may @-mention each other → a live multi-brain conversation.
That NEEDS a loop-breaker. What exists today:

| guard | axis | where | status |
|---|---|---|---|
| **flood-guard** (`src/flood-guard.mjs`) | raw sends / window (10 / 3s) | bridge SEND path | **wired**, config-driven |
| **mesh breaker** (`src/mesh/relay.mjs`) | mesh sends / window (5 / 20s) | cross-node relay | **wired**, hardcoded |
| **stop-guard C7.7** (`src/stop-guard.mjs`) | consecutive bot-turns + human STOP/RESUME | prompt chokepoint | **module exists, ORPHANED — 0 callers in v2** |

So v2 today has **only burst protection**; the semantic loop-breaker and the human
STOP safe-word are dark (the nucleus that called them was deleted).

**One guard, one knob — turn-counter only (G dropped).** The single guard is the
**turn counter**: N consecutive non-human turns → pause; a human message resets it.
No burst backstop. What makes this safe is that **"human" is decided by provenance,
not display name**: a turn resets the counter only if it's a genuine inbound human
message — NOT a bot send (`wasSentByUs`), NOT relay/envelope traffic (`isEnvelope`),
NOT a being emit. That closes the 2026-06-19 hole (mesh posting *as the operator*)
that a name-based counter missed — the exact case the flood-guard existed for. So
`flood-guard` + mesh breaker are removed; the provenance-aware turn counter is the
whole guard, invoked at every path — *a guard that isn't in the path is false
confidence.*

```yaml
# config.yaml — replaces `flood:`; per-conversation overridable; -1 disables
guard:
  turns: 6      # consecutive non-human turns → pause (your default; -1 = off)
  window: -1    # minutes; optional — only count turns within this span (-1 = no window)
```
```yaml
# conversations.yaml — a room that lets brains chat freely
<slug>:
  guard: { turns: -1 }
```

Counting consecutive non-human turns *is* the guard; `window` is an optional belt
(turns older than N minutes drop off the count), off by default. A human message
always resets the counter. The **turn counter is the orphaned stop-guard
re-wired** (it already counts being-turns, resets on human, warns then STOPs);
the burst backstop is flood + mesh folded in with fixed defaults.

---

## Command dispatch (the mechanism)

Surface-agnostic: the shell and any Beeper Self-DM forward the raw line to the
same spine, which runs it deterministically (no model, no tokens).

```
  shell / Beeper Self-DM ──►  spine dispatch (src/spine/commands.mjs)
                                │  allowed user? starts with '/'?
                                │  match verb → run in code
                                │    ├─ tools/cdp.mjs      (tabs + adapter relay)
                                │    ├─ bridges/beeper.mjs (chats, send, react)
                                │    └─ lifecycle exit code (restart/upgrade)
                                ▼
                          reply → room → fans out to members (per mode)
```

- **Allowed-users gated.** VERIFIED: `allowed_users: []` exists per surface
  (`isAllowedUser`, `src/spine/boot.mjs:380-416`). To build: a per-conversation
  override in `conversations.yaml`.
- **Node-addressable.** A trailing node targets a spine: `/chrome kg` → REVE,
  `/tabs do` → DOLLY. Omit it → the receiving node.

---

## What comes back — by family

`✓` = wired · `+` = bring back · `✗` = evicted · `~` = deferred

**Rooms & members** `/rooms +` `/room <slug> join|leave|members +`
`/members [add tab <id> | <id> mode <m>] +` `/activate <id> +` · `/room create ✓`

**Browser / CDP** `/chrome ✓` · `/tabs +` (shows adapter match) `/open <url|brain> +`
`/tab <n> +` `/close <n> +` · `/browse ✗` (dead export removed)

**Channels & joining** `/channels [slug] +` · `/join <slug> +` (chat or brain) · `/mirror +`

**Persona / agent** `/e ✓` `/e auto ✓` · `/identity +` `/who <slug> +` (`/handle` dropped)

**Lifecycle & ops** `/restart ✓` `/upgrade ✓` `/rewind ✓` `/version +` `/config +`
`/log +` · `/status ~` (on standby)

**Conversation** `/recap +` `/last +` `/summarize +` `/conversations +`

**Not coming back:** `/movie` `/textmovie` `/storm` `/rules` `/browse` ·
`/theme` stays shell-local.

---

## Secondary examples

### Channels — grouped by network, slug-first

```
🦅 you   /channels
🧠 egpt  1. whatsapp (15 most recent)
           1.1  family            · 3 unread
           1.2  padel-group
         2. telegram
           2.1  devs
         3. signal
           3.1  jane

🦅 you   /join devs
🧠 egpt  joined 'devs' (telegram) — this surface now mirrors the chat, both ways.
```

`/channels` renders `beeper.listChats()` grouped by network; `<slug>` filters.
Beeper has no "join a new external channel" API — `/join` binds chats the
account already sees.

### Who

```
🦅 you   /who jane
🧠 egpt  jane
           network : signal
           kind    : DM · last activity 2h ago
           id      : +1555…@signal
```

---

## Order of work

Your main interest (rooms + tab members) leads:

1. **`/tabs`** (list, with adapter match) + `/open /tab /close` — thin wrappers,
   evict `browseTab`. The visibility the member flow needs.
2. **Rooms & members core** — `/rooms`, `/room <slug> join|members`, `/members
   add tab <id>` (adapter-matched, added `disable`), `/members <id> mode <m>`,
   `/activate`. The room/member/mode machine.
3. **Adapter relay (chatgpt only)** — wire a `chatgpt` tab member's turn through
   its adapter + `streamFromTab`; `@mention` routing honoring mode. *The
   consolidation.* claude/grok adapters come later, on demand.
3b. **One guard** — re-wire the orphaned stop-guard as the turn counter
   (`guard.turns` + optional `window`, per-conv override, `-1` off); fold flood +
   mesh in as the internal burst backstop; invoke at bridge-send + mesh-relay +
   prompt-in. Restores the human STOP/RESUME safe-word. Ships with phase 3.
4. `/channels [slug]` + `/join <slug>` (chats as members).
5. `allowed_users` per-conversation override.
6. Long tail: `/recap /last /summarize /conversations /config /log /version
   /who /identity /mirror /room leave`.

*(Backburner: files/images from a brain reply into `base_dir` — revisit after
the relay is solid.)*

---

## Open decisions

- **OPEN F** — the guard unification touches `flood-guard`, `mesh/relay`,
  re-wires `stop-guard`, adds the `guard:` config, and closes a live v2 gap (no
  loop-breaker / STOP safe-word today). Ship it inside phase 3 as written, or
  split it into its own focused chunk before phase 3?
*(Resolved: `/handle` dropped · `/status` shelved · web-brain = addressable
member gated by mode · order approved · adapters generalized, Beeper is one ·
D = chatgpt adapter first · B files/images = backburner · E = brains chat when E
is auto · E-follow = `turns: 6` + optional `window`, human resets, in
`config.yaml`, per-conversation override, `-1` disables · guards collapse to one ·
**G = dropped** — turn-counter only, safe via provenance-based human detection ·
**F = guard is phase 3**, lands before the relay.)*

---

## Next

**Roadmap written:** `plans/260722-COMMAND-SURFACE-ROADMAP.md` — 7 phases, each a
shippable chunk with a reproduce-first test + verify line + commit. Review it and
we start phase 1.
