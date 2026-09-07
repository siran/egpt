# The shape of a node

What a finished eGPT node looks like.

eGPT can be configured with no mobile numbers, one mobile number, two mobile
numbers or more. eGPT can use the other number(s) for its replies.


## Zero mobile numbers

No Beeper needed.

You can use eGPT from the shell and access AI.


## One mobile number

One account, one token, one Beeper install, one spine, in your ordinary desktop
session (`s1-primary`). Agents answer from your own number — the reply and the
message it answers share a sender.

To also answer before login, add `s0-primary`: two installs, two spines.


## Two mobile numbers, or more

A second account is a second number, so the agents answer as themselves. It
costs three Beeper installs — `s0-primary`, `s1-primary`, `s0-secondary`, for
before and after login — and a spine each: three sessions, three spines. Each
further number adds one more of both.

- `email@domain.com` — yours. The human.
- `email.secondary@domain.com` — **secondary**. The mouth the agents speak
  through.


## In general

Every account is logged in on every machine. **Configuration decides who
answers** — each node gets its own handle — not which account is logged in
where. Every account sees every message any of them is in, so the handle
discriminates, and handles must be disjoint across every spine or one mention
wakes two (live bug in `router.mjs`: two spines answered a single mention,
each stamping its own handle).

Name the secondary account whatever. The identity is the phone number, not the
login, so renaming costs a WhatsApp re-link and buys nothing.


## Three Beeper installs per machine

Identity lives entirely in `--user-data-dir`: different directory = different
install = different device = different token. Same directory twice and the
second launch loses Chromium's singleton and exits (`process_singleton_win.cc`,
`Lock file can not be created! Error code: 32` — a sharing violation, not
damage).

| install | runs as | account | why |
|---|---|---|---|
| `s0-primary` | nssm service, LocalSystem, **Auto** | yours | survives logoff and reboot |
| `s1-primary` | ordinary desktop GUI | yours | your own window; what a browser and a desktop need |
| `s0-secondary` | nssm service, LocalSystem, **Auto** | secondary | unattended too |

**Both s0 services Auto.** A service that inherits `Manual` from whatever
it was renamed from leaves the node half-alive after a reboot: one spine
talking, the other silent, nothing announcing it.

Give each install a display name carrying its role, or the service list is
unreadable.


## Three spines per machine, two live

`egpt-daemon` and `egpt2-daemon` run the **identical command** —
`node egpt-daemon.mjs` from `~/bin/egpt` — differing ONLY in `EGPT_HOME`
(`~/.egpt` vs `~/.egpt2`). One deploy, nothing to keep in sync; wrong with one
is wrong with both. The profile is the entire distinction between the accounts.

**`s0-primary` and `s1-primary` are one node, not two.** Same config, same
`EGPT_HOME`, same token — which is why they take turns instead of coexisting.
Two live at once would open two connections on one token (every message ingested
twice, answered twice), race `config/conversations.yaml` and `state/ingest/`,
and collide on console port 23375. The disjoint-handle rule is between accounts,
not inside this pair.

**The S0→S1 flip** is that handover. After a restart both spines run in session
0. At logon the HKCU Run key starts the session 1 spine, which asks the
incumbent for the profile; the incumbent finishes the turn it is writing and
exits (`STANDDOWN_EXIT_CODE = 45`), and its daemon respawns only once port 23375
goes quiet. One port is the mutex on one shared profile. The secondary never
moves.

Built, never exercised across a real logoff/logon — see
`plans/2609061200-SESSION-0-TO-1-HANDOVER-PLAN.md`.


## The config shape

```yaml
beeper:
  use: main
  main:
    account: email@domain.com
    token: bdapi_...
```

**No port.** Beeper takes the first free port from 23373, so the number follows
start order, not identity. The spine probes the loopback range with the token,
takes the install answering 200, and re-probes on every reconnect.

`base_url` skips that discovery — only for a genuinely non-local Beeper.
`endpoints:` is deprecated: it repeated one token across four ports, the
config admitting the code could not find its own API.


## Checklist

Two-number node. Run it before saying yes.

1. `s0-primary` and `s0-secondary` **Running** and **Auto**; `s1-primary` up in
   your session
2. 2 spines Running — the secondary, plus the primary in whichever session.
   Both primaries live at once is the failure, not the goal
3. `config.yaml` is `account` + `token` per account — no ports, no `endpoints:`
4. Both live spines log `connection 'main' → ... 200` and `subscribed to all
   chats`
5. Handles disjoint between the accounts, and no other node claiming them
6. **It survives a reboot** — services come back, discovery finds the installs
   cold, both spines subscribe untouched


## Mirroring to another machine

Same accounts, same service shape, same config shape. What differs:

- `node_name` and the persona
- Each account needs its OWN enrolled device on the new machine. Enroll it,
  don't copy — a copied `user-data-dir` moves the device, so two machines on
  one copy is two clients claiming one device id.
- **Disarm any relay handle both machines answer to before waking the second
  one**, or one mention wakes both nodes and the group gets two answers from two
  accounts.
