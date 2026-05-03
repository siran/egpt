// tools/theme.mjs — terminal color theme loader
//
// Themes live in <egpt-root>/themes/<name>.json (shipped) or
// ~/.egpt/themes/<name>.json (user override, takes priority).
//
// Activate via "theme": "<name>" in ~/.egpt/config.json.
// Unknown keys are ignored; missing keys fall back to DEFAULTS.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EGPT_HOME  = join(homedir(), '.egpt');
const THEMES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'themes');

export const DEFAULTS = {
  authorYou:       'cyanBright',
  authorSystem:    'magentaBright',
  authorBrain:     'greenBright',
  meta:            'cyanBright',      // timestamps, (thinking…), ╌╌╌ separator
  systemBody:      'cyan',            // egpt system message body text
  helpSeparator:   'cyanBright',      // ── ROOM ── dividers
  helpCommand:     'yellowBright',    // /command names
  helpDash:        'cyanBright',      // ' — ' between command and description
  helpDescription: 'white',           // description text
  helpIndent:      'blueBright',      // indented continuation lines
  statusBrand:     'cyanBright',      // '🧠 egpt' in status bar
  statusFile:      'blueBright',      // filename in status bar
  statusSessions:  'cyanBright',      // session list in status bar
  streamingStats:  'blueBright',      // char count / elapsed / hidden lines
  spinnerLabel:    'yellowBright',    // spinner label + browser-waiting header
  spinnerElapsed:  'cyanBright',      // elapsed time next to spinner
  hint:            'blueBright',      // subtle hints (input bar, /continue)
  error:           'red',
};

// Load a theme by name. Returns merged theme object (always complete).
export function loadTheme(name = 'default') {
  const userPath = join(EGPT_HOME, 'themes', `${name}.json`);
  const appPath  = join(THEMES_DIR, `${name}.json`);
  for (const p of [userPath, appPath]) {
    try {
      return { ...DEFAULTS, ...JSON.parse(readFileSync(p, 'utf8')) };
    } catch {}
  }
  return { ...DEFAULTS };
}
