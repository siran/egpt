// tools/template.mjs — shared command prompt template loader
//
// Templates live in <egpt-root>/commands/<name>.md (shipped default) or
// ~/.egpt/commands/<name>.md (user override, takes priority).
//
// Format:
//   ---
//   command: <name>
//   ---
//   Body text with {{variable}} substitutions.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EGPT_HOME   = join(homedir(), '.egpt');
const COMMANDS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'commands');

// Load a template by command name. Returns { path, body } or null.
export async function loadTemplate(cmdName) {
  const userPath = join(EGPT_HOME, 'commands', `${cmdName}.md`);
  const appPath  = join(COMMANDS_DIR, `${cmdName}.md`);
  for (const p of [userPath, appPath]) {
    try {
      const raw = await readFile(p, 'utf8');
      const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
      return { path: p, body };
    } catch {}
  }
  return null;
}

// Replace {{key}} placeholders with values from vars.
export function applyTemplate(body, vars) {
  return body.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

// Load template and apply vars in one step. Returns { text, path } or null.
export async function buildCommandPrompt(cmdName, vars) {
  const tpl = await loadTemplate(cmdName);
  if (!tpl) return null;
  return { text: applyTemplate(tpl.body, vars), path: tpl.path };
}
