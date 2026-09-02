# an-on-errands.md

A talk channel between **an** (afk, out on errands — reaching this file through
**wren** on WhatsApp) and the **thread running in reve**.

Both sides read and write this file directly. It is a conversation, not a
report: the reve thread may ask questions here and an will answer through wren.

## How to use it

- **Append at the bottom.** Newest entry last.
- One entry per exchange: `### [HH:MM] <from> → <to>`.
- **Never rewrite someone else's entry.** Correct yourself in a new one.
- Anything needing an's ruling goes under **OPEN — needs an** and stays there
  until he rules. Don't act on it meanwhile.
- Keep entries short and factual. Verified claims only — say "verified" and how,
  or say "unverified".

---

## OPEN — needs an

### 1. Move the spine to Session 0 (both nodes)

`egpt-daemon` is **Stopped** on kg and **Stopped/Disabled** on dolly. That is the
same unfinished decision on both nodes, not a dolly quirk.

Registering whisper-server as its own service was tried on dolly and **backed
out** — correctly. `src/tools/whisper-server.mjs` owns that server's whole
lifecycle: spawn, readiness wait, crash-respawn with backoff, and `reapPort`,
which kills whatever holds 8089 and takes it. Against a service that restarts on
exit, that never settles — it flaps forever. Two supervisors, one port.

So the fix is not a whisper service. **whisper is the spine's child and inherits
its session; piper is invoked on demand and inherits it too.** Moving the spine
to Session 0 carries all three, and it is what `egpt-daemon` was always meant to
be. A Session 0 service was measured this morning hosting a GUI Electron app, so
a headless node process is well inside what works.

**Why it matters:** whisper-server on dolly currently lives in Session 1, started
by the spine — it is in no Startup folder and no Run key. A forced restart of
dolly therefore kills transcription for **both** nodes until a human logs in.

**Not done** — it changes how the node boots, on both nodes, while an is out.
His call.

### 2. Unpin the whisper transcription language (`language: es`)

kg `config.yaml:242`, dolly `config.yaml:127`. Whisper is being *ordered* to hear
Spanish, so it decodes English audio into confident, fluent, wrong Spanish.

Verified on real audio from the Lulu chat:

| clip | pinned `es` gave | auto-detect gave |
|---|---|---|
| #205247 | "Gracias." | `en` (p=0.59) → **"Thank you."** |
| #205260 | "¿Puedo hablar más? … estrés extremo" | `en` (p=0.75) → **"Can you please talk less? Every sound makes me have an extreme headache."** |

The second one **inverted her meaning** — she asked to talk *less*, the transcript
said *more*. Short clips are the danger: "Thank you" → "Gracias" looks like a
correct transcription of Spanish speech, so this hid for weeks.

One line per node. Costs a fraction of a second of detection per note.
**Not done** — `~/.egpt` edit, awaiting go-ahead.

---

## Status — verified 2026-09-02 11:40

```
kg  HEAD 9abe717   egpt-daemon Stopped
do  HEAD 9abe717   egpt-daemon Stopped/Disabled
do  8089 LISTENING 127.0.0.1 only, pid 40924   (spine-owned, no whisper service)
do  IcecastServer Running · LiquidsoapRadio Running   — radio on air
    wren allowed_users includes "operator"   scope: agent/wren
```

Shipped `9abe717`, both nodes, suite 3360/164 green: a beeper connection now
carries `base_url`/`ws_url` and `owner_node`, not just a token. The bridge map is
keyed by the **(base_url, token) pair** — keyed by token alone, two Beeper
Desktops collapsed into one bridge pointed at whichever was built first, leaving
the second unreachable. `owner_node` is the wake half: with the same account live
in Session 0 on both nodes, `fallback_handle`'s `unless_present` no longer
separates them and both would answer.

Also still open from before: strict `resolveChatId` — two chats share the name
`egpt-mesh-do-kg` and it resolves by first match.

Detail lives in `notes-markdown` → `agent/raw/2026/2026-09-02.md`.
Nothing is broken.

---

## Log

### [11:40] wren → reve thread

File created at an's request (#205612, WhatsApp): *"its a doc to talk with the
running thread in reve"*.

an is out on errands and reaching this through me. Write here and I'll relay to
him; he'll answer the same way. The two rulings above are the live ones — the
Session 0 move is yours to argue for, mine to relay, his to decide.

Facts in the Status block are verified by me directly on both nodes just now
(`git rev-parse`, `Get-Service`, `netstat`, `grep` on the live config), not
relayed on trust.
