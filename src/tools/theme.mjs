// tools/theme.mjs — terminal color theme loader
//
// Themes live in <egpt-root>/themes/<name>.json (shipped) or
// ~/.egpt/themes/<name>.json (user override, takes priority).
//
// Activate via "theme": "<name>" in ~/.egpt/config.json.
// Unknown keys are ignored; missing keys fall back to DEFAULTS.

import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EGPT_HOME } from '../egpt-home.mjs';   // profile-aware: EGPT_HOME selects the node

export const THEMES_DIR      = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'themes');
export const USER_THEMES_DIR = join(EGPT_HOME, 'themes');

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

  // /recap + welcome-back palette. Per-section color is applied to
  // both the section header (📌 Pinned, 👥 Groups…) and to that
  // section's chat-label column in each row — visual continuity that
  // makes "which conversation am I looking at" pre-attentive. The
  // four column colors apply per row regardless of section, so the
  // timestamp/id/author columns stay calm while the chat + body
  // carry the section accent.
  recapHeader:        'cyanBright',     // "welcome back —" + "recap — last N msgs…" titles
  recapHint:          'blueBright',     // (DMs hidden) · reply with @<id> · 📎 files · 💥 reactions
  recapTimestamp:     'gray',           // HH:MM column
  recapId:            'blue',           // wa-XXXXXXXX column (subtle so the id doesn't shout)
  recapAuthor:        'cyan',           // author column
  recapBody:          'white',          // body column (the actual message text)
  recapColorPinned:   'yellowBright',   // chat column + section header for Pinned section
  recapColorGroup:    'greenBright',    // chat column + section header for Groups section
  recapColorStatus:   'magentaBright',  // chat column + section header for Status feed section
  recapColorDm:       'cyan',           // chat column + section header for DMs section
  // Section emojis — tailored per theme so each palette has a small
  // personality marker beyond the colors alone. 📌 stays for Pinned
  // across themes (the affordance is semantic).
  recapEmojiPinned:   '📌',
  recapEmojiGroup:    '👥',
  recapEmojiStatus:   '📡',
  recapEmojiDm:       '💬',

  // Generic list-rendering palette. Used by commands that opt into
  // _themed: true on sysOut — the renderer classifies each line by
  // pattern (header, section, item, sub, hint, etc.) and colors it
  // from these keys. Reusing the recap keys would be tempting but
  // breaks the semantic split: /recap has its own typed-row pipeline,
  // while /channels, /sessions, /rooms, etc. emit plain text and rely
  // on the classifier.
  listHeader:   'cyanBright',    // top header line ("chats (top 10…):")
  listSection:  'magentaBright', // ── divider headings ──
  listItem:     'white',         // primary list rows
  listAccent:   'yellowBright',  // pin markers, default-op asterisks, highlights
  listSub:      'cyan',          // sub-rows (preview/bio/detail under an item)
  listMuted:    'gray',          // "(no rooms)" / "(none)" placeholders
  listHint:     'blueBright',    // footer hints ("/room join <name> to enter…")
};

// Load a theme by name. Returns merged theme object (always complete).
export function loadTheme(name = 'default') {
  const userPath = join(USER_THEMES_DIR, `${name}.json`);
  const appPath  = join(THEMES_DIR, `${name}.json`);
  for (const p of [userPath, appPath]) {
    try {
      return { ...DEFAULTS, ...JSON.parse(readFileSync(p, 'utf8')) };
    } catch {}
  }
  return { ...DEFAULTS };
}

// List all available theme names (shipped + user), sorted.
export async function listThemes() {
  const [app, user] = await Promise.all([
    readdir(THEMES_DIR).catch(() => []),
    readdir(USER_THEMES_DIR).catch(() => []),
  ]);
  return [...new Set([...app, ...user])]
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5))
    .sort();
}
