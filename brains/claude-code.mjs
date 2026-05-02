// brains/claude-code.mjs — local `claude` CLI as subprocess.
// Two modes:
//   - default:        each turn is a fresh `claude --print`, full conversation
//                     file piped to stdin (stateless, brain re-reads each time).
//   - resume:         when options.sessionId is set, runs `claude --resume <id>`
//                     and pipes only the new user message; claude has the session
//                     history in its JSONL already. This *extends* an existing
//                     Claude Code session rather than re-imitating it.
import { spawn } from 'node:child_process';

export const name = 'claude-code';
export const description = 'Local `claude` CLI; optionally --resume to extend an existing session.';
export const requires = [];

// MSYS2/Cygwin paths like "/c/Users/an/src/foo" don't work as Node spawn cwd
// on Windows. Translate them to "C:/Users/an/src/foo".
function normalizeCwd(p) {
  if (!p) return p;
  const m = p.match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p;
}

export function stream({ history, message }, onUpdate, options = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ];
    const isResume = !!options.sessionId;
    if (isResume) args.push('--resume', options.sessionId);

    const spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'] };
    const cwd = normalizeCwd(options.cwd);
    if (cwd) spawnOpts.cwd = cwd;

    const proc = spawn('claude', args, spawnOpts);

    let buf = '';
    let acc = '';
    let finalText = null;
    let stderrBuf = '';

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let ev;
        try { ev = JSON.parse(t); } catch { continue; }

        if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') {
          const d = ev.event.delta;
          if (d?.type === 'text_delta' && typeof d.text === 'string') {
            acc += d.text;
            onUpdate(acc);
          }
        } else if (ev.type === 'assistant' && ev.message?.content) {
          const text = ev.message.content
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('');
          if (text && !acc) { acc = text; onUpdate(acc); }
        } else if (ev.type === 'result') {
          if (ev.subtype === 'success' && typeof ev.result === 'string') {
            finalText = ev.result;
          } else if (ev.subtype && ev.subtype !== 'success') {
            return reject(new Error(`claude: ${ev.subtype}${ev.error ? ' — ' + ev.error : ''}`));
          }
        }
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', c => (stderrBuf += c));

    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`claude exit ${code}: ${stderrBuf.trim() || 'no stderr'}`));
      resolve(finalText ?? acc);
    });
    proc.on('error', err => {
      if (err.code === 'ENOENT') {
        // ENOENT can mean either the binary or the cwd is missing. Disambiguate.
        const msg = cwd
          ? `spawn ENOENT: claude binary or cwd not found. cwd=${cwd}, original options.cwd=${options.cwd ?? '(none)'}`
          : 'claude not found on PATH';
        return reject(new Error(msg));
      }
      reject(err);
    });

    // Resume mode: send only the new user turn (claude has the session in JSONL).
    // Default mode: send the full conversation file (claude is stateless per call).
    proc.stdin.write(isResume ? (message ?? '') : (history ?? ''));
    proc.stdin.end();
  });
}
