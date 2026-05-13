// slash/paste-file.mjs — paste a deterministic file excerpt into a brain.
//
// Like /send-file but skips the operator-prep step: reads bytes off
// disk directly, with optional --range / --max constraints, and pastes
// straight into the target.

export const meta = [
  { cmd: '/paste-file',  section: 'BRAINS', surface: 'shell',
    usage: '/paste-file <path> @<target> [--ask "..."] [--max <N>] [--range A:B]',
    desc: 'paste a deterministic file excerpt into a brain' },
  { cmd: '/inject-file', section: 'BRAINS', surface: 'shell',
    usage: '/inject-file ...', desc: 'alias for /paste-file' },
  { cmd: '/paste',       section: 'BRAINS', surface: 'shell',
    usage: '/paste ...',       desc: 'alias for /paste-file' },
];

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut, append, setItems, setBusy
  //   sessions, runBrainTurn
  //   parsePasteFileArgs, resolveAddressedSession,
  //   readPasteFilePayload, pasteFileUsage,
  //   buildPasteFileMessage
  const { sysOut, append, setItems, setBusy,
          sessions, runBrainTurn,
          parsePasteFileArgs, resolveAddressedSession,
          readPasteFilePayload, pasteFileUsage,
          buildPasteFileMessage } = ctx;

  let parsed;
  try { parsed = parsePasteFileArgs(arg); }
  catch (e) { sysOut(e.message); return true; }

  const target = resolveAddressedSession(parsed.targetSpec, sessions);
  if (!target) {
    sysOut(`no session or unambiguous brain named "${parsed.targetSpec}"`);
    return true;
  }

  try {
    const payload = await readPasteFilePayload(parsed);
    if (!payload.excerpt.trim()) {
      sysOut('selected file excerpt is empty');
      return true;
    }
    const note =
      `[pasted file excerpt into ${target}]\n` +
      `path: ${payload.path}\n` +
      `range: ${payload.rangeLabel}\n` +
      `chars: ${payload.excerpt.length} of ${payload.originalChars}` +
      (parsed.ask ? '\nmode: paste + ask' : '\nmode: raw paste');
    await append('system', note);
    setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: note }]);
    setBusy(true);
    try {
      await runBrainTurn(target, buildPasteFileMessage(payload, parsed));
    } finally { setBusy(false); }
    sysOut(`pasted ${payload.excerpt.length} chars into ${target}`);
  } catch (e) {
    setBusy(false);
    sysOut(`!! ${e.message}\n\n${pasteFileUsage()}`);
  }
  return true;
}
