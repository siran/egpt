# Brain Type Profiles

This directory is for repo-defined YAML brain profiles. `egpt` also reads
personal profiles from `~/.egpt/brains/*.yaml` and project-local profiles from
`./.egpt/brains/*.yaml`.

Example:

```yaml
name: alex
type: codex
model: gpt-5.5
effort: low
cwd: C:\Users\an\src\egpt
summary: alex
chat_name: Alex
```

Attach it from egpt with:

```text
/attach alex
```

Supported `type` values:

- `codex`
- `code` or `ccode`
- `cdp_chat`
- `cdp_claude`

Keep runtime state out of these files. egpt writes it under
`~/.egpt/brain-state/<profile>.json`.
