# egpt-vault — secrets out of the filesystem, without an encrypted repo

**Status:** design — nothing implemented. Chunked to be dispatchable; every chunk
carries its own verification.

---

## The idea

Secrets stop living as files on the machines that use them. They live in
**Bitwarden Secrets Manager**, and each machine fetches what it needs at
provision/start time with a scoped, revocable token.

This replaces an earlier sketch — a private git repo, encrypted with SOPS+age —
and it is better for one reason that decided it: **the age key is
all-or-nothing and cannot be revoked.** If dolly is compromised you re-encrypt
everything, everywhere. A Secrets Manager token is scoped to a project, is
individually revocable, and can carry an expiry.

The second reason is the operator's own: *"if i am out and about, how do i check
the value of the encrypted key?"* With SOPS, you do not — there is no usable
mobile client. Bitwarden already has one, and he already uses it.

## What is being solved, precisely

Not "encrypt the vault." Today, on dolly, these exist **only on that disk**,
gitignored, with no backup:

| | |
|---|---|
| secrets | `CREDENTIALS.md`, `admins.caddy` and the other `.caddy` credential files |
| station config | `icecast.xml` — ignored because it holds passwords |

And on both nodes, `~/.egpt*/config/config.yaml` carries live Beeper API tokens
and shell tokens in plaintext. Those are not in git, but reve's profile is
backed up to Google Drive by FreeFileSync, so **the tokens are already on Drive.**
That is worth knowing before deciding what a migration is worth: it is not
"secrets are safe today and we are hardening", it is "secrets are on a consumer
cloud drive and one un-backed-up disk".

## The account facts, verified 2026-09-06

- Secrets Manager is **organization-scoped**; activating it needs an org admin.
  The operator **is** an organization, so this is a toggle, not a signup.
- Free tier: **unlimited secrets, 2 users, 3 projects, 3 machine accounts.**
- Machine accounts are scoped **per project**, with **Can read** or
  **Can read, write**.
- Access tokens are **individually revocable**, support an **expiry** (default
  Never), and are supplied via `BWS_ACCESS_TOKEN`.
- **A token is displayed once and is never retrievable** — "never stored in
  Bitwarden databases". This shapes the setup order: capture at creation or
  redo it.
- CLI is `bws` (Secrets Manager), distinct from `bw` (the personal vault).

Three projects and three machine accounts is not generous, and the allocation
below spends them deliberately.

## Allocation

Projects by **system**, not by machine — secrets belong to a system, machines
come and go:

| project | holds |
|---|---|
| `egpt` | Beeper API tokens and shell tokens, both nodes |
| `radio` | icecast source/admin, the `.caddy` credential sets |
| *(spare)* | unspent on purpose — the free tier gives three and there is no way to buy a fourth without paying |

Machine accounts by **machine**, each read-only on what it needs:

| machine account | projects | permission |
|---|---|---|
| `reve` | `egpt` | Can read |
| `dolly` | `egpt`, `radio` | Can read |
| *(spare)* | — | — |

Read-only is the default and should stay it: nothing on either box has a reason
to write a secret back, and read-only means a stolen token cannot poison the
vault for the other machine.

## Naming

Secrets are flat key/value. Impose a path convention or it degenerates:

```
egpt/kg/beeper/main/token
egpt/kg/shell/token
egpt/kg2/beeper/main/token
radio/icecast/source_password
radio/caddy/admins
```

## What CANNOT go in, and what to do instead

Two secrets on dolly are not copyable at all:

- **`svc-radio`'s password** exists only as an LSA secret. Nobody holds it, and
  `HOWTO.md` already records the rule: never delete or recreate those services,
  never change `ObjectName` — that is one-way.
- **The sandbox pool credentials** are DPAPI-sealed to one machine and one user.

Neither can be stored, so the vault records **how to recreate them**, not their
values. That is a procedure, contains no secret, and therefore belongs in the
ordinary repo — `docs/recreate/` — not in Secrets Manager. This is the part
actually needed during a rebuild at 3am.

## Whole files: template, do not store

`icecast.xml` is a config file that happens to contain passwords. Storing the
whole file as a secret value works and is wrong: it stops being diffable and
every unrelated edit becomes a vault write.

Instead: **`icecast.xml.template` in the normal repo with placeholders, values
from `bws`, rendered at deploy.** The template becomes reviewable, the secrets
never touch git, and the diff of a config change is a config change. Same for
the `.caddy` sets.

## The bootstrap, stated rather than glossed

Every design has one secret that unlocks the rest. Here it is
`BWS_ACCESS_TOKEN`, and it must be on the machine before the machine can fetch
anything.

For a service, it goes where `EGPT_HOME` already goes — the NSSM service
environment (`AppEnvironmentExtra`), readable by administrators only. That is
the same trust boundary the service already has, so it adds no new exposure.
**It is not an improvement to hide it more cleverly**; it is an improvement that
it is now scoped, revocable, and expiring, which a plaintext `config.yaml` token
never was.

## Chunks

**Chunk 1 — provision.** Activate Secrets Manager in the existing org. Create
the two projects and the two machine accounts with read-only grants. Capture
each token AT CREATION (they are unretrievable) straight into the operator's
personal Bitwarden vault.
*Verify:* `bws project list` from each machine returns exactly its own projects
and no others. A deliberate cross-project read fails.

**Chunk 2 — inventory before migration.** Enumerate every secret across both
machines: what it is, where it lives, what reads it, whether it is rotatable.
NAMES AND LOCATIONS ONLY — this document and its output never carry values.
*Verify:* every gitignored credential file on dolly appears in the inventory,
and every `token:` key in both `config.yaml` files is accounted for.

**Chunk 3 — the tooling.** A thin wrapper over `bws` in `src/tools/vault/`:
fetch by key, render a template, and a preflight that says plainly whether
`BWS_ACCESS_TOKEN` is present and valid. Double-clickable `.cmd` per house rule.
*Verify:* unit tests against a faked `bws`; the preflight distinguishes missing
token, expired token, and wrong project, and says which.

**Chunk 4 — radio first.** It is the lower-stakes system and its secrets are
already file-shaped. Template `icecast.xml` and the `.caddy` sets, render at
deploy, and confirm the station comes up.
*Verify:* a render on dolly reproduces the CURRENT files byte-for-byte before
anything is deleted. That equality is the whole test.

**Chunk 5 — egpt.** Beeper and shell tokens. Trickier, because `config.yaml` is
read at boot by a running spine. Render it at service start, or teach
`boot.mjs` to resolve a `bws:` reference — the first is smaller and touches no
`src/`, so prefer it unless it proves impossible.
*Verify:* a node with NO vault configured behaves exactly as today. That must be
locked by a test, as everything else in this repo's optional layers is.

**Chunk 6 — rotate, then delete.** Migration alone achieves little: the old
values remain on Drive and in backups. Rotate every secret that is cheap to
rotate (Beeper tokens are per-install and regenerable), THEN remove the
plaintext.
*Verify:* the station and both spines run on rotated values; the old ones are
confirmed dead rather than merely unused.

## Risks

- **The token is shown once.** A fumbled Chunk 1 means deleting and recreating
  the machine account. Cheap, but do it deliberately.
- **Three projects is the ceiling.** Spending the spare on something ad hoc now
  means paying later. Leave it.
- **`bws` becomes a boot dependency for the radio and possibly the spines.** If
  Bitwarden is unreachable at start, what happens? Rendering at deploy (not at
  every start) keeps the failure at deploy time, where a human is watching.
  Decide this before Chunk 4, not after.
- **Migration without rotation is theatre.** Chunk 6 is not optional cleanup; it
  is the chunk that makes the others worth doing.

## Not in scope, but adjacent and unowned

`posts/` (1.7M, untracked) and `messages/` on dolly are **content, not secrets**,
and are equally unbacked-up. A vault does nothing for them. They need an
ordinary home, and dolly needs a backup story at all — reve has FreeFileSync to
Drive, dolly appears to have nothing.

## Open questions for the operator

1. **Projects by system (`egpt`, `radio`) or by machine (`reve`, `dolly`)?**
   Proposed: by system, above.
2. **Render at deploy, or resolve at start?** See the boot-dependency risk.
3. **Does the spare project/machine account stay spare?**
4. **Is the personal vault getting tidied first?** The operator said it needs
   cleaning; a tidy vault makes the machine-account tokens findable later, which
   is exactly when it will matter.
