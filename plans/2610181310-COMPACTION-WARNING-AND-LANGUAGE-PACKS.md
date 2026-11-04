# Compaction warning, `/agents compact help`, and language packs

Spec by wren (in eGPT, node kg), 2026-10-18, for the operator and for any wren working outside eGPT.
Status: **spec only, nothing built.** Base: `origin/main` 87fe7eb.

---

## Part A: the compaction warning

### A.1 What exists today (read in `src/spine/compaction.mjs` and the live `config.yaml`)
- After every turn, brainpool re-arms a per-conversation cooling timer. Live value: `compaction.cooling_ms: 600000` (10 min). The operator spoke of 15 min, so the text must read the configured value, not a constant.
- Once the conversation is quiet, the session size is measured. At `ratio − warn_gap` (live `0.85 − 0.03` = 82 %), the being receives `handoff_prompt`, and the admin channel receives the pre-compaction notice.
- **Since 4b584e2:** `compact_after_handoff` (default true). If the handoff turn returns text and nothing is pending, `/compact` + `welcome` fire at once. Otherwise compaction happens at the next quiet tick.
- At `critical_ratio` (live 0.90), compaction fires with no wait.
- The notice text today is the top-level `compaction_warn_notice`, default `"the conversation is at {percent}%, handoff being written, compaction next. you can read the handoff here: {path}"`. It is always posted to the admin channel (`warnNotice`, ~line 75), with a `node · chat` prefix.
- `/agents compact <handle> [<conversation>]` already exists (912bd5b): handoff + native `/compact` now, on the same thread.

### A.2 What the operator wants
1. The warning **explains the schedule**: after the quiet period a handoff will be written and `/compact` fired; at the critical % a `/compact` fires immediately.
2. It is **configurable in the existing `compaction:` block**, including WHERE it is posted.
3. It points to **`/agents compact help`**, which shows how to compact now.

### A.3 Config (inside the existing `compaction:` block; per being and per conversation through the same cascade as `ratio`)
```yaml
compaction:
  warning_post_group: admin    # same | admin | off   (default: admin, today's behaviour)
  warning: "🗜️ {agent} is at {percent}% of its context. After {cooling} of quiet it writes a handoff ({path}) and compacts. At {critical}% it compacts at once. To compact now: /agents compact help"
```
- `same`: the chat the being is talking in. `admin`: `admin_channel` (eGPT Admin). `off`, or an empty `warning`, posts nothing. The handoff and the compaction still happen.
- Variables: `{agent}` (handle), `{percent}` (now), `{ratio}` / `{critical}` (as %), `{cooling}` (humanised `cooling_ms`, e.g. "10 min"), `{path}` (the ONE resolved handoff path from 4b584e2).
- **Migration:** the top-level `compaction_warn_notice` stays a deprecated alias for `compaction.warning`. If both are set, `compaction.warning` wins. One release later, remove the alias.
- For a public being (`agents.<x>.public: true`), `same` must degrade to `admin` (a lead must never see eGPT machinery).

### A.4 `/agents compact help`
- `help` is a value accepted where a handle goes (`/agents compact help`). It prints, for THIS chat:
```
/agents compact e                     compact E in this chat now (handoff first)
/agents compact e eGPT Rodz Lola An   compact E in another conversation
/agents compact wren                  compact wren (node-wide thread)
/agents compact force all             every being resident here
Current: E at 64% · warns at 82% · compacts after 10 min quiet · at once at 90%
```
- The "Current:" line comes from the same numbers `/status` already prints (compact-being.mjs `compactionPolicy`).
- Operator-only, like every `/agents` verb (the lock from fc985ce stays).

### A.5 Tests
`same` posts in the chat, `admin` in eGPT Admin, `off` and empty post nothing. Variables resolve from config, never constants. The alias works and the new key wins. A public being degrades to admin. `help` output lists only beings resident in the chat. Non-operators are refused.

---

## Part B: language packs (messages AND commands)

### B.1 Goal
Every human-facing string eGPT itself emits, and every command word, can switch language per node and per conversation, without code changes. Defaults stay English ("all in English" for config and code). A pack only adds translations.

### B.2 Scope: what a pack covers and what it doesn't
**Covered (eGPT's own voice):**
- status frames (`⏳ Thinking…`, `Queued (N ahead)`, `⚠️ no reply (turn failed/empty)`, liveness ticks);
- guard and pause lines (`⏸️ egpt paused this chat…`, `resume`);
- `/join` / `/split` / `/send` / `/end` texts (placeholder, opener, exists, limit, origin template);
- the public `/agents` list words, `/help` and `usage:` lines, audit lines, compaction warning/welcome/handoff prompt, the "working in background" status, and command replies.

**Not covered:**
- what beings say (they already answer in the user's language);
- logs (stay English, they are for the operator and agents);
- config keys.

**Commands:** canonical ids stay English (`/join`). A pack adds aliases (`/unir`). Both always work, so a pack can never take a command away.

### B.3 Format
```
config/lang/en.yaml          shipped, the complete catalog (source of truth, generated from code in step 1)
config/lang/es.yaml          shipped, translations (may be partial)
<profile>/config/lang/*.yaml  operator overrides, merged over the shipped pack, key by key
```
```yaml
# config/lang/es.yaml
messages:
  status.thinking: "⏳ Pensando…"
  status.queued: "⏳ En cola ({n} antes)…"
  join.placeholder: "🔗 te uniste a {name}. Para entrar: /unir {name}"
  compaction.warning: "🗜️ {agent} está al {percent}%…"
commands:
  join:  [unir, únete]
  split: [dividir]
  send:  [enviar]
  end:   [cerrar]
words:                 # single tokens the parser matches, not commands
  resume: [reanudar, sigue]
  stop:   [para, alto]
```

### B.4 Resolution
- **Language of a message** = the conversation's `language:` (conversations.yaml), else the node's `language:` (config.yaml), else `en`. Admin-channel lines use the node language.
- **Lookup** = profile override pack → shipped pack for that language → `en` → the literal default in code. A missing key never breaks; it falls back.
- **Config text keys keep working.** `join.placeholder`, `send.origin_template`, `compaction.warning`… set in config.yaml stay the highest override, for every language. A pack only fills what config doesn't set.
- **Commands:** the parser accepts the canonical word plus the aliases of the conversation's language AND of `en`. Collision check at load: an alias equal to another command, a being handle, or another alias is refused and logged, never silently shadowed.
- **STOP is special:** the safe word stays `stop` in every language (operator rule). Packs may ADD synonyms under `words.stop` but can never remove `stop`.

### B.5 Steps (each shippable alone, each with its own tests)
1. **Inventory + catalog (no behaviour change).** A disposable agent sweeps `src/` for every human-facing literal and writes `config/lang/en.yaml` with stable keys. A test fails if a known emit site uses a literal not in the catalog. Output: the catalog, plus a list of sites. Expect 150–300 keys, some of them shared by several sites.
2. **`t(key, vars, ctx)` and resolution.** One module (`src/lang.mjs`): load, merge, fallback, `{var}` fill, per-conversation language. Move the emit sites to `t()` one domain per commit (status frames, guard, join/split/send, compaction, help/usage). Each commit is byte-identical in English (snapshot tests).
3. **Command aliases.** The interpreter registry (`src/interpreter.mjs`) gets aliases from the pack. RECAP_CMD / JOIN_CMD / AGENTS_BARE_CMD and the other regexes are built from the canonical word plus aliases. Collision check at load. `/help` lists aliases in the user's language.
4. **Spanish pack.** `config/lang/es.yaml` complete for the covered scope, with a completeness test (every `en` key present, same `{vars}`).
5. **Being-facing prompts (optional).** `handoff_prompt`, `welcome` and the directive cards can be localized. The default is to keep them English, because the models handle it and it keeps one source.
6. **Operator UX.** `/lang` (operator) shows and sets a conversation's language, writing `language:` to conversations.yaml. `/status` shows the language.

### B.6 Risks
- **Matching by text:** guard and echo code that recognizes our own frames by text (stop-guard STATUS regex, the echo filter's `⏳` marker, the ⤴️/↪️ ticks) must be built from the SAME catalog, so a translated frame is still recognized. This is the biggest trap. Step 2 must include it, with tests.
- **Mixed-language groups:** one language per conversation. The group picks one.
- **Two nodes in one chat** (kg and do) must agree. The conversation's `language:` lives per node, so set it on both nodes, or read it from a shared rule. Document the choice.

---

## Suggested order
A first: small, independent, about one agent-hour. Then B1 → B2 (status + guard first, because of the matching trap) → B3 → B4. B5 and B6 when wanted.
