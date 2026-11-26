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

### Telegram (with or without a number)

A Telegram bot is **both ear and mouth** for every group and topic it is in. It
needs no phone number and no Beeper: one token, one HTTPS long-poll
(`getUpdates`), nothing inbound. Beeper and WhatsApp are optional.

```yaml
limbs:
  telegram:
    main:                         # one bot per node for now (the first block is used)
      account: "my_egpt_bot"      # the bot's username (a label)
```

The token is not in `config.yaml`: it is `secrets/telegram-<name>.token`
(`node setup/telegram-token.mjs main`). Who may command it is
`networks.telegram.allowed_users` (Telegram numeric ids). Its chats are
`tg:<chat id>`, and a forum topic is a chat of its own, `tg:<chat id>/<thread id>`.

How it combines with the numbers above:

- **Zero numbers + a Telegram bot** is a valid node: no Beeper, the bot hears and
  answers (comment out `limbs.beeper`).
- **One or two numbers**: Telegram is just another network. The `tg:` chats belong
  to the bot, the Beeper chats to `primary` / `secondary`; the ear/mouth rule inside
  each is unchanged. The bot never receives its own posts, so a being's line that
  names a handle is fed back to the spine as the echo Beeper would deliver.


## Linux: one system user per person

A shape for public surfaces (a website chatbox) on a Linux node: each person who
writes gets their own Linux user, and their home is their conversation. (Target
shape; the pieces marked (planned) are not in the code yet.)

- **Name:** `<org>.<user>`, lowercase, Linux-valid (`acme.jdoe`). The display title
  of the conversation (`acme-W-jdoe-<Name>`) is separate; it never names the folder.
- **Home = conversation:** `/home/<user>` IS that person's conversation folder.
- **Persistent `/home`:** mounted from a data volume, so homes survive restarts and
  image changes. `passwd` / `group` entries are recreated at container start from
  a persistent map (planned); the image holds no users.
- **Where egpt looks:** `conversations/<chatbox>` is a symlink to `/home`, so the
  conversations are found where egpt expects them.
- **Writing:** the egpt daemon writes into those homes through a shared group or
  ACLs (each home keeps its owner; the daemon is not root).
- **Hook (planned):** before dispatching a line, run a configured command for that
  conversation, e.g. to refresh that person's credentials. The core runs the command
  and nothing else; no domain logic lives in it.

**Today's sandbox** (`setup/SANDBOX.md`, "Linux") is a different shape: one
numbered uid per conversation folder (`egpt-box-N`, from 200000, in
`state/box-users.tsv`), no `/etc/passwd` entry, a scratch home
`/home/egpt-box-N`, the folder mounted in. This section is the target for the
public surfaces: a named, persistent user whose real home is the conversation.
It needs the persistent map and the hook above, and the box launcher's rule
("target is `conversations/<surface>/<slug>`") to accept the symlinked layout.


## What runs on a node

One egpt per session type, so **nothing carries a session in its name**. Beeper
is named for its **role** — the same word as its config key:

| name | kind | job |
|---|---|---|
| `egpt-daemon` | Windows service (nssm, Auto, as you) | runs the node in **session 0** while nobody is logged in; holds off (no spine) while session 1 has it |
| `egpt-daemon` | scheduled task (at logon) | runs the node in **session 1** while you are logged in — the browsers live here |
| `egpt-beeper-primary` | Windows service (nssm, Auto) | Beeper for the primary account — the ear |
| `egpt-beeper-secondary` | Windows service (nssm, Auto) | Beeper for the secondary account — the mouth; two-number nodes only |

The service and the task share a name (the SCM and Task Scheduler are separate namespaces).
`setup\install-nssm-service.cmd` installs the service, at the console: it asks your password
(checked, never stored) and lets you stop and start it unelevated.

**Never an account name in a service name.** The role is what the spine reads,
so `egpt-beeper-primary` is the install behind `beeper.primary` on every node,
whichever human's number that is. And the `egpt-beeper-` prefix says what
stopping it costs: an ACCOUNT goes offline, not a spine — which matters most
during an incident, exactly when the services list gets read.

### The processes you will find

| state | node processes |
|---|---|
| before anyone logs in | **2** — the session 0 daemon and its spine |
| logged in | **3** — the session 1 daemon and its spine, and the session 0 daemon holding off |

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


## One node, one runner at a time

Since 2026-10-22 (GENOME 6) a node is never deaf for want of a login. The `egpt-daemon`
**service** runs the node in session 0 while nobody is logged in. At logon the `egpt-daemon`
**task** starts the session 1 daemon: it takes `state/s1.claim` and drops `/standdown` into
`state/ingest`; the session 0 spine finishes its turns in flight (new messages are still
answered), ends its background work — each being says so once where it ran — and leaves
with 45; the session 0 daemon holds off, and the session 1 daemon spawns the spine, whose
browsers need the desktop. At logoff Windows ends session 1, the OS drops `s1.claim`, and
the session 0 daemon takes the node back within seconds. Locking does not hand back.
`/upgrade full` in session 1 ends the daemon with 46 and the task's launcher runs it again;
the leaving daemon writes `state/s1.renewing` while it still holds `s1.claim`, and the
session 0 daemon holds off while that is under a minute old.

Two spines on one `EGPT_HOME` would open two connections per token (every message
ingested twice, answered twice), race `config/conversations.yaml` and
`state/ingest/`, and collide on the console port (23475 by default). So before
EVERY spawn a daemon must hold `state/runner.lock` and find no live spine
(`state/spine.pid` + a fresh `state/alive.txt` beat); a session 0 daemon also
waits while `state/s1.claim` is held. Both files are share-none opens the OS drops
with the process (`src/daemon-singleton.mjs`), so a logoff, a crash or `taskkill /F`
frees them. A daemon that may not spawn waits and says why; it never exits for it.

Session 0 has no browser: a browser request there is told it is available once
someone logs in. The claude sessions are held by the daemon in both sessions; a
handover ends them, and threads resume by id on the next turn.


## The config shape

```yaml
limbs:                            # the I/O transports; an http limb will sit beside beeper
  beeper:
    primary:                      # the EAR — your account
      account: email@domain.com
      token: bdapi_...
    secondary:                    # the MOUTH — omit it on a one-number node
      account: email.second@domain.com
      token: bdapi_...
```

A top-level `beeper:` (before migration 0049) is still read, with one
deprecation line per boot; 0049 copies it under `limbs:`, comments included, and
leaves the old block as a DEPRECATED copy for older code, ignored once
`limbs.beeper` is set.

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
otherwise; never both. The egpt daemon supervises it: in Session 1, every 15 s
its pass (`setup\beeper-window.ps1 -Once`) stops the service before opening
Beeper and reopens Beeper whenever it exits, until you log off; in Session 0,
every 60 s (`s0-identity-reconcile.ps1 -BeeperOnly`) it starts a stopped Beeper
service, the primary only once Session 1 lets go. The "Beeper (eGPT)" shortcut
defers to it. The service's NSSM Start/Pre hook refuses to start it while the
window claims or runs the profile; `egpt-s0-identity` (as you, S4U) is the
backstop while no Session 0 daemon is live. So `egpt-beeper-primary` is
**Stopped while your Beeper is open** — that is the shape, not a fault.

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
2. One `egpt-daemon` logon task, and one `egpt-daemon` service: Automatic, as you,
   AppExit 0 = Exit, and you may stop and start it (`node setup\verify-install.mjs`)
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
   cold, and the session 0 spine subscribes untouched before anyone logs on; at logon
   the session 1 daemon takes over, and at logoff the service takes the node back
   (`egpt-wake-duty` still runs only while logged on)


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
change is written once in the repo, every node applies whatever is pending
whenever it upgrades (the daemon's `/upgrade`, manual or auto, plain or full,
container nodes included; `setup/upgrade.ps1` runs it again on Windows), and
each node records what it has applied in `state/migrations-applied.json`. A
failed one stops the chain and is reported on the back-up line; the new code
still starts. `do`'s Beeper services and both nodes' session 1
task carried legacy names until then. A change to either node that is not a
migration is how the two drift apart again.

**Migrations that ask.** Most migrations are tied to the code and just run. One
that changes the operator's own config or node policy (which beings exist, their
model, mode and access, grants, compaction ratios, the admin channel) declares
`approval = true`: an upgrade reports it as PENDING APPROVAL (runner exit 3; on
the daemon path, one line per migration on the back-up message, with its summary
and the commands) and does not apply or record it. The node answers with
`/<handle> migrate approve <id>` or `/<handle> migrate decline <id>` (operator
only; bare `/<handle> migrate` lists pending, approved, declined), or on a shell
`node setup/migrate.mjs --approve <id>` / `--decline <id>`. Approve applies it
and records it; decline records `declined` (time, by operator), and it is never
proposed again. Only a migration that asks can be declined: a code-shape one
cannot, because the code depends on it. A migration that does not apply to a node
is not declined: it is left unapproved, and once the ledger records a newer
migration as applied (applied, approved or already satisfied) it is QUIET: the
runner marks it `PENDING APPROVAL (quiet: newer applied)` and exits 0 for it, the
back-up message does not post it, and bare `/<handle> migrate` still lists it,
marked quiet. Quiet is derived from the ledger on every run, never stored, and
approve or decline still work on a quiet one.

What still differs, measured, and why it is not being changed:

- **`kg`'s primary Beeper has no `--user-data-dir`.** It runs from the LocalSystem
  profile, where `do`'s lives in `~/.egpt/state/an-beeper`. By this document's own
  rule the data folder IS the install's identity, so this is a real difference —
  but converging it means moving a live, logged-in install's data, which risks
  re-linking that account.
- **`do`'s `egpt-daemon` service is an older install**: its binary sits inside
  the profile and it logs under a different name. Converging it is a reinstall,
  and the service runs as `.\user`, so a reinstall needs that account's password at
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
