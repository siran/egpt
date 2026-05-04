// interpreter.mjs — shared input parser and command registry
// Used by egpt.mjs (shell) and extension/src/tab/App.jsx (browser).

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
// 'usage' is the one-line form shown in /help.
// 'desc'  is the short description.
// Commands absent from a platform are shown greyed/noted — they're room-level
// vocabulary and any node can route them.

export const COMMANDS = [
  { section: 'ROOM' },
  { cmd: '/rules',          usage: '/rules',                                         desc: 'write room etiquette' },
  { cmd: '/last',           usage: '/last [N]',                                      desc: 'tail N messages (default 10)' },
  { cmd: '/clear',          usage: '/clear',                                         desc: 'clear display' },
  { cmd: '/status',         usage: '/status',                                        desc: 'room snapshot: sessions, files, config' },
  { cmd: '/file',           usage: '/file',                                          desc: 'show conversation file path' },
  { cmd: '/exit',           usage: '/exit',                                          desc: 'quit egpt' },

  { section: 'SESSIONS' },
  { cmd: '/brain',          usage: '/brain <type> [name]',                           desc: 'open a brain tab and attach it' },
  { cmd: '/attach',         usage: '/attach [brain|profile] [name] ...',             desc: 'attach CDP tab, brain profile, or rescan' },
  { cmd: '/detach',         usage: '/detach <name>',                                 desc: 'remove session from room' },
  { cmd: '/use',            usage: '/use <name>',                                    desc: 'set active session' },
  { cmd: '/sessions',       usage: '/sessions [default [name|clear]]',               desc: 'list sessions; manage default operator' },
  { cmd: '/handle',         usage: '/handle <old> <new>',                            desc: 'rename a session' },
  { cmd: '/emoji',          usage: '/emoji [name emoji]',                            desc: 'show or set session avatar' },
  { cmd: '/bio',            usage: '/bio [name [text]]',                             desc: 'show or set session bio' },

  { section: 'PROFILES  (~/.egpt/brains/*.yaml)' },
  { cmd: '/profiles',       usage: '/profiles',                                      desc: 'list YAML brain profiles' },
  { cmd: '/create-profile', usage: '/create-profile [name]',                         desc: 'interactive profile wizard' },
  { cmd: '/profile',        usage: '/profile <name> <url-or-id>',                   desc: 'quick-create profile from ChatGPT/Claude URL' },

  { section: 'BROWSER (CDP)' },
  { cmd: '/tabs',           usage: '/tabs [all]',                                    desc: 'list open Chrome pages' },
  { cmd: '/refresh',        usage: '/refresh [@name]',                               desc: 're-poll CDP tab; append full reply' },
  { cmd: '/browse',         usage: '/browse <url>',                                  desc: 'open URL in Chrome, return page text' },
  { cmd: '/continue',       usage: '/continue',                                      desc: 'resume after captcha / login pause' },
  { cmd: '/mirror',         usage: '/mirror [@src] [@tgt]',                          desc: 'forward message between sessions' },

  { section: 'FILES' },
  { cmd: '/send-file',      usage: '/send-file [via=<op>] [path] @<s> ["instr"]',   desc: 'prepare and send file excerpt to session' },
  { cmd: '/paste-file',     usage: '/paste-file <session> <path> [--before M]',     desc: 'paste local file directly into session' },

  { section: 'OPERATORS' },
  { cmd: '/summarize',      usage: '/summarize [all|last N] <name>',                 desc: 'summarize conversation for a session' },
  { cmd: '/inject',         usage: '/inject <name> [session]',                      desc: 'drop saved summary into room or session' },
  { cmd: '/save',           usage: '/save <name>',                                   desc: 'save last message verbatim' },
  { cmd: '/summaries',      usage: '/summaries',                                     desc: 'list saved summaries' },
  { cmd: '/prompts',        usage: '/prompts [on|off]',                              desc: 'show/hide full prompt sent to operators' },

  { section: 'MISC' },
  { cmd: '/telegram',       usage: '/telegram disconnect | @node [ttl:T]',           desc: 'manage Telegram bridge or hand off' },
  { cmd: '/config',         usage: '/config [key [value]]',                          desc: 'read or write config' },
  { cmd: '/themes',         usage: '/themes',                                        desc: 'list available themes' },
  { cmd: '/theme',          usage: '/theme <name|next|prev>',                        desc: 'switch color theme (live)' },
  { cmd: '/help',           usage: '/help',                                          desc: 'show this list' },
];

export const COMMAND_SET = new Set(
  COMMANDS.filter(c => c.cmd).map(c => c.cmd)
);

// ── Help renderers ────────────────────────────────────────────────────────────

const PAD = 44; // usage column width

/** Plain-text help for terminal / extension display. */
export function helpText(brainTypes = []) {
  const lines = [''];
  for (const entry of COMMANDS) {
    if (entry.section) {
      lines.push(`── ${entry.section} ${'─'.repeat(Math.max(0, PAD - entry.section.length - 4))}`);
      continue;
    }
    lines.push(`${entry.usage.padEnd(PAD)}${entry.desc}`);
  }
  if (brainTypes.length) lines.push('', `Brain types: ${brainTypes.join('  ')}`);
  lines.push('─'.repeat(PAD + 20), '');
  return lines.join('\n');
}

/** Telegram HTML help (used by shell's Telegram bridge). */
export function helpHtml(brainTypes = []) {
  const lines = ['🤖 <b>egpt help</b>', ''];
  for (const entry of COMMANDS) {
    if (entry.section) {
      lines.push(`\n<b>${entry.section}</b>`);
      continue;
    }
    lines.push(`<code>${entry.usage}</code> — ${entry.desc}`);
  }
  if (brainTypes.length) lines.push('', `Brain types: ${brainTypes.join('  ')}`);
  return lines.join('\n');
}
