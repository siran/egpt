# What eGPT is for

The properties we keep choosing. `NODE-SHAPE.md` says what a node looks like;
this says why it looks like that, so a future change can be judged against
something.

---

## An agent that lives where you already talk

Not a window you visit. eGPT lives inside the messaging accounts you already
use, so a being is reachable the same way a person is — by name, in the group
where the thing is being discussed, from a phone, without opening anything.

That is the whole reason the hard parts are hard. A chat window would need none
of this.

## It speaks as itself

An agent answering from the operator's own number reads as the operator talking
to himself. So a being gets a second account and a second number, and the group
sees an agent, not a ventriloquist act.

This is the axis most of the work has been on: two accounts, which mouth speaks,
which handle wakes whom, and how one real group appears as two chats. The cost is
real and it is worth paying, because the alternative is an agent that cannot be
addressed as a separate party.

**Identity is the phone number, not the login.** A Beeper account is a way in; it
is not who you are. That is why renaming an account buys nothing, and why a
second face costs a number rather than a config line.

## It is always on

Unattended. Session 0 services, automatic start, survives logoff and reboot with
nobody touching anything. A node that only works while you are logged in is a
demo.

The corollary is that **half-alive is worse than down**: a spine up with one
account deaf, and nothing announcing it, is the failure mode to design against.
It has happened more than once and each time the cause was something written down
that had quietly stopped being true.

## It is confined by the kernel, not by good behaviour

A being runs as a throwaway Windows account with no rights to anything but its
own conversation folder. No virtualization. The boundary is an ACL, enforced
whether or not the agent cooperates.

One boundary, the one that is actually enforced. Where the kernel holds the line
we do not also constrain the agent inside its own process — that is friction
without safety.

The operator is the exception, deliberately: exactly one being runs unsandboxed,
as the human, and it is the one whose job is to change the machine.

## The config describes reality

Two rules, both learned the hard way:

**Do not write down what can be discovered.** A pinned port is a fact that was
true when you typed it. Beeper takes the first free port, so the number follows
start order — and a config that recorded one left a node deaf for ninety minutes
with no error naming the cause. Ask the token instead.

**A comment is a claim, not a fact.** Notes in this repo have asserted that
Session 0 cannot run a browser, that a tool did not exist, and that a presence
check would discriminate — all confidently, all wrong, all believed for a while
because they were written down. Measure before repeating.

## It scales down before it scales out

The baseline is one Beeper account, one token, one node, in your ordinary desktop
session. Everything else is an enhancement:

| | |
|---|---|
| no number | the shell, and access to a model |
| one number | agents answer from your own account |
| two or more | agents answer as themselves |
| a second machine | the same accounts, a different persona, its own devices |

A fresh clone must work at the baseline on any OS. Windows-shaped machinery —
services, ACLs, sessions — belongs in `setup/`, never in `src/`, and a node that
stops at the baseline is not a broken node.

## One mind, many mouths

A being is one identity with one memory, reachable through whichever account
suits the room. Not one agent per account, not one process per number. Accounts
are connections; a number is a config block, not a spine.

The same instinct decides most open questions: **collect the multiplicity into
one holder, and let configuration choose.** It is why several accounts became one
spine's connections, and it is the test to apply to the next thing that starts
sprouting copies.

---

## How we work

Small chunks, each verified before the next. A bugfix starts with a test that
fails for the real reason. Nothing is called done because it passed tests — done
means it ran.

The habit that has caught the most: **re-check after the change, not before.**
Config validators, success messages and one's own reasoning have all reported
success over a change that did not land.
