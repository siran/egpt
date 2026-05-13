// slash/send-file.mjs — send a (possibly prepared) file excerpt to a brain.
//
// Two modes:
//   direct       /send-file <prepared.txt> @target           — paste verbatim
//   via=<op>     /send-file <source> @target via=<op> ...    — operator prepares first
//
// The "prepared" file is a deterministic extract: an operator (codex /
// claude-code) reads the source, applies the instruction, and writes
// the result to ~/.egpt/prepared/. Then egpt pastes that prepared
// content into the target brain. Splits the LLM-bound work into two
// independent turns so the target sees a clean, instruction-conditioned
// excerpt instead of the raw file.

import { stat, readFile } from 'node:fs/promises';

export const meta = {
  cmd: '/send-file',
  section: 'BRAINS',
  surface: 'shell',
  usage: '/send-file <path> @<target> [via=<op>] [--ask "..."] [--max <N>] [--all]',
  desc: 'send a file excerpt to a brain (via=<op> to prepare; direct paste otherwise)',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut, dp, append, setItems, setBusy
  //   sessions, runBrainTurn
  //   parseSendFileArgs, sendFileUsage
  //   directPreparedPathFromSource
  //   quoteRoomArg
  //   defaultOperatorSession, assertOperatorSession
  //   preparedFilePathFor, sendFilePrepVars
  //   buildPasteFileMessage, parsePositiveLimit, DEFAULT_PASTE_FILE_MAX_CHARS
  //   dispatchToOperator
  const { sysOut, dp, append, setItems, setBusy,
          sessions, runBrainTurn,
          parseSendFileArgs, sendFileUsage,
          directPreparedPathFromSource, quoteRoomArg,
          defaultOperatorSession, assertOperatorSession,
          preparedFilePathFor, sendFilePrepVars,
          buildPasteFileMessage, parsePositiveLimit,
          DEFAULT_PASTE_FILE_MAX_CHARS, dispatchToOperator } = ctx;

  let parsed;
  try { parsed = parseSendFileArgs(arg); }
  catch (e) { sysOut(e.message); return true; }

  if (!sessions[parsed.targetName]) {
    sysOut(`no registered target session "@${parsed.targetName}"`);
    return true;
  }

  // Direct mode: if the source path looks like a pre-prepared file
  // (and no instruction was given), paste it verbatim without
  // round-tripping through an operator.
  let directPreparedPath = null;
  try {
    directPreparedPath = !parsed.instructionProvided
      ? directPreparedPathFromSource(parsed.path)
      : null;
  } catch (e) { sysOut(`!! ${e.message}`); return true; }

  if (directPreparedPath) {
    try {
      const info = await stat(directPreparedPath);
      if (!info.isFile()) {
        sysOut(`prepared path is not a file: ${dp(directPreparedPath)}`);
        return true;
      }
      const prepared = await readFile(directPreparedPath, 'utf8');
      if (!prepared.trim()) {
        sysOut(`prepared file is empty: ${directPreparedPath}`);
        return true;
      }
      const maxChars = parsed.maxProvided ? parsed.maxChars : 0;
      if (maxChars > 0 && prepared.length > maxChars) {
        const askSuffix = parsed.ask ? ` --ask ${quoteRoomArg(parsed.ask)}` : '';
        sysOut(
          `not pasted into @${parsed.targetName}: prepared file is ${prepared.length} chars, over --max ${maxChars}. It is saved at:\n` +
          `${dp(directPreparedPath)}\n` +
          `Use --all to send it:\n` +
          `/send-file ${quoteRoomArg(directPreparedPath)} @${parsed.targetName} --all${askSuffix}`,
        );
        return true;
      }

      const sendNote =
        `[send-file pasted prepared file into ${parsed.targetName}]\n` +
        `source: ${directPreparedPath}\n` +
        `chars: ${prepared.length}\n` +
        `mode: prepared-file direct` +
        (parsed.ask ? '\nmode: paste + ask' : '');
      await append('system', sendNote);
      setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: sendNote }]);

      setBusy(true);
      try {
        await runBrainTurn(parsed.targetName, buildPasteFileMessage({
          path: directPreparedPath,
          originalChars: prepared.length,
          excerpt: prepared,
          rangeLabel: 'prepared file',
        }, parsed));
      } finally { setBusy(false); }
      sysOut(`sent ${prepared.length} prepared chars to ${parsed.targetName}`);
    } catch (e) {
      setBusy(false);
      sysOut(`!! ${e.message}\n\n${sendFileUsage()}`);
    }
    return true;
  }

  // Operator-prepared mode: ask <via> to prepare, then paste.
  let via = parsed.viaSpec;
  if (!via) {
    via = defaultOperatorSession(sessions);
    if (!via) {
      sysOut('no unambiguous local operator session; use via=codex1 or via=ccode1');
      return true;
    }
  }
  try { assertOperatorSession(via, sessions); }
  catch (e) { sysOut(`!! ${e.message}`); return true; }

  try {
    const preparedPath = await preparedFilePathFor(via, parsed.path);
    const prepNote =
      `[send-file preparing via ${via}]\n` +
      `source: ${parsed.path ?? '(operator will infer)'}\n` +
      `target: @${parsed.targetName}\n` +
      `instruction: ${parsed.instruction}\n` +
      `prepared path: ${preparedPath}`;
    await append('system', prepNote);
    setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: prepNote }]);

    setBusy(true);
    try {
      await dispatchToOperator(
        'send-file',
        sendFilePrepVars({ sourcePath: parsed.path, preparedPath, targetName: parsed.targetName, instruction: parsed.instruction }),
        via,
      );
    } finally { setBusy(false); }

    const prepared = await readFile(preparedPath, 'utf8');
    const maxChars = parsePositiveLimit(parsed.maxChars, DEFAULT_PASTE_FILE_MAX_CHARS);
    if (!prepared.trim()) {
      sysOut(`${via} created an empty prepared file: ${preparedPath}`);
      return true;
    }
    if (maxChars > 0 && prepared.length > maxChars) {
      const askSuffix = parsed.ask ? ` --ask ${quoteRoomArg(parsed.ask)}` : '';
      sysOut(
        `not pasted into @${parsed.targetName}: prepared file is ${prepared.length} chars, over --max ${maxChars}. It is saved at:\n` +
        `${dp(preparedPath)}\n` +
        `To paste exactly this prepared file, run:\n` +
        `/send-file ${quoteRoomArg(preparedPath)} @${parsed.targetName}${askSuffix}\n` +
        `Or rerun the preparation with --all or a narrower instruction.`,
      );
      return true;
    }

    const sendNote =
      `[send-file pasted prepared excerpt into ${parsed.targetName}]\n` +
      `via: ${via}\n` +
      `source: ${parsed.path ?? '(operator inferred source)'}\n` +
      `instruction: ${parsed.instruction}\n` +
      `prepared: ${preparedPath}\n` +
      `chars: ${prepared.length}`;
    await append('system', sendNote);
    setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: sendNote }]);

    setBusy(true);
    try {
      await runBrainTurn(parsed.targetName, buildPasteFileMessage({
        path: `${parsed.path ?? '(operator inferred source)'} (prepared by ${via} at ${preparedPath})`,
        originalChars: prepared.length,
        excerpt: prepared,
        rangeLabel: `prepared by ${via}: ${parsed.instruction}`,
      }, parsed));
    } finally { setBusy(false); }
    sysOut(`sent ${prepared.length} prepared chars from ${via} to ${parsed.targetName}`);
  } catch (e) {
    setBusy(false);
    sysOut(`!! ${e.message}\n\n${sendFileUsage()}`);
  }
  return true;
}
