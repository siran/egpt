#!/usr/bin/env node
// Probe whether whisper-cli writes its --output-srt file incrementally
// as it processes (good — we can tail it for streaming chunks), or
// writes it all at the end (bad — fall back to ffmpeg chunking).

import { spawn } from 'node:child_process';
import { stat, readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const WHISPER = 'C:\\Users\\an\\bin\\whisper.cpp\\whisper-cli.exe';
const MODEL   = 'C:\\Users\\an\\bin\\whisper.cpp\\models\\ggml-large-v3.bin';
const wav     = process.argv[2];
if (!wav) { console.error('usage: probe-whisper-srt.mjs <wav-path>'); process.exit(2); }

const t0 = performance.now();
const srtPath = wav + '.srt';

const args = ['-m', MODEL, '-f', wav, '-l', 'es', '--output-srt', '--max-len', '30', '--no-prints'];
const proc = spawn(WHISPER, args, { stdio: ['ignore', 'pipe', 'pipe'] });

// Poll the SRT file every 500ms and report size + last segment.
let lastSize = 0;
let lastBody = '';
const poll = setInterval(async () => {
  try {
    const st = await stat(srtPath);
    if (st.size === lastSize) return;
    lastSize = st.size;
    const body = await readFile(srtPath, 'utf8');
    const newPart = body.slice(lastBody.length);
    lastBody = body;
    const t = (performance.now() - t0).toFixed(0).padStart(6, ' ');
    console.log(`[+${t}ms] srt size=${st.size}B  new=${JSON.stringify(newPart.slice(0, 80))}${newPart.length > 80 ? '…' : ''}`);
  } catch (e) {
    // file doesn't exist yet — that's fine
  }
}, 500);

proc.on('exit', (code) => {
  clearInterval(poll);
  const t = (performance.now() - t0).toFixed(0);
  console.log(`[+${t}ms] [exit ${code}]`);
});
proc.stderr.on('data', d => process.stderr.write(d));
