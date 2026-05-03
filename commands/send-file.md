---
command: send-file
---
[send-file task — prepare local file excerpt for @{{target}}]

Source path or search hint from the user:
{{source_hint}}

Preparation instruction from the user:
{{instruction}}

Write the prepared excerpt to this exact UTF-8 Markdown file path:
{{output_path}}

Rules:
- Resolve the source path/search hint yourself. If no path was given, find the intended file from the instruction and local repo context.
- If a relative path or fuzzy hint is given, use cwd and nearby repo context to locate it.
- Preserve exact source text. Do not summarize unless the user explicitly requested a summary.
- For range instructions like "before chapter 8", identify the heading/marker in the source and include content before it.
- Do not include the excerpt in your reply.
- After writing the file, reply with exactly one short line: prepared: {{output_path}}
