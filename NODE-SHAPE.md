# The shape of a node

What a finished eGPT node looks like.

eGPT can be configured with no mobile numbers, one mobile number, two mobile
numbers or more. eGPT can use the other number(s) for its replies.


## Zero mobile numbers

No Beeper needed.

You can use eGPT from the shell and access AI.


## One mobile number

One account, one token, one Beeper install, one spine, in your ordinary desktop
session. Agents answer from your own number — the reply and the message it
answers share a sender.

`README.md`'s baseline, and a finished node. Everything below is enhancement,
not repair.


## Two mobile numbers, or more

A second account is a second number, so the agents answer as themselves. It
costs three Beeper installs and two spines per machine; each further number
adds one more of each.

- `email@domain.com` — yours. The human.
- `email.secondary@domain.com` — **secondary**. The mouth the agents speak
  through.

Every account is logged in on every machine. **Configuration decides who
answers** — each node gets its own handle — not which account is logged in
where. Every account sees every message any of them is in, so the handle
discriminates, and handles must be disjoint across every spine or one mention
wakes two (live bug in `router.mjs`: two spines answered a single mention, each
stamping its own handle).

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
| session 0 | nssm service, LocalSystem, **Auto** | yours | survives logoff and reboot |
| session 0, secondary | nssm service, LocalSystem, **Auto** | secondary | unattended too |
| session 1 | ordinary desktop GUI | yours | your own window; what a browser and a desktop need |

**Both services Auto.** A service that inherits `Manual` from whatever it was
renamed from leaves the node half-alive after a reboot: one spine talking, the
other silent, nothing announcing it.

Give each install a display name carrying its role, or the service list is
unreadable.


## Two spines per machine

`egpt-daemon` and `egpt2-daemon` run the **identical command** —
`node egpt-daemon.mjs` from `~/bin/egpt` — differing ONLY in `EGPT_HOME`
(`~/.egpt` vs `~/.egpt2`). One deploy, nothing to keep in sync; wrong with one
is wrong with both. The profile is the entire distinction between the two
accounts.


## The config shape

```yaml
beeper:
  use: main
  main:
    account: email@domain.com
    token: bdapi_...
```

**No port. Ever.** Beeper binds the first free port from 23373, so it follows
START ORDER, not identity — three installs reshuffled the ports three times in
one evening. The spine probes the loopback range with the token and takes the
install answering 200; a token belongs to an INSTALL, so exactly one can. It
re-asks on every reconnect, so a moved install is followed rather than knocked
on forever.

`base_url` skips discovery — only for a genuinely non-local Beeper.
`endpoints:` is deprecated: it repeated one token across four ports, the config
admitting the code could not find its own API.


## Checklist

Two-account node. Run it before saying yes.

1. Both Beeper services **Running** and **Auto**
2. Both spines Running, descriptions naming the profile
3. Both configs `account` + `token` — no ports, no `endpoints:`
4. Both spines log `connection 'main' → ... 200` and `subscribed to all chats`
5. The two nodes' handles disjoint, and no other node claiming them
6. **It survives a reboot** — services come back, discovery finds the installs
   cold, both spines subscribe untouched


## Known-not-done, 2026-09-07

On the first node built to this shape:

- **6 is unproven.** Nothing has been through a restart; auto-start, cold-boot
  discovery and the S0→S1 flip are configured, none exercised.
- **Reactions come from the wrong account.** The 👀 marking new input posts from
  whichever bridge ingested the message — yours — while the reply comes from the
  secondary.
- **The S0→S1 flip has never run.** The session 1 install exists and is
  addressable; no logon has handed the profile over. See the handover plan.


## Mirroring to another machine

Same accounts, same service shape, same config shape. What differs:

- `node_name` and the persona
- Each account needs its OWN enrolled device on the new machine. Enroll it,
  don't copy — a copied `user-data-dir` moves the device, so two machines on one
  copy is two clients claiming one device id.
- **Disarm any relay handle both machines answer to before waking the second
  one**, or one mention wakes both nodes and the group gets two answers from two
  accounts.
