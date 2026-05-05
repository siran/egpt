// interpreter.mjs — shared input parser and command registry
// Used by egpt.mjs (shell) and extension/src/tab/App.jsx (browser).
//
// The registry is the source of truth for which commands exist on which
// surface. /help on each surface filters by `surface` so users only see
// commands they can actually run there.

/**
 * Parse raw user input into a typed descriptor.
 *
 *   /save name      → { type:'command', cmd:'/save', rest:'name' }
 *   @cgpt1 hello    → { type:'mention', target:'cgpt1', body:'hello' }
 *   hello           → { type:'message', body:'hello' }
 */
export function parseInput(text) {
  if (text.startsWith('/')) {
    const i = text.search(/\s/);
    const cmd  = i < 0 ? text : text.slice(0, i);
    const rest = i < 0 ? ''   : text.slice(i + 1).trim();
    return { type: 'command', cmd, rest };
  }
  const m = text.match(/^@(\S+)(?:\s+([\s\S]*))?$/);
  if (m) return { type: 'mention', target: m[1], body: (m[2] ?? '').trim() };
  return { type: 'message', body: text };
}

// ── Command registry ──────────────────────────────────────────────────────────
// Each entry is either a section header { section } or a command descriptor.
// 'usage'   one-line form shown in /help.
// 'desc'    short description.
// 'surface' which surfaces support this command:
//             'shell'      shell only (egpt.mjs)
//             'extension'  browser extension only (App.jsx)
//             'both'       both surfaces
// helpText/helpHtml filter by surface so neither side advertises commands the
// other implements. If 'surface' is omitted on a section header, the section
// is shown when any of its commands are visible.

export const COMMANDS = [
  { section: 'ROOM' },
  { cmd: '/rules',          surface: 'shell',     usage: '/rules',                                         desc: 'write room etiquette' },
  { cmd: '/last',           surface: 'shell',     usage: '/last [N]',                                      desc: 'tail N messages (default 10)' },
  { cmd: '/clear',          surface: 'extension', usage: '/clear',                                         desc: 'clear display' },
  { cmd: '/status',         surface: 'shell',     usage: '/status',                                        desc: 'room snapshot: sessions, files, config' },
  { cmd: '/file',           surface: 'shell',     usage: '/file',                                          desc: 'show conversation file path' },
  { cmd: '/conversations',  surface: 'shell',     usage: '/conversations',                                 desc: 'list available conversation files' },
  { cmd: '/conversation',   surface: 'shell',     usage: '/conversation <name|path>',                      desc: 'switch to a conversation file' },
  { cmd: '/exit',           surface: 'shell',     usage: '/exit',                                          desc: 'quit egpt' },

  { section: 'SESSIONS' },
  { cmd: '/open',           surface: 'both',      usage: '/open <brain> [name]',                           desc: 'open a new tab/subprocess and register a session' },
  { cmd: '/attach',         surface: 'both',      usage: '/attach [brain|profile] [name] [tab]',           desc: 'attach CDP tab, brain profile, or rescan' },
  { cmd: '/detach',         surface: 'both',      usage: '/detach <name>',                                 desc: 'remove session from room' },
  { cmd: '/use',            surface: 'extension', usage: '/use <name>',                                    desc: 'set active session' },
  { cmd: '/sessions',       surface: 'both',      usage: '/sessions [default [name|clear]]',               desc: 'list sessions; manage default operator' },
  { cmd: '/handle',         surface: 'shell',     usage: '/handle <old> <new>',                            desc: 'rename a session' },
  { cmd: '/emoji',          surface: 'shell',     usage: '/emoji [name emoji]',                            desc: 'show or set session avatar' },
  { cmd: '/bio',            surface: 'shell',     usage: '/bio [name [text]]',                             desc: 'show or set session bio' },

  { section: 'PROFILES  (~/.egpt/brains/*.yaml)' },
  { cmd: '/profiles',       surface: 'shell',     usage: '/profiles',                                      desc: 'list YAML brain profiles' },
  { cmd: '/create-profile', surface: 'shell',     usage: '/create-profile [name]',                         desc: 'interactive profile wizard' },
  { cmd: '/profile',        surface: 'shell',     usage: '/profile <name> <url-or-id>',                    desc: 'quick-create profile from ChatGPT/Claude URL' },

  { section: 'BROWSER (CDP)' },
  { cmd: '/tabs',           surface: 'both',      usage: '/tabs [all]',                                    desc: 'list open Chrome pages' },
  { cmd: '/refresh',        surface: 'shell',     usage: '/refresh [@name]',                               desc: 're-poll CDP tab; append full reply' },
  { cmd: '/browse',         surface: 'shell',     usage: '/browse [via=op] [url] [@name] ["instr"]',       desc: 'open URL or delegate to operator' },
  { cmd: '/continue',       surface: 'shell',     usage: '/continue',                                      desc: 'resume after captcha / login pause' },
  { cmd: '/mirror',         surface: 'shell',     usage: '/mirror [@src] [@tgt]',                          desc: 'forward message between sessions' },

  { section: 'FILES' },
  { cmd: '/send-file',      surface: 'shell',     usage: '/send-file [via=op] [path] @name ["instr"]',     desc: 'prepare and send file excerpt to session' },
  { cmd: '/paste-file',     surface: 'shell',     usage: '/paste-file <name> <path> [--before M]',         desc: 'paste local file directly into session' },

  { section: 'OPERATORS' },
  { cmd: '/history',        surface: 'shell',     usage: '/history [N]',                                   desc: 'list recent ccode sessions on disk' },
  { cmd: '/session',        surface: 'shell',     usage: '/session [name] [id|none] [cwd]',                desc: 'manage ccode resume id for a session' },
  { cmd: '/summarize',      surface: 'shell',     usage: '/summarize [all|last N] <name>',                 desc: 'summarize conversation, save to ~/.egpt/summaries' },
  { cmd: '/inject',         surface: 'shell',     usage: '/inject <name> [session]',                       desc: 'drop saved summary into room or session' },
  { cmd: '/save',           surface: 'shell',     usage: '/save <name>',                                   desc: 'save last message verbatim' },
  { cmd: '/summaries',      surface: 'shell',     usage: '/summaries',                                     desc: 'list saved summaries' },
  { cmd: '/prompts',        surface: 'shell',     usage: '/prompts [on|off]',                              desc: 'show/hide full prompt sent to operators' },

  { section: 'ROOMS  (WIP — /load-room not yet wired)' },
  { cmd: '/rooms',          surface: 'shell',     usage: '/rooms',                                         desc: 'list saved rooms' },
  { cmd: '/save-room',      surface: 'shell',     usage: '/save-room [name]',                              desc: 'snapshot the current room lineup as YAML' },

  { section: 'MISC' },
  { cmd: '/telegram',       surface: 'both',      usage: '/telegram | <node> | disconnect',                desc: 'show polling node, hand off, or disconnect (LAN handoff via bus)' },
  { cmd: '/config',         surface: 'both',      usage: '/config [key [value]]',                          desc: 'read or write config' },
  { cmd: '/themes',         surface: 'shell',     usage: '/themes',                                        desc: 'list available themes' },
  { cmd: '/theme',          surface: 'shell',     usage: '/theme <name|next|prev>',                        desc: 'switch color theme (live)' },
  { cmd: '/help',           surface: 'both',      usage: '/help',                                          desc: 'show this list' },
];

// All known command tokens (across all surfaces). Used by surfaces to validate
// "is this even a known command?" so we can route helpfully on unknown ones.
export const COMMAND_SET = new Set(
  COMMANDS.filter(c => c.cmd).map(c => c.cmd),
);

/** Set of command tokens valid on a given surface. */
export function commandSetFor(surface) {
  return new Set(
    COMMANDS
      .filter(c => c.cmd && (c.surface === 'both' || c.surface === surface))
      .map(c => c.cmd),
  );
}

// ── Help renderers ────────────────────────────────────────────────────────────
//
// /help is a common block: both surfaces render the FULL registry. Commands
// that only exist on one surface get a marker — (shell) or (ext) — so users
// see the whole egpt vocabulary and know which calls work locally vs. need
// to be routed (today: typed in the other surface; eventually: through the
// distributed-room CDP-tab bridge).

const PAD = 44; // usage column width

function surfaceMark(entry) {
  if (entry.surface === 'shell') return '  (shell)';
  if (entry.surface === 'extension') return '  (ext)';
  return '';
}

/** Plain-text help. Same output on every surface. */
export function helpText(brainTypes = []) {
  const lines = [''];
  for (const entry of COMMANDS) {
    if (entry.section) {
      lines.push(`── ${entry.section} ${'─'.repeat(Math.max(0, PAD - entry.section.length - 4))}`);
      continue;
    }
    lines.push(`${entry.usage.padEnd(PAD)}${entry.desc}${surfaceMark(entry)}`);
  }
  if (brainTypes.length) lines.push('', `Brain types: ${brainTypes.join('  ')}`);
  lines.push('─'.repeat(PAD + 20), '');
  return lines.join('\n');
}

/** Telegram HTML help. Same content as helpText. */
export function helpHtml(brainTypes = []) {
  const lines = ['🤖 <b>egpt help</b>', ''];
  for (const entry of COMMANDS) {
    if (entry.section) {
      lines.push(`\n<b>${entry.section}</b>`);
      continue;
    }
    const mark = surfaceMark(entry);
    lines.push(`<code>${entry.usage}</code> — ${entry.desc}${mark ? ` <i>${mark.trim()}</i>` : ''}`);
  }
  if (brainTypes.length) lines.push('', `Brain types: ${brainTypes.join('  ')}`);
  return lines.join('\n');
}
