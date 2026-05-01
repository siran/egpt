// brains/claude-code.mjs — stateless subprocess brain (full history each turn)
import { spawn } from 'node:child_process';

export const name = 'claude-code';
export const description = 'Local `claude` CLI as subprocess. Full file is sent each turn.';
export const requires = []; // no required options

export function stream({ history }, onUpdate, _options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

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
    proc.on('error', err => reject(err.code === 'ENOENT'
      ? new Error('claude not found on PATH')
      : err));

    proc.stdin.write(history);
    proc.stdin.end();
  });
}
