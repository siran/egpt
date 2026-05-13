// slash/summarize.mjs — summarize the room via a fresh, neutral agent.
//
// /summarize [all|last <N>] <name> [<brain>]
// /cdp-summarize ...        force CDP path (default: chatgpt-cdp → claude-cdp)
// /operator-summarize ...   force fresh `claude --print` subprocess
//
// The summarizer is always a fresh agent — never a room participant —
// so it has no bias from being inside the conversation it's summarizing.

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import * as cdp from '../tools/cdp.mjs';
import { buildCommandPrompt } from '../tools/template.mjs';

export const meta = [
  { cmd: '/summarize',          section: 'BRAINS', surface: 'shell',
    usage: '/summarize [all|last <N>] <name> [<brain>]',
    desc: 'summarize the room via a fresh CDP brain or ccode (saves to ~/.egpt/summaries)' },
  { cmd: '/cdp-summarize',      section: 'BRAINS', surface: 'shell',
    usage: '/cdp-summarize ...', desc: 'force CDP path for /summarize' },
  { cmd: '/operator-summarize', section: 'BRAINS', surface: 'shell',
    usage: '/operator-summarize ...', desc: 'force fresh `claude --print` subprocess' },
];

export async function run({ cmd, arg, ctx }) {
  // ctx keys consumed:
  //   sysOut, dp, getFile
  //   setBusy, setStreaming
  //   parseMessages, isSafeName
  //   getShowPrompts
  //   ensureSummariesDir, summaryPath
  //   BRAINS
  const { sysOut, dp, getFile, setBusy, setStreaming,
          parseMessages, isSafeName, getShowPrompts,
          ensureSummariesDir, summaryPath, BRAINS } = ctx;

  const parts = arg.split(/\s+/).filter(Boolean);
  let scope = 'all', scopeN = null, i = 0;
  if (parts[i] === 'all') { scope = 'all'; i++; }
  else if (parts[i] === 'last' && /^\d+$/.test(parts[i+1] ?? '')) {
    scope = 'last'; scopeN = parseInt(parts[i+1], 10); i += 2;
  }
  const name = parts[i++];
  let brainKey = parts[i];

  if (!isSafeName(name ?? '')) {
    sysOut(
      'usage: ' + cmd + ' [all|last <N>] <name> [<brain>]\n' +
      '  default scope: all room messages\n' +
      '  default brain: ' + (cmd === '/operator-summarize'
        ? 'fresh ccode subprocess'
        : 'fresh chatgpt-cdp tab -> claude-cdp -> fresh ccode') + '\n' +
      '  saves to ~/.egpt/summaries/<name>.md'
    );
    return true;
  }

  try {
    await ensureSummariesDir();
    const FILE = getFile();
    const text = await readFile(FILE, 'utf8');
    const allTurns = parseMessages(text).filter(t => t.author !== 'system');
    if (!allTurns.length) { sysOut('(nothing to summarize — room is empty)'); return true; }
    const turns = scope === 'last' && scopeN ? allTurns.slice(-scopeN) : allTurns;
    const formatted = turns.map(t => `[${t.author}]: ${t.body}`).join('\n\n');
    const scopeLabel = scope === 'last' ? `last ${scopeN}` : 'all';
    const promptResult = await buildCommandPrompt('summarize', { conversation: formatted });
    const prompt = promptResult?.text ??
      `Please summarize this conversation faithfully. Preserve participants, key decisions, and any open questions or loose threads. Aim for under 600 words. Plain markdown, no preamble. Output ONLY the summary text — no "Here is the summary:" boilerplate.\n\n---\n\n${formatted}`;
    if (getShowPrompts()) {
      const bar = '─'.repeat(53);
      sysOut(`[prompt -> summarize]\n${bar}\n${prompt.slice(0, 800)}${prompt.length > 800 ? '\n...[truncated for display]' : ''}\n${bar}`);
    }

    // Pick brain
    const forceOperator = cmd === '/operator-summarize';
    if (forceOperator) brainKey = null;
    if (!brainKey && !forceOperator) {
      if (await cdp.isRunning()) {
        if (BRAINS['chatgpt-cdp']) brainKey = 'chatgpt-cdp';
        else if (BRAINS['claude-cdp']) brainKey = 'claude-cdp';
      }
    }

    let summary;
    let summarizer;
    if (brainKey && BRAINS[brainKey]?.homeUrl) {
      summarizer = `${brainKey} (fresh tab)`;
      sysOut(`opening a fresh ${brainKey} tab for summarization (${scopeLabel} of ${allTurns.length} turns)…`);
      const targetId = await cdp.openTab(BRAINS[brainKey].homeUrl);
      await new Promise(r => setTimeout(r, 3500)); // wait for the page to mount textarea
      setBusy(true);
      setStreaming({ author: summarizer, text: '' });
      try {
        summary = await BRAINS[brainKey].stream(
          { history: '', message: prompt },
          partial => setStreaming({ author: summarizer, text: partial }),
          { targetId },
        );
      } finally { setStreaming(null); setBusy(false); }
    } else {
      summarizer = 'fresh ccode';
      sysOut(`asking a fresh ccode subprocess to summarize (${scopeLabel} of ${allTurns.length} turns)…`);
      setBusy(true);
      try {
        summary = await new Promise((resolve, reject) => {
          const proc = spawn('claude', ['--print', '--output-format', 'json'], { stdio: ['pipe', 'pipe', 'pipe'] });
          let out = '', err = '';
          proc.stdout.on('data', c => out += c);
          proc.stderr.on('data', c => err += c);
          proc.on('close', code => {
            if (code !== 0) return reject(new Error(`claude exit ${code}: ${err.trim() || 'no stderr'}`));
            try { resolve((JSON.parse(out).result ?? out).trim()); }
            catch { resolve(out.trim()); }
          });
          proc.on('error', e => reject(e.code === 'ENOENT' ? new Error('claude not found on PATH') : e));
          proc.stdin.write(prompt); proc.stdin.end();
        });
      } finally { setBusy(false); }
    }

    if (!summary) { sysOut('(empty summary)'); return true; }
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const body = `# ${name}\n\n_Summarized ${stamp} by ${summarizer} from ${FILE}_\n_Scope: ${scopeLabel}${scope === 'last' ? ` (of ${allTurns.length} total)` : ''}_\n\n---\n\n${summary}\n`;
    await writeFile(summaryPath(name), body);
    sysOut(`saved -> ${dp(summaryPath(name))}  (${summary.length} chars)`);
  } catch (e) {
    setBusy(false);
    sysOut(`!! ${e.message}`);
  }
  return true;
}
