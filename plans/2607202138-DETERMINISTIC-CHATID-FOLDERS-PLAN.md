# DETERMINISTIC CHAT-ID-KEYED CONVERSATION FOLDERS — design proposal

**What:** make a conversation's on-disk directory a **pure function of its Beeper
chat id**, so `chatId → path` falls out with no stateful resolver. `conversations.yaml`
becomes keyed by the chat id; the human name demotes to a `# comment` (legibility
without coupling); each entry carries `thread_id` + `path`; renames are *recorded*,
never *moved*.

**Decision (operator, 2026-07-20):** "resolution should be deterministic based on
Beeper's chat id — then the path falls out." This proposal captures that. It is
**orthogonal** to the shipped `@e`-transcript feature (which is correct on today's
layout) — but that feature is the concrete case that exposed the friction: the bridge
couldn't resolve `chatId → transcript.md` itself and had to have the stateful resolver
injected. Under this design it wouldn't need one.

---

## 1. Today's layout (the friction)

- The folder is keyed by a **human-readable, mutable slug** — `conversations/<surface>/<slug>/`
  where `slug` is derived from the chat **title** (`contacts.resolve` → `ensureContact({ slugHint: chatName })`, `contacts.mjs:32,40`); examples `diego`, `premise-driven-bitcoin` (`conversations-state.mjs:5`).
- It is **stateful and moves**: a title change (group rename, or a placeholder
  `morgan-2606101622` learning its real name) recomputes the slug and **renames the
  folder** so `transcript.md`/`media/` follow (`contacts.mjs:42-63`, `renameSlugDir`).
  That self-heal is the entire reason `contacts.resolve` exists.
- `conversation_path` IS stored per entry, but the code marks it *"a self-describing
  POINTER, not the resolver"* — resolution runs through `EGPT_HOME/slugDir(surface, slug)`
  (`conversations-state.mjs:109-123`).
- A **`renames.log`** already lives in each folder (`conversations-state.mjs:538`).
- Consequence: `chatId → path` needs the loaded state + the rename logic. Any consumer
  that only holds a chat id (the bridge) must be handed a resolver.

## 2. Proposed layout

```yaml
whatsapp:
  "<chatId>":                 # Diego            ← name is a COMMENT, not the key
    thread_id: <claude session id>
    path: conversations/whatsapp/<chatId>/       ← deterministic, id-derived
    # renames.log lives inside path/ — appended, never acted on
```

- **Key = the chat id** (`shortChatId(chatId)` — `chat-id.mjs`, already "the STABLE id
  used everywhere ids are keys: config, gating, transcripts, mesh"). Immutable.
- **Folder = `slugDir(surface, shortChatId(chatId))`** — a **pure function** of the id.
- **Name = a `# comment`** on the key (browseable legibility) — optionally also a
  `name:` field (see §5, YAML-comment round-tripping is the one wrinkle).
- **Renames = recorded, not moved**: on a title change, append to `renames.log` and
  update the comment/`name`. The folder never moves.

## 3. What this deletes / simplifies

- `contacts.resolve` collapses from a stateful self-heal to `slugDir(surface, shortChatId(chatId))`
  — or disappears at call sites that can compute it inline.
- **Gone:** `renameSlugDir` folder moves, placeholder self-heal, the `ensureContact`
  slug recompute, the "move transcript.md/media on rename" dance (`contacts.mjs:49-63`),
  and `former_names`/re-slug bookkeeping.
- The **`@e` transcript feature drops its `readTranscript` injection** — the bridge
  computes `slugDir(surface, shortChatId(chatId))/transcript.md` directly.
- Every `slugDir(surface, slug)` caller keeps working — the *argument* is now the id
  instead of a name; the function is unchanged.

## 4. Benefits

- **Deterministic path** — the whole point; the path falls out from the id, no state.
- **No resolver coupling** — any component holding a chat id (bridge, a future tool)
  finds the folder without the spine's contact state.
- **No rename machinery** — a large, race-prone subsystem (self-heal, dir-move,
  read-after-rename ordering) is retired. Renames become a log line + a comment edit.
- **Consistency** — conversations join everything else already keyed by `shortChatId`.

## 5. Costs / risks / open questions

- **Migration of existing folders** (~81 conversations): move each `conversations/<surface>/<name-slug>/`
  → `conversations/<surface>/<chatId>/` once, rewrite `conversations.yaml` keys, preserve
  `renames.log`/`media/`/`transcript.md`. One-shot, scripted, idempotent, reversible via a tag.
- **YAML comment round-trip** — the repo uses the `yaml` package (has a Document model that
  *can* preserve comments), but the current `serialize` likely `stringify`s a plain object
  (drops comments). Options: (a) emit the name via the Document API as a real `# comment`;
  (b) a plain `name:` field (simpler, always round-trips) plus the comment as a nicety.
  **Recommend (b)** as the source of truth, comment optional.
- **All name-slug assumptions** — grep every `slugDir(...)` / `conversation_path` /
  `former_names` / rename caller; some tooling or docs may assume browseable names.
- **Legibility** — opaque folder names on disk; mitigated by the `name:`/comment in the
  yaml and (optionally) a generated `NAMES.md` index or per-folder `name` marker file.
- **Back-compat / dual-read** — during migration, readers may need to accept both the
  old name-slug and the new id-slug until the move completes.

## 6. Rollout sketch (each step verifiable)

1. Add `shortChatId`-keyed resolution behind a flag; readers accept both layouts. → verify: new chats land in id folders; old ones still resolve.
2. Migration script: move each existing folder → id key, rewrite yaml, keep `renames.log`. Tag `pre-idfolders`. → verify: every conversation resolves post-move; transcript.md/media intact.
3. Flip resolution to id-only; **delete** `renameSlugDir`/self-heal/`former_names`. → verify: suite green; a group rename only appends `renames.log` + updates `name`, no dir move.
4. Simplify the `@e` feature: drop the `readTranscript` seam, compute the path inline. → verify: `@e` still round-trips, now with no boot wiring.

## 7. Non-goals

- Not changing `transcript.md` format, the Room abstraction, or mesh addressing.
- Not touching the `@e` feature until step 4 (it works correctly today).
- This is a proposal — no code until the operator greenlights the migration.
