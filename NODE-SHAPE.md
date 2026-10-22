# The shape of a node

What a finished eGPT node looks like.

A node is a machine. It runs **one spine**, and the spine holds every account the
node manages. Accounts are connections in one config, not processes: adding a
number adds a Beeper install and a config block, never another spine and never
another node.


## Accounts: the ear and the mouth

eGPT listens on one account and speaks through one account. Those are two
**roles**:

- **ear** — the account messages arrive on. Yours: the human's number.
- **mouth** — the account the agents speak through.

How many numbers you give it only decides whether those roles are held by the
same account. **The shape is identical either way.**

### Zero mobile numbers

No Beeper needed. You use eGPT from the shell and access AI.

### One mobile number

One account is both ear and mouth. One token, one Beeper install, one spine.
Agents answer from your own number — the reply and the message it answers share
a sender.

### Two mobile numbers

Your account is the ear; the second is the mouth, so the agents answer as
themselves. It costs one more Beeper install and one more config block. Where
the mouth cannot reach a chat — a Self-DM, which only your account has — the ear
answers instead, by the same rule rather than a special case.

Two accounts in one real group are **two chats, not one**. Beeper is Matrix, so
each account sees that group as its own room with its own `chatId`, thread,
warm process and queue. The secondary only HEARS a chat the primary is not in,
so one message has exactly one ear and there is nothing to deduplicate.

Handles must be disjoint across every node, or one mention wakes two. The
identity of an account is its phone number, not its login, so renaming a login
costs a WhatsApp re-link and buys nothing.


## What runs on a node

One egpt per session type, so **nothing carries a session in its name**. Beeper
is named for its **role** — the same word as its config key:

| name | kind | job |
|---|---|---|
| `egpt-daemon` | scheduled task (at logon) | keeps the node loop alive in **session 1** — the node's one runner |
| `egpt-beeper-primary` | Windows service (nssm, Auto) | Beeper for the primary account — the ear |
| `egpt-beeper-secondary` | Windows service (nssm, Auto) | Beeper for the secondary account — the mouth; two-number nodes only |

The Session 0 `egpt-daemon` service is **retired** (2026-10-17: stopped and Disabled on
both nodes; `setup\uninstall-nssm-service.cmd` removes it).

**Never an account name in a service name.** The role is what the spine reads,
so `egpt-beeper-primary` is the install behind `beeper.primary` on every node,
whichever human's number that is. And the `egpt-beeper-` prefix says what
stopping it costs: an ACCOUNT goes offline, not a spine — which matters most
during an incident, exactly when the services list gets read.

### The processes you will find

| state | node processes |
|---|---|
| before anyone logs in | **0** — the node is down until logon |
| logged in | **2** — the session 1 daemon and the spine it supervises |

In Task Manager none of these is called "egpt". Node shows as *Node.js
JavaScript Runtime* and nssm as *The non-sucking service manager* — both labels
come from the executables themselves, so no name eGPT sets changes them. The
**Details** tab is the reliable view: add the **Session ID** and **Command line**
columns, and `egpt-spine.mjs` versus `egpt-daemon.mjs`, 0 versus 1, tell you
which is which. `Beeper.exe` always shows as *Beeper*; what carries the role is
the service hosting it.


## One Beeper install per account

Identity lives entirely in `--user-data-dir`: different directory = different
install = different device = different token. Same directory twice and the
second launch loses Chromium's singleton and exits (`process_singleton_win.cc`,
`Lock file can not be created! Error code: 32` — a sharing violation, across
sessions and users too). Not harmless: on 2026-09-07 a loser still reached
`os_crypt` and re-keyed the profile's `Local State` before it quit, so the
lockfile is a backstop, never the thing that keeps two instances apart. So the installs cannot be merged the way the spines can: a token
belongs to an install.

Run every one of them in session 0 as an nssm service, LocalSystem, **Auto** —
or as the desktop user (`setup\beeper-services-run-as-user.cmd`, `-Revert`), but
only a service with its own `--user-data-dir`: one without would open that user's
own window profile, a second instance of one device, so the script refuses it.

**Auto, not Manual.** A service that inherits `Manual` from whatever it was
renamed from leaves the node half-alive after a reboot: the spine up, one
account deaf, nothing announcing it.

Session 0 is enough for all of them. **Session isolation isolates the desktop,
not a loopback socket** — measured on 2026-09-06, a real Chrome and two
`Beeper.exe` were serving CDP from session 0. A session 1 Beeper buys visibility
to you, not reachability for the spine. (The Beepers serve no CDP since 2026-10-11.)


## One node, one runner

Since 2026-10-17 each node runs from **one** loop, in session 1: a spine there can
**spawn and supervise a browser as an ordinary child process**, and a session 0
browser is invisible to you. The S0→S1 handover (`/standdown`, exit 45) is gone.

Two spines on one `EGPT_HOME` would open two connections per token (every message
ingested twice, answered twice), race `config/conversations.yaml` and
`state/ingest/`, and collide on the console port (23475 by default). So a daemon
refuses to start while `state/spine.pid` names a live process with a fresh
`state/alive.txt` beat, and says which pid.


## The config shape

```yaml
beeper:
  primary:                        # the EAR — your account
    account: email@domain.com
    token: bdapi_...
  secondary:                      # the MOUTH — omit it on a one-number node
    account: email.second@domain.com
    token: bdapi_...
```

**The role names are load-bearing.** The spine resolves the ear from the key
`primary` and the mouth from the key `secondary` (`src/spine/boot.mjs`), and each
Beeper service carries the same word, so config and services name one thing
once.
With no `secondary` block, `primary` is both ear and mouth: the one-number shape.

`primary_gui` may also be declared, for your own logged-in Beeper window. It is
**never** an ear — ingesting a second install of an account another connection
already is would hear every message twice.

**Or one profile for both (optional).** `setup\share-beeper-primary-profile.cmd`
points `egpt-beeper-primary` at your own window's profile: one device, one token,
no `primary_gui`. The window runs it while Beeper is open; the service runs it
otherwise; never both. `setup\beeper-window.cmd` (logon, and the "Beeper (eGPT)"
shortcut) stops the service before opening Beeper and starts it when Beeper
exits; the service's NSSM Start/Pre hook refuses to start it while the window
claims or runs the profile; `egpt-s0-identity` (SYSTEM) starts it after a
logoff. So `egpt-beeper-primary` is **Stopped while your Beeper is open** — that
is the shape, not a fault.

One bridge is opened per distinct token.

**No Beeper port.** Beeper takes the first free port from 23373, so the number
follows start order, not identity. The spine probes the loopback range with the
token, takes the install answering 200, and re-probes on every reconnect. A
token answers 200 on its own install and 401 everywhere else, which is what
makes the probe unambiguous. `base_url` skips that discovery — only for a
genuinely non-local Beeper.

**One profile.** A node supervises one `EGPT_HOME`. Every account lives in that
one profile, so there is no second profile to carry.


## Checklist

Run it before saying yes.

1. One Beeper service per account, named for its role (`egpt-beeper-primary`,
   `egpt-beeper-secondary`), **Running** and **Auto** (a primary that shares your
   window's profile is Stopped while that window is open)
2. One `egpt-daemon` logon task, and no running `egpt-daemon` service
3. Exactly **one** spine live — two live is the failure, not the goal
4. One `config.yaml`, one block per account under `primary` / `secondary`,
   `account` + `token` — **no Beeper ports**. The console port IS pinned, and
   must be: Beeper claims the first free port upward from 23373 and will take an
   unpinned console the moment a spine releases it.
5. The spine logs `connection '<name>' → ... 200` for every connection, and
   `subscribed to all chats`
6. The ear wakes the spine, and a reply goes out on a connection that can
   actually reach that chat — the mouth where it can, the ear where it cannot.
   The secondary also hears, but only in a chat the primary is not in; in every
   chat they share it stays silent, and that is not a fault to chase.
7. Handles disjoint between accounts, and no other node claiming them
8. **It survives a reboot** — services come back, discovery finds the installs
   cold, the spine subscribes untouched once the operator logs on (the task's only
   trigger; `egpt-wake-duty` runs only while logged on too)


## What is deployed today

As of 2026-09-16, `kg` and `do` are each one spine holding two accounts, and
**they match on everything this document names** (2026-10-17: the `egpt-daemon`
service is stopped and Disabled on both):

| | `kg` | `do` |
|---|---|---|
| `egpt-daemon` service | Running · Auto · labelled | Running · Auto · labelled |
| `egpt-daemon` task | at logon · described | at logon · described |
| `egpt-beeper-primary` | Running · Auto · the ear | Running · Auto · the ear |
| `egpt-beeper-secondary` | Running · Auto · the mouth | Running · Auto · the mouth |

They got there by **migrations** (`migrations/0001`–`0005`), not by hand: each
change is written once in the repo, `setup/upgrade.ps1` applies whatever is
pending after every deploy, and each node records what it has applied in
`state/migrations-applied.json`. `do`'s Beeper services and both nodes' session 1
task carried legacy names until then. A change to either node that is not a
migration is how the two drift apart again.

What still differs, measured, and why it is not being changed:

- **`kg`'s primary Beeper has no `--user-data-dir`.** It runs from the LocalSystem
  profile, where `do`'s lives in `~/.egpt/state/an-beeper`. By this document's own
  rule the data folder IS the install's identity, so this is a real difference —
  but converging it means moving a live, logged-in install's data, which risks
  re-linking that account.
- **`do`'s `egpt-daemon` service is an older install**: its binary sits inside
  the profile and it logs under a different name. Converging it is a reinstall,
  and the service runs as `.\an`, so a reinstall needs that account's password at
  a real console.
- **The helper tasks differ by purpose, not by drift.** `kg` has `egpt-chrome-radio`
  and an enabled `egpt-wake-duty`; `do` has a disabled `egpt-lock-on-logon` and a
  disabled `egpt-wake-duty`.

`~/.egpt-secondary` on `kg` was a second profile running a second spine. It was
never a second node — there is no "kg2". It was retired on 2026-09-15 behind a
`STOP` file, which boot honours and `setup/upgrade.ps1` refuses on, with its
conversations kept on disk.


## Mirroring to another machine

Same accounts, same install shape, same config shape. What differs:

- `node_name` and the persona
- Each account needs its OWN enrolled device on the new machine. Enroll it,
  don't copy — a copied `user-data-dir` moves the device, so two machines on
  one copy is two clients claiming one device id.
- Handles disjoint across nodes. That, not `owner_node`, is what keeps one
  mention from waking two machines: agent names differ per node, so each node
  answers only to its own (operator 2026-09-13).
- **Disarm any relay handle both machines answer to before waking the second
  one**, or one mention wakes both nodes and the group gets two answers from two
  accounts.
