# The shape of a node

What a finished eGPT node looks like, so "is it done yet" has an answer you can
check instead of a judgement you have to make. Written 2026-09-07 from reve (kg),
which reached this shape first; dolly (do) is meant to be a copy of it.

The baseline this refines is still the one in `README.md`: **one Beeper account,
one token, one node, in your ordinary desktop session.** Everything below is an
enhancement for a machine that runs unattended and wears a second face. A node
that stops at the baseline is not a broken node.

---

## The two accounts

Every node runs the SAME two Beeper accounts. This is the part that took longest
to see, so it is first:

| role | account | what it is |
|---|---|---|
| **primary** | `anrodz42@gmail.com` | An. The operator. The real human. |
| **secondary** | `dolly.egpt@gmail.com` | Rodz. The mouth the agents speak through. |

Both accounts, on both machines. **Configuration decides who answers** — `ken` on
kg, `don` on do — not which account is logged in where. Both accounts see every
message either of them is in; the handle is the discriminator, and handles must be
disjoint across every spine or one mention wakes two of them (live bug,
`router.mjs`: *"both spines answered ONE @egpt, kg stamped egpt, DOLLY stamped
don"*).

The secondary account's name is historical. `dolly.egpt` is not dolly's; it is the
mouth's, on every node. Renaming it costs a WhatsApp re-link and buys nothing —
the identity that matters is the phone number, not the login.

## Three Beeper installs per machine

A Beeper identity lives entirely in its `--user-data-dir`. Different directory =
different install = different device = different token. Same directory = the
second launch loses Chromium's singleton and exits (`process_singleton_win.cc`,
`Lock file can not be created! Error code: 32` — a sharing violation, not damage).

| install | service | account | why |
|---|---|---|---|
| `s0-primary` | `egpt-primary` (nssm, LocalSystem, **Auto**) | An | survives logoff and reboot |
| `s0-secondary` | `egpt-secondary` (nssm, LocalSystem, **Auto**) | Rodz | the mouth, also unattended |
| `s1-an` | the ordinary Session 1 GUI | An | the operator's own window; what a browser and a desktop need |

**Both services must be Auto.** `egpt-secondary` inherited `Manual` from the
service it was renamed from, which would have left the node half-alive after a
reboot: kg talking, kg2 silent, nothing announcing it.

Display names are Beeper's own plus the role — `Beeper Desktop-s0-primary`,
`Beeper Desktop-s0-secondary`.

## Two spines per machine

`egpt-daemon` and `egpt2-daemon` run the **identical command** —
`node egpt-daemon.mjs` from `~/bin/egpt` — and differ ONLY in `EGPT_HOME`
(`~/.egpt` vs `~/.egpt2`). Not versions. Not different code. One deploy, nothing
to keep in sync. If something is wrong with one it is wrong with both, and the
profile is the entire distinction between "An" and "the mouth".

## The config shape

```yaml
beeper:
  use: main
  main:
    account: anrodz42@gmail.com
    token: bdapi_...
```

**No port. Ever.** Beeper binds the first free port from 23373, so the number
follows START ORDER, not identity — with three installs on one machine the ports
reshuffled three times in one evening. The spine probes the loopback range with
the token and takes the install that answers 200; a token belongs to an INSTALL,
so exactly one can. It asks again on every reconnect, so an install that moves is
followed rather than knocked on forever.

`base_url` still works and skips discovery. Use it only for a genuinely non-local
Beeper. `endpoints:` is deprecated — it was an interim workaround that repeated
one token across four ports, which is the config admitting the code could not find
its own API.

## Checklist

A node is in shape when all of these are true. Run it before saying yes.

1. `egpt-primary` and `egpt-secondary` both **Running** and **Auto**
2. `egpt-daemon` and `egpt2-daemon` both Running, descriptions naming the profile
3. Both configs are `account` + `token`, no ports, no `endpoints:`
4. Both spines log `connection 'main' → ... 200` and `subscribed to all chats`
5. The two nodes' handles are disjoint, and no other node claims them
6. **It survives a reboot** — services come back, discovery finds the installs
   cold, both spines subscribe without a human touching anything

## Known-not-done on reve, 2026-09-07

- **6 is unproven.** Nothing has been through a restart. Auto-start,
  cold-boot discovery and the S0→S1 flip are all configured, none exercised.
- **Reactions come from the wrong account.** The 👀 that marks new input to the
  model still posts from whichever bridge ingested the message — An's — while the
  reply comes from Rodz. The read receipt and the answer disagree.
- **The S0→S1 flip has never run.** See the handover plan; `s1-an` exists and is
  addressable, but no logon has ever handed the profile over.

## Mirroring to dolly

Same two accounts, same two service names, same config shape. What differs:

- `node_name` (`do` / `do2`) and the persona (`don`, not `ken`)
- Each account needs its OWN enrolled device on dolly. Enroll it, do not copy a
  profile — a copied `user-data-dir` moves the device, so two machines running one
  copy is two clients claiming one device id.
- **Disarm dolly's `e` relay before waking it.** `config.yaml` already warns: one
  `@e` would wake both nodes and the group gets two answers from two accounts.
