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
//   everything else           → forward to the spine as `{ text }`
//
// `/exit` here is editor-local ON PURPOSE: closing the editor must NEVER touch the spine
// (plan §0). The spine's own `/exit` (quit the node) is a different command reached only
// by forwarding a DIFFERENT phrasing — the MVP does not expose it.
export function routeCommand(line) {
  const raw = String(line ?? '');
  const word = raw.trim().split(/\s+/)[0];
  switch (word) {
    case '/exit':  return { action: 'exit' };
    case '/clear': return { action: 'clear' };
    case '/theme': return { action: 'theme', arg: raw.trim().slice('/theme'.length).trim() };
    default:       return { action: 'forward', text: raw };
  }
}
