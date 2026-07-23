// emitted-commands.mjs — let a brain reply drive the command surface.
//
// A resident (conversation-e) can act, not just talk: any OWN-LINE slash
// command in its reply is pulled out and executed through the same handleSlash
// pipeline the operator uses, in the resident's chat context. The remaining
// prose is delivered as the actual reply. Commands must be on their own line —
// inline "/react" inside a sentence is treated as text, so normal prose that
// happens to contain a slash is never misread.
//
// This module is the PURE split only (no execution, no policy). The caller
// classifies each candidate (known + allowlisted?) and decides run/block/keep;
// see the runner in egpt-spine.mjs. Allowlist + safety live there.

// A line is a command CANDIDATE when, trimmed, it starts with '/' + a letter
// and a command-shaped token (letters/digits/-). Order is preserved so prose
// can be reassembled with any false-positives folded back in.
const CMD_LINE = /^\/[a-zA-Z][\w-]*(?:\s|$)/;

export function splitEmittedReply(reply) {
  return String(reply ?? '').split('\n').map(raw => {
    const text = raw.trim();
    return { raw, text, isCommand: CMD_LINE.test(text) };
  });
}

export function commandName(line) {
  const tok = String(line ?? '').trim().split(/\s+/)[0] ?? '';
  return tok.startsWith('/') ? tok.slice(1).toLowerCase() : '';
}
