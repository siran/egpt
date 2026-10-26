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
// 'wired'   is this command actually reachable, right now, on the surface(s) above?
//             true      — dispatched by src/spine/commands.mjs run() (verified against
//                          that file's source, not memory — see the drift-guard test in
//                          tests/spine-commands.test.mjs).
//             'editor'  — dispatched locally by src/shell/commands.mjs, never reaching
//                          the spine (verified against THAT file's source the same way).
//             omitted   — registered vocabulary, nothing dispatches it yet. Typing it
//                          falls through to the spine's unrecognized-command catch-all.
// A command missing 'wired' is real vocabulary, not a bug to fix here — /help's job is
// to say so honestly, not to pretend every registry entry works.
//
// helpText(brainTypes) — no surface arg — renders the FULL registry unfiltered (every
// command, every surface), same as before 'wired' existed. This is the extension's own
// call (App.jsx formatHelp). helpText(brainTypes, surface) is the spine's /help call:
// only entries relevant to `surface` are considered, wired ones render inline, unwired
// ones move to a clearly labelled tail instead of interleaving.

export const COMMANDS = [
  { section: 'ROOM' },
  { cmd: '/rules',          surface: 'shell',     usage: '/<handle> rules',                                         desc: 'write room etiquette' },
  { cmd: '/last',           surface: 'shell',     usage: '/<handle> last [N]',                                      desc: 'tail N messages (default 10)' },
  { cmd: '/recap',          surface: 'shell',     usage: '/<handle> recap',                                         desc: 'list what THIS chat said while the node slept — the backlog of its last wake, backfilled and never answered: sender, local time, first ~100 chars (the answer to the "N messages in the backlog" notice). Anyone in the chat may type it where public_commands lists it; a node with nothing to list stays silent', wired: true },
  { cmd: '/clear',          surface: 'both',      usage: '/clear',                                         desc: 'clear display', wired: 'editor' },
  { cmd: '/channels',       surface: 'shell',     usage: '/<handle> channels [N] [messages-per-chat]',             desc: 'list the top-N most-active WA chats numbered as @waN, with M recent message lines per chat (default 10 3). Lists via the WhatsApp (beeper) bridge. /channels then @wa<N> <body> to send. Pinned chats (📌) float to the top.' },
  { cmd: '/pin',            surface: 'shell',     usage: '/<handle> pin [@waN ...|clear]',                          desc: 'eGPT-side pin for WA chats — surfaces in /channels + logon summary alongside WhatsApp\'s own pin (unlimited; WA caps phone-side at 3). No-arg lists current eGPT pins. /pin clear removes all.' },
  { cmd: '/unpin',          surface: 'shell',     usage: '/<handle> unpin @waN [@waM ...]',                         desc: 'remove eGPT pin from one or more chats (resolved against the last /channels listing).' },
  { cmd: '/react',          surface: 'shell',     usage: '/<handle> react @waN|@wa-<msgId> <emoji|alias>',          desc: 'react to a WA message. @waN reacts to the chat\'s most recent message; @wa-<msgId> reacts to a specific message (from /recap). Aliases: like, heart, laugh, wow, sad, pray, fire, yuck, ok, no, party, star, etc. Empty emoji clears a prior reaction.' },
  { cmd: '/movie',          surface: 'shell',     usage: '/<handle> movie @waN <preset> [args] [--secret "<text>"] [--keep]', desc: 'play an emoji / ASCII animation in a WA chat by editing a single message frame-by-frame. movies auto-delete after the last frame unless --keep. --secret flashes a punchline before deletion (alien folds it into the scene as the 👽 burp dialog). presets: alien, typewriter, loading, scan. /movie list for args.' },
  { cmd: '/unjoin',         surface: 'shell',     usage: '/<handle> unjoin',                                       desc: 'release the shell↔WA chat binding' },
  { cmd: '/wa-pending',     surface: 'shell',     usage: '/<handle> wa-pending [dispatch <idx|all> | clear]',      desc: 'review WhatsApp messages received but not auto-dispatched because they predate the bridge connect (whatsapp.max_backlog_seconds). dispatch <idx> runs one through the brain pipeline; dispatch all runs the lot; clear discards them.' },
  { cmd: '/storm',          surface: 'shell',     usage: '/<handle> storm [off | status]',                          desc: 'firehose mode: every WhatsApp arrival renders in shell — group chatter, status updates, broadcasts, every observed-chat line — and media notifications include status@broadcast saves. Awareness gates restored when /storm off. Useful for a deliberate "show me everything" pass.' },
  { cmd: '/bans',           surface: 'shell',     usage: '/<handle> bans',                                          desc: 'operator only: list the media-flood auto-bans active on this node, across every chat — sender, chat, reason, minutes left', wired: true },
  { cmd: '/unban',          surface: 'shell',     usage: '/<handle> unban [<name>]',                                desc: 'operator only: lift the active flood ban(s) in THIS chat, or only the sender whose display name or id is <name> — a live in-memory clear, not a config write', wired: true },
  { section: 'PERSONA' },
  { cmd: '/identity',       surface: 'shell',     usage: '/<handle> identity [@<session> | show]',                 desc: 'show or (re)install the egpt persona manifest (the conversation-e personality, brains.identity, default ./e_identity.md). "show" prints the current manifest; no arg installs into @e + every active session.' },
  { section: 'SYSTEM' },
  { cmd: '/status',         surface: 'shell',     usage: '/<handle> status',                                        desc: 'room snapshot: sessions, files, config', wired: true },
  { cmd: '/file',           surface: 'shell',     usage: '/<handle> file',                                          desc: 'show conversation file path' },
  { cmd: '/conversations',  surface: 'shell',     usage: '/<handle> conversations',                                 desc: 'list available conversation files' },
  { cmd: '/conversation',   surface: 'shell',     usage: '/<handle> conversation <name|path>',                      desc: 'switch to a conversation file' },
  { cmd: '/exit',           surface: 'shell',     usage: '/exit',                                          desc: 'quit egpt', wired: 'editor' },
  { cmd: '/version',        surface: 'shell',     usage: '/<handle> version',                                       desc: 'show current commit, branch, last tag, and dirty state' },
  { cmd: '/upgrade',        surface: 'shell',     usage: '/<handle> upgrade [force]',                               desc: 'exit with code 42; egpt-daemon pulls + rebuilds + restarts. Waits for turns and background work first; force skips the background wait', wired: true },
  { cmd: '/restart',        surface: 'shell',     usage: '/<handle> restart [force]',                               desc: 'exit with code 43; egpt-daemon respawns from current disk (picks up external git pulls). Waits for turns and background work first; force skips the background wait', wired: true },
  { cmd: '/rewind',         surface: 'shell',     usage: '/<handle> rewind <ref>',                                  desc: 'exit with code 44; egpt-daemon checks out <ref>, installs, builds, restarts', wired: true },
  { cmd: '/standdown',      surface: 'shell',     usage: '/<handle> standdown [force]',                             desc: 'hand this node to the Session 1 daemon waiting for it (the logon task sends this itself): finish the turns in flight (force: do not wait), end background work, exit 45; the Session 0 daemon takes the node back at logoff. Does nothing when no Session 1 daemon waits, or in Session 1', wired: true },
  { cmd: '/update',         surface: 'shell',     usage: '/<handle> update beeper',                                 desc: 'operator only: install the Beeper update this node downloaded — waits for turns like restart, restarts Beeper (about a minute; eGPT stays up), posts the result to log_to_group — or replies with the one-line Beeper state. eGPT itself is /<handle> upgrade', wired: true },
  { cmd: '/join',           surface: 'shell',     usage: '/<handle> join [<name>]',                                 desc: 'RETIRED (2026-10-25): answers with /<handle> split [<name>], which makes a fork (same agents and files, its own thread). Side rooms /join made before keep working with /send and /end.', wired: true },
  { cmd: '/split',          surface: 'shell',     usage: '/<handle> split [<name>]',                                desc: 'REAL FORK: spin a PRIVATE side-group (you + Rodz) backed by a NEW conversation that DIVERGES — each resident being\'s thread is copied so it evolves independently of this chat. Reply /<handle> send to relay a message back here; reply /<handle> end to archive. Your message becomes a placeholder. Optional <name> titles the group ("SI+<group>-<name>"); none → a random 5-character name. The handle\'s node creates it; anyone in a group chat may run it. On Telegram it is a topic of the group, and the answer is its link.', wired: true },
  { cmd: '/send',           surface: 'shell',     usage: '/<handle> send',                                          desc: 'reply /<handle> send to a message in a side group to relay it to the original chat. Repeatable; anyone in the group may.', wired: true },
  { cmd: '/end',            surface: 'shell',     usage: '/<handle> end',                                           desc: 'reply /<handle> end in a side group to archive it (on Telegram: close the topic) and drop its mapping. Anyone in the group may. Posts nothing.', wired: true },

  { section: 'SESSIONS' },
  { cmd: '/open',           surface: 'both',      usage: '/<handle> open <brain> [name]',                           desc: 'open a new tab/subprocess and register a session', wired: true },
  { cmd: '/attach',         surface: 'both',      usage: '/<handle> attach [brain|profile] [name] [tab]',           desc: 'attach CDP tab, brain profile, or rescan' },
  { cmd: '/detach',         surface: 'both',      usage: '/<handle> detach <name>',                                 desc: 'remove session from room' },
  { cmd: '/use',            surface: 'both',      usage: '/<handle> use [<name>[,<name>...]|clear] [incoming|outgoing|both]', desc: 'set the sessions / WA chats that plain-text routes to. For @waN tokens, an optional direction word applies to all of them (see /join). Multiple /use calls accumulate; "clear" empties the list.' },
  { cmd: '/sessions',       surface: 'both',      usage: '/<handle> sessions [default [name|clear]]',               desc: 'list sessions; manage default operator' },
  { cmd: '/handle',         surface: 'shell',     usage: '/<handle> handle <old> <new>',                            desc: 'rename a session' },
  { cmd: '/emoji',          surface: 'shell',     usage: '/<handle> emoji [name emoji]',                            desc: 'show or set session avatar' },
  { cmd: '/bio',            surface: 'shell',     usage: '/<handle> bio [name [text]]',                             desc: 'show or set session bio' },

  { section: 'PROFILES  (~/.egpt/brains/*.yaml)' },
  { cmd: '/profiles',       surface: 'shell',     usage: '/<handle> profiles',                                      desc: 'list YAML brain profiles' },
  { cmd: '/create-profile', surface: 'shell',     usage: '/<handle> create-profile [name]',                         desc: 'interactive profile wizard' },
  { cmd: '/profile',        surface: 'shell',     usage: '/<handle> profile <name> <url-or-id>',                    desc: 'quick-create profile from ChatGPT/Claude URL' },

  { section: 'BROWSER (CDP)' },
  { cmd: '/chrome',         surface: 'shell',     usage: '/<handle> chrome',                                        desc: 'launch the brain Chrome with the extension loaded', wired: true },
  { cmd: '/login',          surface: 'shell',     usage: '/<handle> login <site>',                                  desc: 'sign in to <site> on the brain Chrome using CHROME\'S OWN saved password — the spine reads the saved credential (DPAPI + AES-GCM), types it, and drives the trusted-click; it is typed and nulled, never returned/logged/posted. Reply is the outcome token (logged-in | needs-2fa | captcha-posted | failed | no-credential). Handles the 2FA (reads the OTP from Gmail/Google Voice) and CAPTCHA (posts to the admin channel) branches.', wired: true },
  { cmd: '/browser',        surface: 'shell',     usage: '/<handle> browser refresh [url]',                         desc: 'operator only: close this chat\'s browser and open a NORMAL Chrome window on its profile at [url] (default about:blank) on the node\'s desktop (a container: its VNC, :6080), to sign in or pass a captcha yourself — sites refuse eGPT\'s automated Chrome. The browser is held (a being asking for it is told so) until that window\'s Chrome exits; then the chat hears it is back, and eGPT\'s Chrome reuses the session', wired: true },
  { cmd: '/tabs',           surface: 'both',      usage: '/<handle> tabs [all]',                                    desc: 'list open Chrome pages', wired: true },
  { cmd: '/tab',            surface: 'shell',     usage: '/<handle> tab <n>',                                       desc: 'operator only: focus tab <n> of this chat\'s browser, numbered as tabs lists it (re-read on every call)', wired: true },
  { cmd: '/close',          surface: 'shell',     usage: '/<handle> close <n>',                                     desc: 'operator only: close tab <n> of this chat\'s browser, numbered as tabs lists it (re-read on every call)', wired: true },
  { cmd: '/refresh',        surface: 'shell',     usage: '/<handle> refresh [@name]',                               desc: 're-poll CDP tab; append full reply' },
  { cmd: '/browse',         surface: 'shell',     usage: '/<handle> browse [via=op] [url] [@name] ["instr"]',       desc: 'open URL or delegate to operator' },
  { cmd: '/continue',       surface: 'shell',     usage: '/<handle> continue',                                      desc: 'resume after captcha / login pause' },
  { cmd: '/mirror',         surface: 'shell',     usage: '/<handle> mirror @<target> [mN …] [--tagged | --no-tag]', desc: 'forward message bodies to a destination. /mirror @waN sends to a WA chat (from /channels); /mirror @<session> re-dispatches as fresh brain input. Multiple mN ids forward each item in order (default = last visible non-system). Tag policy: config mirror.tagged (default "on") prefixes bodies with [<author> <timestamp>]: so the destination knows it\'s a forward; --tagged / --no-tag override per call. Shell additionally tracks the forwarded WA send on the original item, so a subsequent @m<N> reply reaches the new chat too.' },

  { section: 'FILES' },
  { cmd: '/send-file',      surface: 'shell',     usage: '/<handle> send-file [via=op] [path] @name ["instr"]',     desc: 'prepare and send file excerpt to session' },
  { cmd: '/paste-file',     surface: 'shell',     usage: '/<handle> paste-file <name> <path> [--before M]',         desc: 'paste local file directly into session' },

  { section: 'OPERATORS' },
  { cmd: '/history',        surface: 'shell',     usage: '/<handle> history [N]',                                   desc: 'list recent ccode sessions on disk' },
  { cmd: '/session',        surface: 'shell',     usage: '/<handle> session [name] [id|none] [cwd]',                desc: 'manage ccode resume id for a session' },
  { cmd: '/summarize',      surface: 'shell',     usage: '/<handle> summarize [all|last N] <name>',                 desc: 'summarize conversation, save to ~/.egpt/summaries' },
  { cmd: '/inject',         surface: 'shell',     usage: '/<handle> inject <name> [session]',                       desc: 'drop saved summary into room or session' },
  { cmd: '/save',           surface: 'shell',     usage: '/<handle> save <name>',                                   desc: 'save last message verbatim' },
  { cmd: '/summaries',      surface: 'shell',     usage: '/<handle> summaries',                                     desc: 'list saved summaries' },
  { cmd: '/prompts',        surface: 'shell',     usage: '/<handle> prompts [on|off]',                              desc: 'show/hide full prompt sent to operators' },

  { section: 'ROOMS' },
  { cmd: '/rooms',          surface: 'shell',     usage: '/<handle> rooms | /<handle> rooms create <name> | /<handle> rooms join|leave|members <room> | /<handle> rooms delete [force] <room>', desc: 'list rooms, or create/join/leave/inspect/delete one. Absorbed the singular /rooms (retired 2026-08-29 — the commands are plural).', wired: true },
  { cmd: '/members',        surface: 'shell',     usage: '/<handle> members | /<handle> members add tab <n> [alias=<name>|<name>] | /<handle> members remove <id> | /<handle> members mode <disable|mention|all> <id>', desc: 'manage the CURRENT CONVERSATION\'s room roster: list, add a Chrome tab as a brain member, remove one, or set its contribution mode', wired: true },
  { cmd: '/activate',       surface: 'shell',     usage: '/<handle> activate <id>',                                 desc: 'operator only: reopen brain member <id> of the current conversation\'s room whose Chrome tab was closed (its saved url, a fresh tab id); a no-op when its tab is live, and its mode is unchanged', wired: true },
  { cmd: '/radio',          surface: 'shell',     usage: '/<handle> radio | /<handle> radio join [<radio>] | /<handle> radio leave [all|<slug>] | /<handle> radio say <text> | /<handle> radio disable [<radio>|<node>|<person>]', desc: 'node-wide radio status (listeners + joined rooms); join/leave a room\'s relay, /radio say airs text as your voice, /radio disable turns off a radio/node or blocks a person', wired: true },
  { cmd: '/save-room',      surface: 'shell',     usage: '/<handle> save-room [name]',                              desc: 'snapshot the current room lineup as YAML' },

  { section: 'MISC' },
  { cmd: '/whatsapp',       surface: 'shell',     usage: '/<handle> whatsapp [start|pair|disconnect|allow <num>|revoke <num>|allowed]', desc: 'manage whatsapp bridge: start (existing auth), pair (wipe + new QR), disconnect, allow/revoke numbers' },
  { cmd: '/config',         surface: 'both',      usage: '/<handle> config [key [value]]',                          desc: 'read or write config', wired: true },
  { cmd: '/themes',         surface: 'shell',     usage: '/<handle> themes',                                        desc: 'list available themes' },
  { cmd: '/theme',          surface: 'shell',     usage: '/theme <name|next|prev>',                        desc: 'switch color theme (live)', wired: 'editor' },
  { cmd: '/bus-key',        surface: 'extension', usage: '/bus-key [gen|set <key>|clear]',                 desc: 'manage bus signing key (HMAC); empty prints current, gen makes a new one, paste into shell EGPT_BUS_KEY' },
  { cmd: '/help',           surface: 'both',      usage: '/<handle> help',                                          desc: 'list commands wired on this surface; unwired registry entries print in a separate labelled tail', wired: true },
  { cmd: '/log',            surface: 'shell',     usage: '/<handle> log [N=30]',                                    desc: 'show last N log entries (telemetry, hints, debug)' },
  { cmd: '/logs',           surface: 'shell',     usage: '/<handle> logs [N=30]',                                   desc: 'alias for /log' },
  { cmd: '/agents',         surface: 'shell',     usage: '/<handle> agents [<verb>] [<value>] [<handle>|force all [<conversation>]]  ·  verbs: refresh | rethread | reset | compact | stop | mode <mode> | access_level <level>', desc: 'manage ANY agent on any conversation: bare = live status (incl. context size), compact = handoff + native /compact now (same thread), stop = abort the turn in flight (same thread), refresh = re-feed identity + directives into the RUNNING thread (nothing moved, no new thread), rethread = new thread + transcript.md rolled into transcripts/ (folder stays), reset = archive the whole folder + wipe + reseed, mode <mode> = set reply mode (was `auto`, still accepted as a deprecated alias), access_level <level> = confinement tier (`/<handle> agents access_level` with no level lists them; this registry deliberately does not copy them — it is bundled for the browser and cannot import permission-levels.mjs). The command runs on the node of the being it is typed to; a verb with no target acts on that being (`/e agents compact`). A <handle> that node does not host logs `no <handle> in node <node>` to log_to_group. `all` is refused; `force all` applies to every resident agent of that node. Verb first, target last (2026-08-29); <conversation> is the rest of the line, spaces and all — `/e agents refresh e eGPT Rodz Lulu An` (2026-09-28); =<slug> on the command word still names the conversation. `restart` was rethread\'s name until 2026-09-10 and is refused by name — restart is the NODE\'s lifecycle. Where public_commands lists agents, anyone else\'s `/<handle> agents` with nothing more gets the public list of beings here (config agents_list).', wired: true },
];

// All known command tokens (across all surfaces). Used by surfaces to validate
// "is this even a known command?" so we can route helpfully on unknown ones.
export const COMMAND_SET = new Set(
  COMMANDS.filter(c => c.cmd).map(c => c.cmd),
);

// A command names the being that runs it (operator 2026-10-19): `/<handle> <command> [args]`.
// → { handle, cmd: '/<command>', rest } when <command> is registered and <handle> is not itself a
// command; null otherwise. A binding on the command word stays on it (`/e agents=palma …`). Which
// node a handle belongs to is the caller's question.
export function parseBeingCommand(text) {
  const m = /^\/(\S+)[ \t]+(\S+)(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const [word, ...bound] = m[2].split('=');
  const cmd = `/${word.toLowerCase()}`;
  if (!COMMAND_SET.has(cmd) || COMMAND_SET.has(`/${m[1].toLowerCase()}`)) return null;
  return { handle: m[1].toLowerCase(), cmd: bound.length ? `${cmd}=${bound.join('=')}` : cmd, rest: (m[3] ?? '').trim() };
}

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
// No `surface` arg: render the FULL registry (every command, every surface).
// Commands that only exist on one surface get a marker — (shell) or (ext) — so
// readers see the whole egpt vocabulary and know which calls work locally vs.
// need to be routed. This is App.jsx's own call (formatHelp) — the extension is
// backburnered, so its output is untouched.
//
// A `surface` arg (the spine's /help): only entries relevant to that surface
// (its own + 'both') are considered, and only the WIRED ones render in the
// normal list — an unwired entry left inline would send the operator into the
// unrecognized-command catch-all. Everything unwired instead lands in one
// clearly labelled tail block, so the vocabulary stays discoverable without
// being advertised as usable.

const PAD = 44; // usage column width

function surfaceMark(entry) {
  if (entry.surface === 'shell') return '  (shell)';
  if (entry.surface === 'extension') return '  (ext)';
  return '';
}

function sectionLine(section) {
  return `── ${section} ${'─'.repeat(Math.max(0, PAD - section.length - 4))}`;
}

function cmdLine(entry, { mark = true } = {}) {
  return `${entry.usage.padEnd(PAD)}${entry.desc}${mark ? surfaceMark(entry) : ''}`;
}

/**
 * Plain-text help.
 *   helpText(brainTypes)          — full unfiltered registry (App.jsx).
 *   helpText(brainTypes, surface) — that surface's wired commands, plus an
 *                                    unwired tail (the spine's /help).
 */
export function helpText(brainTypes = [], surface = null) {
  const relevant = (e) => !surface || e.surface === 'both' || e.surface === surface;
  const lines = [''];
  let pendingSection = null;
  for (const entry of COMMANDS) {
    if (entry.section) { pendingSection = entry; continue; }
    if (!relevant(entry)) continue;
    if (surface && !entry.wired) continue;   // unwired -> the tail below, not here
    if (pendingSection) { lines.push(sectionLine(pendingSection.section)); pendingSection = null; }
    lines.push(cmdLine(entry, { mark: !surface }));
  }
  if (surface) {
    const unwired = COMMANDS.filter((e) => e.cmd && relevant(e) && !e.wired);
    if (unwired.length) {
      lines.push('', sectionLine('NOT YET WIRED — recognized, not implemented'));
      for (const entry of unwired) lines.push(cmdLine(entry, { mark: false }));
    }
  }
  if (brainTypes.length) lines.push('', `Brain types: ${brainTypes.join('  ')}`);
  lines.push('─'.repeat(PAD + 20), '');
  return lines.join('\n');
}

// HTML-escape user-provided content. Telegram's HTML parse_mode rejects
// unknown tags, and command usages contain literal <name>, <brain>,
// <name|path> tokens that look like HTML to the parser.
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Telegram HTML help. Same content as helpText. */
export function helpHtml(brainTypes = []) {
  const lines = ['🤖 <b>egpt help</b>', ''];
  for (const entry of COMMANDS) {
    if (entry.section) {
      lines.push(`\n<b>${esc(entry.section)}</b>`);
      continue;
    }
    const mark = surfaceMark(entry);
    lines.push(`<code>${esc(entry.usage)}</code> — ${esc(entry.desc)}${mark ? ` <i>${esc(mark.trim())}</i>` : ''}`);
  }
  if (brainTypes.length) lines.push('', `Brain types: ${esc(brainTypes.join('  '))}`);
  return lines.join('\n');
}
