// slash/browse.mjs — open / extract / delegate web pages.
//
// Two modes:
//   via=<op>   delegate the whole task to an operator brain (CDP-driven).
//              No CDP tab is opened by egpt itself; operator's reply
//              flows back to Telegram automatically.
//   (no via)   egpt opens a Chrome tab, waits for the page to settle,
//              extracts body text, and either drops it into the room
//              or injects into @<session>.
//
// /browse [via=<op>] [<url>] ["<instruction>"] [@<session>] [--max <N>] [--keep]

import * as cdp from '../tools/cdp.mjs';

export const meta = {
  cmd: '/browse',
  section: 'BRAINS',
  surface: 'shell',
  usage: '/browse [via=<op>] [<url>] ["<instruction>"] [@<session>] [--max <N>] [--keep]',
  desc: 'fetch and extract a web page (or delegate to an operator brain)',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut, append, setItems, setBusy, setStreaming, setBrowserWaiting
  //   sessions, setSessions
  //   brainForName
  //   runBrainTurn, dispatchToOperator
  //   parseCommandWords
  //   resolveOperatorSession
  //   nextName(prefix, sessions), nextEmoji(sessions)
  //   setDefaultOp, persistDefaultOp        — pin the auto-attached operator
  const { sysOut, append, setItems, setBusy, setStreaming, setBrowserWaiting,
          sessions, setSessions, brainForName,
          runBrainTurn, dispatchToOperator,
          parseCommandWords, resolveOperatorSession,
          nextName, nextEmoji, setDefaultOp, persistDefaultOp } = ctx;

  const words = parseCommandWords(arg);
  if (!words.length) {
    sysOut([
      'usage: /browse [via=<op>] [<url>] ["<instruction>"] [@<session>] [--max <N>] [--keep]',
      '  via=<op>     delegate to operator (CDP automation via browser-tools.mjs)',
      '               url optional — operator determines where to go if omitted',
      '               instruction = the task; result flows to Telegram automatically',
      '  (no via)     egpt opens tab, extracts text, closes it',
      '               url required; @<session> injects text into that session',
      '               --max N: max chars (default 60000)  --keep: leave tab open',
      'examples:',
      '  /browse via=codex1 "search google for bongo drum inventors, return 3 results"',
      '  /browse via=ccode1 amazon.com "find cheapest bongo drums: image; price; link"',
      '  /browse https://en.wikipedia.org/wiki/Bongo_drum @cgpt1 "summarize history"',
    ].join('\n'));
    return true;
  }

  // Parse: collect via=, url, @target, --flags, and everything else = instruction.
  let viaOp = null, browseUrl = null, browseTarget = null;
  let browseInstruction = [], maxChars = 60000, keepTab = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith('via=')) { viaOp = w.slice(4); continue; }
    if (!browseUrl && /^https?:\/\//.test(w)) { browseUrl = w; continue; }
    // Accept bare domains / paths: amazon.com, google.com/search?q=…
    if (!browseUrl && /^[a-zA-Z0-9][-a-zA-Z0-9.]*\.[a-zA-Z]{2,}(\/|$)/.test(w)) {
      browseUrl = 'https://' + w; continue;
    }
    if (w.startsWith('@')) { browseTarget = w.slice(1); continue; }
    if (w === '--max' && i + 1 < words.length) {
      maxChars = Math.max(1000, parseInt(words[++i], 10) || 60000);
      continue;
    }
    if (w === '--keep') { keepTab = true; continue; }
    browseInstruction.push(w);
  }
  const instruction = browseInstruction.join(' ').trim() || null;

  // instruction-only (no URL, no via=) always needs an operator.
  let extraSessions = {};
  if (!browseUrl && !viaOp) {
    if (!instruction) {
      sysOut('!! /browse: provide a URL, an instruction, or via=<op>');
      return true;
    }
    viaOp = resolveOperatorSession(null, sessions);
    if (!viaOp) {
      // No operator in room — auto-attach a new codex and make it default.
      const name  = nextName('codex', sessions);
      const emoji = nextEmoji(sessions);
      const entry = { brain: 'codex', options: { cwd: process.cwd() }, emoji };
      extraSessions[name] = entry;
      setSessions(s => ({ ...s, [name]: entry }));
      setDefaultOp(name);
      persistDefaultOp(name);
      sysOut(`attached ${emoji} ${name} (codex) — new default operator`);
      viaOp = name;
    } else {
      sysOut(`(using operator: ${viaOp})`);
    }
  }

  // via=operator mode: delegate the whole task.
  if (viaOp) {
    // Merge freshly attached sessions so lookups don't depend on React re-render.
    const effectiveSessions = Object.keys(extraSessions).length
      ? { ...sessions, ...extraSessions }
      : sessions;
    viaOp = resolveOperatorSession(viaOp, effectiveSessions);
    if (!viaOp || !effectiveSessions[viaOp]) {
      sysOut(`!! /browse: session "${viaOp ?? '?'}" not found`);
      return true;
    }
    const browseTask = [
      instruction ?? 'fetch the page and summarize its main content',
      ...(browseUrl ? [`URL: ${browseUrl}`] : []),
    ].join('\n');
    const browseVars = { task: browseTask, cdp_host: await cdp.cdpHost() };
    const note = `[browse via ${viaOp}]${browseUrl ? ' ' + browseUrl : ''}${instruction ? '\n  ' + instruction : ''}`;
    setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: note }]);
    await append('system', note);
    setBusy(true);
    try { await dispatchToOperator('browse', browseVars, viaOp, effectiveSessions); }
    finally { setBusy(false); setBrowserWaiting(null); }
    return true;
  }

  // Direct CDP extraction mode.
  if (browseTarget && !sessions[browseTarget]) {
    sysOut(`!! /browse: no session named "${browseTarget}"`);
    return true;
  }

  setBusy(true);
  setStreaming({ author: 'browse', text: `fetching ${browseUrl}…` });
  let browseResult = null;
  try {
    let lastProg = '';
    browseResult = await cdp.browseTab(browseUrl, {
      maxChars,
      onProgress: (href, len, ready) => {
        const t = `${href}\n  ${ready} · ${len.toLocaleString()} chars`;
        if (t !== lastProg) { lastProg = t; setStreaming({ author: 'browse', text: t }); }
      },
    });
    setStreaming(null);
    if (!keepTab) cdp.closeTab(browseResult.targetId).catch(e => console.error(`!! browse.mjs:[promise-catch] ${e?.message ?? e}`));

    const chars = browseResult.text.length;
    const header = `[browse: ${browseResult.title || browseResult.url}]\n${browseResult.url}  (${chars.toLocaleString()} chars)`;
    const body = browseResult.text.trim();
    const fullContent = `${header}\n\n${body}`;

    if (chars < 300) {
      sysOut(`(only ${chars} chars extracted — dynamic/JS-heavy pages need /browse via=<op> to interact)`);
    }

    if (browseTarget) {
      const note = `[browsed ${browseResult.url} (${chars.toLocaleString()} chars)] -> injecting into ${browseTarget}`;
      setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: note }]);
      await append('system', note);
      const isCDP = !!brainForName(sessions[browseTarget]?.brain)?.urlMatch;
      const msg = isCDP
        ? { message: fullContent, ask: instruction }
        : (instruction ? `${fullContent}\n\n---\n${instruction}` : fullContent);
      await runBrainTurn(browseTarget, msg);
    } else {
      const note = instruction ? `${fullContent}\n\n---\n${instruction}` : fullContent;
      await append('system', note);
      setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: note }]);
    }
  } catch (e) {
    setStreaming(null);
    if (browseResult && !keepTab) cdp.closeTab(browseResult.targetId).catch(e => console.error(`!! browse.mjs:[promise-catch] ${e?.message ?? e}`));
    sysOut(`!! browse: ${e.message}`);
  } finally {
    setBusy(false);
  }
  return true;
}
