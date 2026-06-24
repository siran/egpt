// brains/codex.mjs - local Codex CLI plus an explicit shell operator mode.
//
// Addressed messages with `exec:` are treated as direct operator commands:
//   @codex exec: pwd
//   @codex exec: cd ../project
//
// Other addressed messages are passed to `codex exec` non-interactively.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { buildCommandPrompt } from '../../src/tools/template.mjs';

export const name = 'codex';
export const description = 'Local Codex CLI; `exec:` runs shell commands with persistent cwd.';
export const requires = [];

const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const DEFAULT_CODEX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_CODEX_REASONING_EFFORT = 'low';
const CODEX_LOG_DIR = join(homedir(), '.egpt', 'logs', 'codex');
// Messages that begin with one of these markers are operator tasks
// (browse, send-file, etc.) and trigger the codex-task template + bumped effort.
const TASK_MARKER_RE = /^\[(?:browse|send-file|file)\s+task\b/i;

export function stateDetail(options = {}) {
  const parts = [`cwd: ${options.cwd ?? process.cwd()}`];
  if (options.model) parts.push(`model: ${options.model}`);
  parts.push(`effort: ${codexReasoningEffort(options)}`);
  if (options.sessionId) parts.push(`thread: ${options.sessionId}`);
  if (options.logPath) parts.push(`log: ${options.logPath}`);
  return parts.join(' | ');
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

function codexReasoningEffort(options = {}) {
  const raw = options.reasoningEffort ?? process.env.EGPT_CODEX_REASONING_EFFORT ?? DEFAULT_CODEX_REASONING_EFFORT;
  return raw === 'minimal' || raw === 'minimum' || raw === 'min' ? 'low' : raw;
}

function codexModelArgs(options = {}) {
  return options.model ? ['-m', String(options.model)] : [];
}

function codexServiceTierArgs(options = {}) {
  const raw = options.serviceTier ?? options.service_tier;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const tier = raw.trim();
  // Values are passed as TOML via -c. Keep this config surface token-only.
  if (!/^[A-Za-z0-9._-]+$/.test(tier)) return [];
  const featureArgs = tier.toLowerCase() === 'fast' ? ['--enable', 'fast_mode'] : [];
  return [...featureArgs, '-c', `service_tier="${tier}"`];
}

export function codexConfigArgs(options = {}) {
  const effort = options.reasoningEffort ?? codexReasoningEffort(options);
  return [
    '-c', `model_reasoning_effort="${effort}"`,
    ...codexServiceTierArgs(options),
  ];
}

function safeName(name) {
  return String(name || 'codex').replace(/[^A-Za-z0-9._-]+/g, '_');
}

async function ensureLogPath(options) {
  if (options.logPath) return options.logPath;
  await mkdir(CODEX_LOG_DIR, { recursive: true });
  return join(CODEX_LOG_DIR, `${safeName(options.sessionName)}.jsonl`);
}

function logLine(path, value) {
  if (!path) return;
  const line = typeof value === 'string' ? value : JSON.stringify(value);
  void appendFile(path, line.replace(/\r?\n$/, '') + '\n').catch(e => console.error(`!! codex.mjs:[promise-catch] ${e?.message ?? e}`));
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
    logLine(options.logPath, { type: 'exec.cd.error', command, error: e.message, cwd: oldCwd });
    return {
      text: `$ ${command}\ncd: ${e.message}`,
      optionsPatch: { cwd: oldCwd, ...(options.logPath ? { logPath: options.logPath } : {}) },
    };
  }

  logLine(options.logPath, { type: 'exec.cd', command, cwd: nextCwd, previousCwd: oldCwd });
  return {
    text: `$ ${command}\n${nextCwd}`,
    optionsPatch: { cwd: nextCwd, previousCwd: oldCwd, ...(options.logPath ? { logPath: options.logPath } : {}) },
  };
}

async function runShell(command, onUpdate, options) {
  const cwd = normalizeCwd(options.cwd);
  await assertDirectory(cwd);
  const logPath = await ensureLogPath(options);

  const cdResult = await runCd(command, { ...options, cwd, logPath });
  if (cdResult) {
    onUpdate(cdResult.text);
    return cdResult;
  }

  const timeoutMs = parsePositiveInt(process.env.EGPT_CODEX_EXEC_TIMEOUT_MS, DEFAULT_EXEC_TIMEOUT_MS);
  const maxChars = parsePositiveInt(process.env.EGPT_CODEX_MAX_OUTPUT_CHARS, DEFAULT_MAX_OUTPUT_CHARS);
  const shell = shellFor(command);
  const header = `$ ${command}\n`;
  logLine(logPath, { type: 'exec.start', command, cwd });

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
      const text = chunk.toString('utf8');
      logLine(logPath, { type: 'exec.output', command, text });
      const appended = appendCapped(output, text, maxChars);
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
      logLine(logPath, { type: 'exec.close', command, code, timedOut });
      resolvePromise({ text, optionsPatch: { cwd, logPath } });
    });
  });
}

function codexSpawn(commandArgs) {
  if (process.platform === 'win32') {
    const native = findNativeCodexExecutable();
    if (native) return { command: native, args: commandArgs };
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'codex.cmd', ...commandArgs],
    };
  }
  return { command: 'codex', args: commandArgs };
}

function findNativeCodexExecutable() {
  const candidates = [
    process.env.EGPT_CODEX_BIN,
    process.env.CODEX_CLI_PATH,
    process.env.APPDATA
      ? join(
          process.env.APPDATA,
          'npm',
          'node_modules',
          '@openai',
          'codex',
          'node_modules',
          '@openai',
          process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64',
          'vendor',
          process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc',
          'bin',
          'codex.exe',
        )
      : null,
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

function extractTextEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') return ev.item.text ?? null;
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

async function buildCodexPrompt({ history, message }, options) {
  const text = stripUserPrefix(message);
  const sessionName = options.sessionName ?? 'codex';

  // Task messages (from /browse via=op, /send-file, etc.) use commands/codex-task.md.
  // They arrive without a thread and start with a bracketed task marker.
  if (!options.sessionId && TASK_MARKER_RE.test(text)) {
    const result = await buildCommandPrompt('codex-task', {
      session_name:     sessionName,
      reasoning_effort: codexReasoningEffort(options),
      cwd:              options.cwd ?? process.cwd(),
      task:             text,
    });
    if (result) return result.text;
    return text; // fallback: raw task text (template file missing)
  }

  if (options.sessionId) {
    return [
      `[${options.userName ?? 'egptbot'}]: ${text}`,
      '',
      `Reply as ${sessionName} in the egpt room.`,
      `Codex thread id for this egpt session: ${options.sessionId}`,
      `Configured reasoning effort for this invocation: ${codexReasoningEffort(options)}`,
      `Current egpt cwd for this session: ${options.cwd ?? process.cwd()}`,
    ].join('\n');
  }
  return [
    `Reply as ${sessionName} in an egpt room.`,
    `Configured reasoning effort for this invocation: ${codexReasoningEffort(options)}`,
    `Current user message: [${options.userName ?? 'egptbot'}]: ${text}`,
    `Answer that current message directly. If it is a greeting, just greet back briefly.`,
    `If there is nothing useful to add, reply with exactly "...".`,
  ].join('\n');
}

// Per-personality tool scoping for codex (task #25, 2026-05-22).
//
// Codex's tool model is bypass-or-sandbox, not per-tool-name like Claude.
// We map sessionOpts.allowedTools (set by dispatch.mjs from the contact's
// personality frontmatter) to codex's trust flag:
//   allowedTools === 'all' / '*' / undefined  → --dangerously-bypass-approvals-and-sandbox
//   anything else (array, even empty)         → no bypass (sandboxed)
//
// Net: system-personality contacts run codex with full exec/write power;
// default-personality contacts run codex sandboxed (writes / shell-exec
// require approvals that headless mode can't grant — effectively read-
// only, the analog of allowedTools=[Read,Grep,Glob] for Claude brains).
// The env override EGPT_CODEX_TRUST=0 still forces sandbox regardless.
//
// Exported so brain unit tests can assert the mapping without spawning
// the codex CLI.
export function codexTrustArgs(allowedTools, envTrust) {
  const wantBypass = (allowedTools === undefined || allowedTools === 'all' || allowedTools === '*');
  if (!wantBypass) return [];
  if (envTrust === '0') return [];
  return ['--dangerously-bypass-approvals-and-sandbox'];
}

function codexAddDirArgs(addDirs) {
  if (!Array.isArray(addDirs)) return [];
  const args = [];
  for (const d of addDirs) {
    if (d && typeof d === 'string') args.push('--add-dir', d);
  }
  return args;
}

export function codexPermissionArgs({ allowedTools, addDirs } = {}, envTrust) {
  const trustArgs = codexTrustArgs(allowedTools, envTrust);
  if (trustArgs.length) return trustArgs;
  return ['--sandbox', 'workspace-write', ...codexAddDirArgs(addDirs)];
}

async function runCodex(turn, onUpdate, options) {
  const cwd = normalizeCwd(options.cwd);
  await assertDirectory(cwd);
  const logPath = await ensureLogPath(options);
  const prompt = await buildCodexPrompt(turn, { ...options, cwd });

  // Task messages (browse, send-file, etc.) require code execution — bump low -> medium.
  const isTask = TASK_MARKER_RE.test(stripUserPrefix(turn.message ?? ''));
  const baseEffort = codexReasoningEffort(options);
  const effort = isTask && baseEffort === 'low' ? 'medium' : baseEffort;

  const timeoutMs = parsePositiveInt(process.env.EGPT_CODEX_TIMEOUT_MS, DEFAULT_CODEX_TIMEOUT_MS);
  const tempDir = await mkdtemp(join(tmpdir(), 'egpt-codex-'));
  const lastMessagePath = join(tempDir, 'last-message.txt');
  const permissionArgs = codexPermissionArgs(options, process.env.EGPT_CODEX_TRUST);
  const configArgs = codexConfigArgs({ ...options, reasoningEffort: effort });
  const modelArgs = codexModelArgs(options);
  const args = options.sessionId
    ? [
        'exec',
        '--json',
        ...modelArgs,
        ...configArgs,
        '--skip-git-repo-check',
        '--output-last-message', lastMessagePath,
        ...permissionArgs,
        'resume',
        options.sessionId,
        '-',
      ]
    : [
        'exec',
        '--json',
        ...modelArgs,
        ...configArgs,
        '--cd', cwd,
        '--skip-git-repo-check',
        '--output-last-message', lastMessagePath,
        ...permissionArgs,
        '-',
      ];
  const cmd = codexSpawn(args);
  logLine(logPath, {
    type: 'codex.start',
    cwd,
    resume: options.sessionId ?? null,
    model: options.model ?? null,
    serviceTier: options.serviceTier ?? options.service_tier ?? null,
    reasoningEffort: effort,
    prompt,
  });

  try {
    return await new Promise((resolvePromise, reject) => {
      const startedAt = Date.now();
      let firstEventMs = null;
      let firstTextMs = null;
      const proc = spawn(cmd.command, cmd.args, {
        cwd,
        env: { ...process.env, TERM: process.env.TERM || 'dumb' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      proc.stdin.end(prompt, 'utf8');

      let lineBuf = '';
      let plainOutput = '';
      let assistantText = '';
      let stderr = '';
      let sessionId = options.sessionId ?? null;
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
            logLine(logPath, { type: 'codex.stdout', text: line });
            onUpdate(plainOutput);
            continue;
          }
          if (firstEventMs === null) firstEventMs = Date.now() - startedAt;
          logLine(logPath, ev);
          if (ev.type === 'thread.started' && ev.thread_id) sessionId = ev.thread_id;
          const text = extractTextEvent(ev);
          if (text) {
            if (firstTextMs === null) firstTextMs = Date.now() - startedAt;
            assistantText += text;
            onUpdate(assistantText);
          }
        }
      });
      proc.stderr.on('data', chunk => {
        const text = chunk.toString('utf8');
        stderr += text;
        logLine(logPath, { type: 'codex.stderr', text });
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
        else if (code !== 0 && !final) final = `[codex exit ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}]`;
        logLine(logPath, {
          type: 'codex.close',
          code,
          timedOut,
          sessionId,
          reasoningEffort: effort,
          durationMs: Date.now() - startedAt,
          firstEventMs,
          firstTextMs,
        });
        resolvePromise({
          text: final || '...',
          optionsPatch: {
            cwd,
            logPath,
            reasoningEffort: effort,
            ...(sessionId ? { sessionId } : {}),
          },
        });
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(e => console.error(`!! codex.mjs:[promise-catch] ${e?.message ?? e}`));
  }
}

export async function stream({ history, message }, onUpdate, options = {}) {
  const text = stripUserPrefix(message);
  const execCommand = parseExec(text);
  if (execCommand !== null) {
    if (!execCommand) return { text: 'usage: @codex exec: <command>', optionsPatch: {} };
    return runShell(execCommand, onUpdate, options);
  }
  return runCodex({ history, message }, onUpdate, options);
}
