#!/usr/bin/env node
// Probe whether whisper-cli streams stdout incrementally or buffers.
// Usage: node tools/probe-whisper-stream.mjs <wav-path>
// Prints each stdout line with arrival timestamp so we can see if
// segments emit as whisper processes (streaming, good) or all-at-end
// (buffered, fallback to JSON-polling needed).

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const WHISPER = 'C:\\Users\\an\\bin\\whisper.cpp\\whisper-cli.exe';
const MODEL   = 'C:\\Users\\an\\bin\\whisper.cpp\\models\\ggml-large-v3.bin';
const wav     = process.argv[2];

if (!wav) { console.error('usage: probe-whisper-stream.mjs <wav-path>'); process.exit(2); }

const args = ['-m', MODEL, '-f', wav, '-l', 'es', '--max-len', '30'];
const t0 = performance.now();
const proc = spawn(WHISPER, args, { stdio: ['ignore', 'pipe', 'pipe'] });

let buf = '';
proc.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).replace(/\r$/, '');
    buf = buf.slice(idx + 1);
    const t = (performance.now() - t0).toFixed(0).padStart(6, ' ');
    console.log(`[+${t}ms] ${line}`);
  }
});
proc.stderr.on('data', (d) => process.stderr.write(d));
proc.on('exit', (code) => {
  const t = (performance.now() - t0).toFixed(0);
  console.log(`[+${t}ms] [exit ${code}]`);
});
