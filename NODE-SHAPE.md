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

One egpt per session type, so **nothing carries a session in its name**, and
Beeper is named after the **account**, never after its role:

| name | kind | job |
|---|---|---|
| `egpt-daemon` | Windows service (nssm, Auto) | keeps the node loop alive in **session 0** |
| `egpt-daemon` | scheduled task (at logon) | keeps the node loop alive in **session 1** |
| `egpt-beeper-an` | Windows service (nssm, Auto) | Beeper for account `an` |
| `egpt-beeper-rodz` | Windows service (nssm, Auto) | Beeper for account `rodz` — two-number nodes only |

The service and the task share `egpt-daemon`: Windows keeps services and
scheduled tasks in separate namespaces, and there is only one of each.

**No `-primary` / `-secondary` in any service name.** Stopping a Beeper service
takes an ACCOUNT offline, not a spine, and a name that hides that is worst
during an incident — which is exactly when the services list gets read.

### The processes you will find

| state | node processes |
|---|---|
| before anyone logs in | **2** — the session 0 daemon, and the spine it supervises |
| logged in | **3** — the session 1 daemon and its spine doing the work, plus the session 0 daemon, stood down, waiting |

The third one is on purpose. At logoff session 1 dies with everything in it, and
the stood-down session 0 daemon is the only thing that brings the spine back.
nssm cannot do that job alone: it restarts a process that EXITS, and has no way
to know whether session 1 is holding the spine.

In Task Manager none of these is called "egpt". Node shows as *Node.js
JavaScript Runtime* and nssm as *The non-sucking service manager* — both labels
come from the executables themselves, so no name eGPT sets changes them. The
**Details** tab is the reliable view: add the **Session ID** and **Command line**
columns, and `egpt-spine.mjs` versus `egpt-daemon.mjs`, 0 versus 1, tell you
which is which. `Beeper.exe` always shows as *Beeper*; what is named after the
account is the service hosting it.


## One Beeper install per account

Identity lives entirely in `--user-data-dir`: different directory = different
install = different device = different token. Same directory twice and the
second launch loses Chromium's singleton and exits (`process_singleton_win.cc`,
`Lock file can not be created! Error code: 32` — a sharing violation, not
damage). So the installs cannot be merged the way the spines can: a token
belongs to an install.

Run every one of them in session 0 as an nssm service, LocalSystem, **Auto**.

**Auto, not Manual.** A service that inherits `Manual` from whatever it was
renamed from leaves the node half-alive after a reboot: the spine up, one
account deaf, nothing announcing it.

Session 0 is enough for all of them. **Session isolation isolates the desktop,
not a loopback socket** — measured on 2026-09-06, a real Chrome and two
`Beeper.exe` were serving CDP from session 0. A session 1 Beeper buys visibility
to you, not reachability for the spine.


## One node, two sessions, one live

The session 0 and session 1 loops are **one node in two sessions**, not two
nodes. Same config, same `EGPT_HOME`, same tokens — which is why they take turns
instead of coexisting. Both live at once would open two connections per token
(every message ingested twice, answered twice), race
`config/conversations.yaml` and `state/ingest/`, and collide on the console port
(23475 by default).

Session 1 exists for one reason: a spine there can **spawn and supervise a
browser as an ordinary child process**. A session 0 browser is invisible to you
— it cannot be seen, clicked, or shown a login prompt.

**The S0→S1 flip** is the handover. After a restart the spine runs in session 0.
At logon the `egpt-daemon` scheduled task starts the session 1 daemon, whose
spine asks the incumbent for the profile; the incumbent finishes the turn it is
writing and exits (`STANDDOWN_EXIT_CODE = 45`), and its daemon respawns only once
**nothing holds the profile** — `state/spine.pid` names no live process (paired
with a fresh `state/alive.txt` beat) and the console port is quiet. The pid is
the mutex; the port is a second witness, not the answer. Reading the port alone
put two spines on one profile on 2026-09-11: Beeper takes the next free port
from 23373 up, grabbed the console the instant the departing spine released it,
and the arriving spine — alive and holding the profile — could not bind and so
was invisible.

Exercised in the logon direction: kg booted on 2026-09-16 07:25, the session 1
spine took the profile, and the session 0 daemon stood down with no spine child.
The logoff direction — session 1 dying and session 0 taking back over — is not
yet exercised; see `plans/2609061200-SESSION-0-TO-1-HANDOVER-PLAN.md`.


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

**Here the role names are load-bearing.** The spine resolves the ear from the key
`primary` and the mouth from the key `secondary` (`src/spine/boot.mjs`), so in
config — unlike in service names — these words are not labels you can change.
With no `secondary` block, `primary` is both ear and mouth: the one-number shape.

`primary_gui` may also be declared, for your own logged-in Beeper window. It is
**never** an ear — ingesting a second install of an account another connection
already is would hear every message twice.

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

1. One Beeper service per account, named after the account, **Running** and
   **Auto**
2. One `egpt-daemon` Windows service (Auto) and one `egpt-daemon` logon task
3. Exactly **one** spine live, in whichever session — two live is the failure,
   not the goal
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
   cold, the spine subscribes untouched


## What is deployed today

As of 2026-09-16, `kg` and `do` are each one spine holding two accounts. They are
converging on the names above and are **not there yet**:

| | Beeper services | session 1 task |
|---|---|---|
| `kg` | `egpt-beeper-primary`, `egpt-beeper-secondary` | `egpt-session1-daemon` |
| `do` | `egpt-primary`, `BeeperRodz` | `egpt-session1-daemon` |

Both still carry role or legacy names. The rename is being delivered as a
migration applied to each node, so the two cannot drift again by hand.

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
