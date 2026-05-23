# Brain Type Profiles

This directory is for repo-defined YAML brain profiles. `egpt` also reads
personal profiles from `~/.egpt/brains/*.yaml` and project-local profiles from
`./.egpt/brains/*.yaml`.

Example:

```yaml
name: alex
type: codex
model: gpt-5.4-mini
effort: low
cwd: C:\Users\an\src\egpt
summary: alex
chat_name: Alex
```

Attach it from egpt with:

```text
/attach alex
```

For a web conversation, egpt can write the minimal profile:

```text
/profile alex https://chatgpt.com/c/69f68099-5cf8-8328-ad8f-37d991ff0071
```

Or from the shell:

```bash
node egpt.mjs profile alex 69f68099-5cf8-8328-ad8f-37d991ff0071
```

Supported `type` values:

- `codex`
- `code` or `ccode`
- `cdp_chat`
- `cdp_claude`

Keep runtime state out of these files. egpt writes it under
`~/.egpt/brain-state/<profile>.json`.
