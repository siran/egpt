// src/shell/commands.mjs — the editor-LOCAL command router (pure).
//
// The shell limb carries ZERO command logic (plan §2); nearly everything the operator
// types is forwarded verbatim to the spine, which owns the interpreter. The ONLY
// exceptions are three commands that act on the EDITOR itself and would be meaningless
// at the spine: theme, display-clear, and quit-the-editor.
//
//   /theme [next|prev|<name>] → switch the editor's color theme     (local)
//   /clear                    → clear the editor's transcript         (local)
//   /exit                     → quit the EDITOR (never the spine)     (local)
//   h | help | ?              → forwarded as `/help` (whole-line only, see below)
//   everything else           → forward to the spine as `{ text }`
//
// `/exit` here is editor-local ON PURPOSE: closing the editor must NEVER touch the spine
// (plan §0). The spine's own `/exit` (quit the node) is a different command reached only
// by forwarding a DIFFERENT phrasing — the MVP does not expose it.
//
// Bare help: only when the ENTIRE trimmed line is exactly 'h', 'help', or '?' — nothing
// else on it. Deliberately whole-line, not a prefix/first-word match: bare-handle
// addressing (a leading word can route a message) means a loose match would swallow
// "help me write this email" as a help request instead of forwarding it as a message.
export function routeCommand(line) {
  const raw = String(line ?? '');
  const trimmed = raw.trim();
  if (trimmed === 'h' || trimmed === 'help' || trimmed === '?') return { action: 'forward', text: '/help' };
  const word = trimmed.split(/\s+/)[0];
  switch (word) {
    case '/exit':  return { action: 'exit' };
    case '/clear': return { action: 'clear' };
    case '/theme': return { action: 'theme', arg: raw.trim().slice('/theme'.length).trim() };
    default:       return { action: 'forward', text: raw };
  }
}
