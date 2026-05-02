// brains/codex.mjs - local Codex CLI plus an explicit shell operator mode.
//
// Addressed messages with `exec:` are treated as direct operator commands:
//   @codex exec: pwd
//   @codex exec: cd ../project
//
// Other addressed messages are passed to `codex exec` non-interactively.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const name = 'codex';
export const description = 'Local Codex CLI; `exec:` runs shell commands with persistent cwd.';
export const requires = [];

const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const DEFAULT_CODEX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;

export function stateDetail(options = {}) {
  return `cwd: ${options.cwd ?? process.cwd()}`;
}

function stripUserPrefix(message) {
  return String(message ?? '').replace(/^\[[^\]]+\]:\s*/, '').trim();
}

function parseExec(text) {
  const m = text.match(/^exec\s*:\s*([\s\S]*)$/i);
  return m ? m[1].trim() : null;
}

function normalizeCwd(p, base = process.cwd()) {
  if (!p) return resolve(base);
  let out = String(p).trim();
  const msys = out.match(/^\/([a-zA-Z])\/(.*)$/);
  if (msys) out = `${msys[1].toUpperCase()}:/${msys[2]}`;
  if (out === '~') out = homedir();
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = join(homedir(), out.slice(2));
  return isAbsolute(out) ? resolve(out) : resolve(base, out);
}

function unquoteOneArg(s) {
  const t = String(s ?? '').trim();
  if (!t) return '';
  const first = t[0];
  const last = t[t.length - 1];
  if ((first === '"' || first === "'") && last === first) return t.slice(1, -1);
  return t;
}

function parseCd(command) {
  const m = command.match(/^\s*cd(?:\s+([\s\S]*?))?\s*$/);
  if (!m) return null;
  return unquoteOneArg(m[1] ?? '~') || '~';
}

async function assertDirectory(path) {
  const s = await stat(path);
  if (!s.isDirectory()) throw new Error(`not a directory: ${path}`);
}

function hasCommand(command) {
  const probe = process.platform === 'win32'
    ? spawnSync('where.exe', [command], { stdio: 'ignore' })
    : spawnSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
  return probe.status === 0;
}

function shellFor(command) {
  const requested = process.env.EGPT_CODEX_EXEC_SHELL;
  if (requested) {
    if (requested === 'powershell') {
      return {
        command: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      };
    }
    return { command: requested, args: ['-lc', command] };
  }
  if (process.platform === 'win32') {
    if (hasCommand('bash')) return { command: 'bash', args: ['-lc', command] };
    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    };
  }
  return { command: process.env.SHELL || '/bin/sh', args: ['-lc', command] };
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function appendCapped(current, chunk, maxChars) {
  if (current.length >= maxChars) return { text: current, truncated: true };
  const room = maxChars - current.length;
  if (chunk.length <= room) return { text: current + chunk, truncated: false };
  return { text: current + chunk.slice(0, room), truncated: true };
}

async function runCd(command, options) {
  const arg = parseCd(command);
  if (arg === null) return null;

  const oldCwd = normalizeCwd(options.cwd);
  const nextCwd = arg === '-' && options.previousCwd
    ? normalizeCwd(options.previousCwd)
    : normalizeCwd(arg, oldCwd);
  try {
    await assertDirectory(nextCwd);
  } catch (e) {
    return {
      text: `$ ${command}\ncd: ${e.message}`,
      optionsPatch: { cwd: oldCwd },
    };
  }

  return {
    text: `$ ${command}\n${nextCwd}`,
    optionsPatch: { cwd: nextCwd, previousCwd: oldCwd },
  };
}

async function runShell(command, onUpdate, options) {
  const cwd = normalizeCwd(options.cwd);
  await assertDirectory(cwd);

  const cdResult = await runCd(command, { ...options, cwd });
  if (cdResult) {
    onUpdate(cdResult.text);
    return cdResult;
  }

  const timeoutMs = parsePositiveInt(process.env.EGPT_CODEX_EXEC_TIMEOUT_MS, DEFAULT_EXEC_TIMEOUT_MS);
  const maxChars = parsePositiveInt(process.env.EGPT_CODEX_MAX_OUTPUT_CHARS, DEFAULT_MAX_OUTPUT_CHARS);
  const shell = shellFor(command);
  const header = `$ ${command}\n`;

  return new Promise((resolvePromise, reject) => {
    const proc = spawn(shell.command, shell.args, {
      cwd,
      env: { ...process.env, TERM: process.env.TERM || 'dumb' },
      windowsHide: true,
    });

    let output = '';
    let truncated = false;
    let timedOut = false;

    const publish = () => {
      let text = header + output;
      if (truncated) text += '\n[output truncated]';
      onUpdate(text);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch {}
    }, timeoutMs);

    const onData = (chunk) => {
      const appended = appendCapped(output, chunk.toString('utf8'), maxChars);
      output = appended.text;
      truncated = truncated || appended.truncated;
      publish();
    };

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on('close', code => {
      clearTimeout(timer);
      let text = header + output;
      if (truncated) text += '\n[output truncated]';
      if (timedOut) text += `\n[timed out after ${Math.round(timeoutMs / 1000)}s]`;
      else if (code !== 0) text += `\n[exit ${code}]`;
      text = text.replace(/\s+$/g, '');
      resolvePromise({ text, optionsPatch: { cwd } });
    });
  });
}

function codexSpawn(commandArgs) {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'codex.cmd', ...commandArgs],
    };
  }
  return { command: 'codex', args: commandArgs };
}

function extractTextEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (typeof ev.message === 'string' && /message/i.test(ev.type ?? '')) return ev.message;
  if (typeof ev.text === 'string' && /message|delta|output/i.test(ev.type ?? '')) return ev.text;
  if (typeof ev.delta === 'string') return ev.delta;
  if (Array.isArray(ev.content)) {
    return ev.content
      .map(c => typeof c === 'string' ? c : c?.text)
      .filter(Boolean)
      .join('');
  }
  return null;
}

async function runCodex(prompt, onUpdate, options) {
  const cwd = normalizeCwd(options.cwd);
  await assertDirectory(cwd);

  const timeoutMs = parsePositiveInt(process.env.EGPT_CODEX_TIMEOUT_MS, DEFAULT_CODEX_TIMEOUT_MS);
  const tempDir = await mkdtemp(join(tmpdir(), 'egpt-codex-'));
  const lastMessagePath = join(tempDir, 'last-message.txt');
  const args = [
    'exec',
    '--json',
    '--ask-for-approval', 'never',
    '--cd', cwd,
    '--skip-git-repo-check',
    '--output-last-message', lastMessagePath,
    prompt,
  ];
  const cmd = codexSpawn(args);

  try {
    return await new Promise((resolvePromise, reject) => {
      const proc = spawn(cmd.command, cmd.args, {
        cwd,
        env: { ...process.env, TERM: process.env.TERM || 'dumb' },
        windowsHide: true,
      });

      let lineBuf = '';
      let plainOutput = '';
      let assistantText = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try { proc.kill(); } catch {}
      }, timeoutMs);

      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', chunk => {
        lineBuf += chunk;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          let ev;
          try { ev = JSON.parse(t); } catch {
            plainOutput += line + '\n';
            onUpdate(plainOutput);
            continue;
          }
          const text = extractTextEvent(ev);
          if (text) {
            assistantText += text;
            onUpdate(assistantText);
          }
        }
      });
      proc.stderr.on('data', chunk => {
        stderr += chunk.toString('utf8');
      });

      proc.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });

      proc.on('close', async code => {
        clearTimeout(timer);
        let final = '';
        try { final = (await readFile(lastMessagePath, 'utf8')).trim(); } catch {}
        if (!final) final = assistantText.trim() || plainOutput.trim();
        if (!final && stderr.trim()) final = stderr.trim();
        if (timedOut) final = `${final ? final + '\n' : ''}[codex timed out after ${Math.round(timeoutMs / 1000)}s]`;
        else if (code !== 0) final = `${final ? final + '\n' : ''}[codex exit ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}]`;
        resolvePromise({ text: final || '...', optionsPatch: { cwd } });
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function stream({ message }, onUpdate, options = {}) {
  const text = stripUserPrefix(message);
  const execCommand = parseExec(text);
  if (execCommand !== null) {
    if (!execCommand) return { text: 'usage: @codex exec: <command>', optionsPatch: {} };
    return runShell(execCommand, onUpdate, options);
  }
  return runCodex(text, onUpdate, options);
}
