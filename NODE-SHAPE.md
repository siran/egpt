# The shape of a node

What a finished eGPT node looks like.

eGPT can be configured with no mobile numbers, one mobile number, two mobile
numbers or more. eGPT can use the other number(s) for its replies.

One spine holds them all. Numbers are connections in one config, not processes:
adding a number adds a Beeper install and a config block, never another spine.


## Zero mobile numbers

No Beeper needed.

You can use eGPT from the shell and access AI.


## One mobile number

One account, one token, one Beeper install, one spine. Agents answer from your
own number — the reply and the message it answers share a sender.


## Two mobile numbers, or more

A second account is a second number, so the agents answer as themselves. It
costs one more Beeper install and one more block under `beeper:`. The spine
listens on every connection it holds and answers on whichever one heard the
message; an agent that names its own `beeper_connection` answers on that
instead.

- `email@domain.com` — yours. The human.
- `email.secondary@domain.com` — **secondary**. The mouth the agents speak
  through.

Two accounts in one real group are **two chats, not one**. Beeper is Matrix, so
each account sees that group as its own room with its own `chatId`, thread,
warm process and queue. Nothing is deduplicated, deliberately: which one answers
is decided by addressing.


## In general

Every account is logged in on every machine. **Configuration decides who
answers** — each node gets its own handle — not which account is logged in
where. Every account sees every message any of them is in, so the handle
discriminates, and handles must be disjoint across every spine or one mention
wakes two (live bug in `router.mjs`: two spines answered a single mention,
each stamping its own handle).

Name the secondary account whatever. The identity is the phone number, not the
login, so renaming costs a WhatsApp re-link and buys nothing.


## One Beeper install per account

Identity lives entirely in `--user-data-dir`: different directory = different
install = different device = different token. Same directory twice and the
second launch loses Chromium's singleton and exits (`process_singleton_win.cc`,
`Lock file can not be created! Error code: 32` — a sharing violation, not
damage). So the installs cannot be merged the way the spines can: a token
belongs to an install.

Name each install after its connection, and run every one of them in session 0
as an nssm service, LocalSystem, **Auto**:

| install | account | why |
|---|---|---|
| `beeper-main` | yours | survives logoff and reboot |
| `beeper-secondary` | secondary | the same, for the second number |

**Auto, not Manual.** A service that inherits `Manual` from whatever it was
renamed from leaves the node half-alive after a reboot: the spine up, one
account deaf, nothing announcing it.

Session 0 is enough for all of them. **Session isolation isolates the desktop,
not a loopback socket** — measured on 2026-09-06, a real Chrome and two
`Beeper.exe` were serving CDP from session 0. A session 1 Beeper buys visibility
to you, not reachability for the spine.


## Two spines per machine, one live

`s0-egpt` and `s1-egpt` are **one node in two sessions**, not two nodes. Same
config, same `EGPT_HOME`, same tokens — which is why they take turns instead of
coexisting. Both live at once would open two connections per token (every
message ingested twice, answered twice), race `config/conversations.yaml` and
`state/ingest/`, and collide on the console port (23475 by default).

Session 1 exists for one reason: a spine there can **spawn and supervise a
browser as an ordinary child process**. A session 0 browser is invisible to you
— it cannot be seen, clicked, or shown a login prompt.

**The S0→S1 flip** is the handover. After a restart the spine runs in session 0.
At logon the HKCU Run key starts the session 1 spine, which asks the incumbent
for the profile; the incumbent finishes the turn it is writing and exits
(`STANDDOWN_EXIT_CODE = 45`), and its daemon respawns only once **nothing holds
the profile** — `state/spine.pid` names no live process (paired with a fresh
`state/alive.txt` beat, as the singleton has always done) and the console port
is quiet. The pid is the mutex; the port is a second witness, not the answer.
Reading the port alone put two spines on one profile on 2026-09-11: Beeper takes
the next free port from 23373 up, grabbed the console the instant the departing
spine released it, and the arriving spine — alive and holding the profile —
could not bind and so was invisible.

Built, never exercised across a real logoff/logon — see
`plans/2609061200-SESSION-0-TO-1-HANDOVER-PLAN.md`.


## The config shape

```yaml
beeper:
  use: main
  main:
    account: email@domain.com
    token: bdapi_...
  secondary:
    account: email.secondary@domain.com
    token: bdapi_...
```

One bridge is opened per distinct token. `use:` names the default connection —
every agent that does not set its own `beeper_connection` rides it — and
switching the default is one word, not a re-typing of tokens.

**No port.** Beeper takes the first free port from 23373, so the number follows
start order, not identity. The spine probes the loopback range with the token,
takes the install answering 200, and re-probes on every reconnect. A token
answers 200 on its own install and 401 everywhere else, which is what makes the
probe unambiguous.

`base_url` skips that discovery — only for a genuinely non-local Beeper.
`endpoints:` is deprecated: it repeated one token across four ports, the config
admitting the code could not find its own API.

`peer_spine` is for another machine, not this one. Two accounts on one machine
need no link: mind and mouth are already in one process.


## Checklist

Run it before saying yes.

1. One Beeper service per account, **Running** and **Auto**
2. One spine Running, in whichever session — two live is the failure, not the
   goal
3. One `config.yaml`, one block per account, `account` + `token` — no ports, no
   `endpoints:`, no `peer_spine`
4. The spine logs `connection '<name>' → ... 200` for every connection, and
   `subscribed to all chats`
5. A message on each number wakes the spine, and its reply goes out on that same
   number
6. Handles disjoint between accounts, and no other node claiming them
7. **It survives a reboot** — services come back, discovery finds the installs
   cold, the spine subscribes untouched


## What is deployed today

This, as of 2026-09-11. `kg` is one spine holding both accounts as connections:
`primary` is the EAR, `secondary` is the MOUTH, and `primary_gui` is declared and
never dialled. One rule decides every send — if the mouth can reach the chat the
mouth speaks, and if it cannot the ear does — so a Self-DM, which only the
operator's account has, is answered on the ear without a special case.

`kg2` is NOT that second account. It is a second NODE on its own profile
(`~/.egpt-secondary`), with its own conversations and its own memory, and
`peer_spine` still joins the two so a reply can be SAID by Rodz in a chat both
accounts are in. That link stays.

So the multiplicity that got collected was the SUPERVISOR, not the account. One
`egpt-daemon` carries every profile in its session (`EGPT_HOMES`);
`egpt-secondary-daemon` folded into it. The axis is the session, because only a
Session 1 process can supervise a Session 1 spine.

What is NOT yet exercised: the S0→S1 handover across a real logoff/logon.


## Mirroring to another machine

Same accounts, same install shape, same config shape. What differs:

- `node_name` and the persona
- Each account needs its OWN enrolled device on the new machine. Enroll it,
  don't copy — a copied `user-data-dir` moves the device, so two machines on
  one copy is two clients claiming one device id.
- `owner_node` decides which node WAKES on an account that is live on both.
  Every other node still sends on it.
- **Disarm any relay handle both machines answer to before waking the second
  one**, or one mention wakes both nodes and the group gets two answers from two
  accounts.
