# egpt — The Lobby (the shell's default Room)

**Status:** design — tracked for your edits (staged, not committed). Change any
line and I'll read the diff.

---

## The idea

The shell needs a **home**. Instead of the ad-hoc `shell-<id>` console
conversation it invents today, the shell defaults to a **lobby** — a `Room`
instantiated at `rooms/lobby/`. It isn't a specific-purpose room; it's the
operator's default space, exactly like **Self** in Beeper.

The whole point: **the lobby IS a Room**, so everything the Room machinery already
gives us comes for free —

- a transcript (`rooms/lobby/transcript.md`)
- media (`rooms/lobby/media/`)
- a members roster (`rooms/lobby/config.yaml`)
- `base_dir`, heartbeats, transcription — all the Room behavior we already built.

No new "shell conversation" concept. The shell just points at a Room.

## Access (default members)

The lobby has this node's local beings available by default — **E, D, L**
(`@e`, `@d`, `@l`) — no adding required. It can also hold added members (a
`chatgpt` brain tab, a joined Beeper chat, …) like any Room. It's "not a specific
room," but it can grow members just the same.

## How the shell uses it

- Open the shell → you're **in the lobby** (the default current room). No "join a
  room first" friction for the common case.
- `/members`, `@e`/`@d`/`@l`/`@chatgpt`, the transcript, and `media/` all operate
  on the **current room** — the lobby by default.
- `/room <slug> join` (or `/join <slug>`) switches the current room to another
  Room — a named room or a Beeper chat.
- `/room lobby join` (or `/lobby`) returns to the lobby.

## Why this is the right shape

- Kills the throwaway `shell-2607201416` console — the shell has a real, durable
  home with a transcript and media.
- **One model:** the current room is always a real `Room` (lobby by default), so
  `/members`, the brain relay, and the transcript always line up — no special
  shell-only path.
- The lobby ≈ Beeper's **Self**: a default personal space that is nonetheless a
  full room.

## Build (sketch)

1. On boot, ensure a lobby Room at `<EGPT_HOME>/rooms/lobby/` (create if missing),
   seeded with the local beings **E / D / L** as members.
2. The shell surface's default current-room = `lobby` (the surface→room binding
   defaults to it, not an auto console conversation).
3. `/members`, the relay, the transcript, and media resolve to the current room
   (lobby by default); `/room <slug> join` switches it; `/lobby` (or
   `/room lobby join`) returns.
4. Shell input is handled in the current room's context, so `@e` / `@chatgpt` /
   etc. act on the lobby (or whatever room is joined).

*(This supersedes the earlier A/B "mirror scope" question: the lobby is the home;
joining a Beeper chat later is just switching the current room to that chat, and
the 2-way Beeper mirror is a follow-up on top of this.)*

## Test

```
node egpt.mjs                  # connects; you're in the LOBBY
/members                       # lobby roster: E, D, L
@e hello                       # E replies — logged to rooms/lobby/transcript.md
/chrome                        # recovered profile; then:
/tabs                          # note the ChatGPT tab number N
/members add tab N             # added 'chatgpt' to the lobby
/members chatgpt mode mention
@chatgpt say hi in five words  # 🤖 chatgpt streams into the lobby
/room family join              # switch the current room to the 'family' Beeper chat
/members                       # family's roster
/room lobby join               # back to the lobby
```

Then check on disk:
```
~/.egpt/rooms/lobby/transcript.md   # the lobby conversation is being recorded
~/.egpt/rooms/lobby/config.yaml     # members: E, D, L (+ chatgpt after add)
~/.egpt/rooms/lobby/media/          # any media dropped in the lobby lands here
```

**Pass =** the shell opens straight into the lobby, `/members` shows E/D/L,
`@chatgpt` (once added) answers into the lobby, and the transcript + config on
disk reflect it.
