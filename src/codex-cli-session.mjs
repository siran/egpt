// codex-cli-session.mjs — one resident Codex app-server process behind eGPT's
// warm-session interface ({turn, close, sessionId}). The process stays alive
// while the warm pool retains this conversation; a recorded thread id resumes
// after eviction or restart.
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function normalizeCwd(p) {
  if (!p) return p;
  const m = String(p).match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p;
}

// The Windows npm launcher is a .cmd file, which Node cannot reliably spawn
// without a shell. Prefer the installed JS entry under this Node executable.
function resolveCodexCommand(explicit) {
  if (explicit) return { bin: explicit, prefix: [] };
  if (process.env.EGPT_CODEX_BIN) return { bin: process.env.EGPT_CODEX_BIN, prefix: [] };
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    const js = appData && join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    try { if (js && existsSync(js)) return { bin: process.execPath, prefix: [js] }; } catch { /* PATH fallback */ }
  }
  const unixJs = join(homedir(), '.npm-global', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  try { if (existsSync(unixJs)) return { bin: process.execPath, prefix: [unixJs] }; } catch { /* PATH fallback */ }
  return { bin: 'codex', prefix: [] };
}

export function codexThreadParams(options = {}) {
  const cwd = normalizeCwd(options.cwd);
  return {
    ...(options.model ? { model: String(options.model) } : {}),
    ...(cwd ? { cwd } : {}),
    approvalPolicy: 'never',
    // thread/start's legacy `sandbox` field uses CLI spellings; turn/start's
    // structured sandboxPolicy below uses protocol variant names.
    sandbox: options.dangerouslySkipPermissions === true ? 'danger-full-access' : 'workspace-write',
    serviceName: 'egpt',
  };
}

export function codexTurnParams(options = {}, threadId, text) {
  const cwd = normalizeCwd(options.cwd);
  const sandboxPolicy = options.dangerouslySkipPermissions === true
    ? { type: 'dangerFullAccess' }
    : { type: 'workspaceWrite', writableRoots: cwd ? [cwd] : [], networkAccess: true };
  return {
    threadId,
    input: [{ type: 'text', text }],
    ...(cwd ? { cwd } : {}),
    approvalPolicy: 'never',
    sandboxPolicy,
    ...(options.model ? { model: String(options.model) } : {}),
    ...(options.effort ? { effort: String(options.effort) } : {}),
  };
}

export function createCodexCliSession(options = {}) {
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const _spawn = options.spawn || nodeSpawn;
  let sessionId = options.sessionId ?? null;
  let proc = null;
  let closed = false;
  let stdoutBuf = '';
  let stderrBuf = '';
  let nextId = 1;
  let ready = null;
  let currentTurn = null;
  const requests = new Map();
  const itemPhases = new Map();

  function send(msg) {
    if (!proc?.stdin) throw new Error('codex app-server is not running');
    proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      requests.set(id, { resolve, reject, method });
      try { send({ method, id, params }); }
      catch (e) { requests.delete(id); reject(e); }
    });
  }

  function failAll(error) {
    const err = error instanceof Error ? error : new Error(String(error));
    for (const pending of requests.values()) pending.reject(err);
    requests.clear();
    if (currentTurn) { currentTurn.reject(err); currentTurn = null; }
  }

  function handleMessage(msg) {
    if (Object.prototype.hasOwnProperty.call(msg, 'id') && !msg.method) {
      const pending = requests.get(msg.id);
      if (!pending) return;
      requests.delete(msg.id);
      if (msg.error) pending.reject(new Error(`codex ${pending.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else pending.resolve(msg.result);
      return;
    }

    if (msg.method === 'item/started') {
      const item = msg.params?.item;
      if (item?.id) itemPhases.set(item.id, item.phase ?? null);
      return;
    }
    if (msg.method === 'item/agentMessage/delta' && currentTurn) {
      const itemId = msg.params?.itemId;
      if (itemPhases.get(itemId) === 'commentary') return;
      const delta = msg.params?.delta;
      if (typeof delta === 'string') {
        currentTurn.text += delta;
        try { currentTurn.onUpdate(currentTurn.text); } catch { /* caller update */ }
      }
      return;
    }
    if (msg.method === 'item/completed' && currentTurn) {
      const item = msg.params?.item;
      if (item?.type === 'agentMessage' && item.phase !== 'commentary' && typeof item.text === 'string') {
        currentTurn.text = item.text;
        try { currentTurn.onUpdate(currentTurn.text); } catch { /* caller update */ }
      }
      return;
    }
    if (msg.method === 'turn/completed' && currentTurn) {
      const status = msg.params?.turn?.status;
      const done = currentTurn;
      currentTurn = null;
      itemPhases.clear();
      if (status === 'completed') done.resolve({ text: done.text, sessionId });
      else done.reject(new Error(`codex turn ${status ?? 'failed'}: ${msg.params?.turn?.error?.message ?? 'unknown error'}`));
      return;
    }
    if (msg.method === 'error' && currentTurn) {
      const done = currentTurn;
      currentTurn = null;
      done.reject(new Error(`codex: ${msg.params?.error?.message ?? msg.params?.message ?? 'app-server error'}`));
    }
  }

  function onStdout(chunk) {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try { handleMessage(JSON.parse(t)); } catch { /* non-protocol stdout */ }
    }
  }

  async function start() {
    if (ready) return ready;
    ready = (async () => {
      const cwd = normalizeCwd(options.cwd);
      if (cwd && !existsSync(cwd)) throw new Error(`codex-cli: cwd does not exist: ${cwd}`);
      const command = resolveCodexCommand(options.bin);
      const args = [...command.prefix, 'app-server', '--stdio'];
      if (options.appendSystemPrompt) args.push('-c', `developer_instructions=${JSON.stringify(String(options.appendSystemPrompt))}`);
      onLog(`codex-cli: spawn resident ${command.bin} ${args.join(' ')}`);
      proc = _spawn(command.bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(cwd ? { cwd } : {}) });
      proc.stdout?.setEncoding?.('utf8');
      proc.stdout?.on('data', onStdout);
      proc.stderr?.setEncoding?.('utf8');
      proc.stderr?.on('data', (chunk) => { stderrBuf = (stderrBuf + chunk).slice(-4000); });
      proc.on('error', failAll);
      proc.on('close', (code) => {
        proc = null;
        failAll(new Error(`codex app-server exited ${code}${stderrBuf.trim() ? `: ${stderrBuf.trim().slice(-500)}` : ''}`));
      });

      await request('initialize', { clientInfo: { name: 'egpt', title: 'eGPT', version: '0.2.0' } });
      send({ method: 'initialized', params: {} });
      const params = codexThreadParams(options);
      const result = sessionId
        ? await request('thread/resume', { threadId: sessionId, ...params })
        : await request('thread/start', params);
      sessionId = result?.thread?.id ?? sessionId;
      if (!sessionId) throw new Error('codex app-server returned no thread id');
    })();
    return ready;
  }

  return {
    async turn(message, onUpdate = () => {}) {
      if (closed) throw new Error('codex-cli: session closed');
      if (currentTurn) throw new Error('codex-cli: a turn is already in flight (the pool must serialize per key)');
      await start();
      const prompt = String(message ?? '');
      return new Promise((resolve, reject) => {
        currentTurn = { resolve, reject, onUpdate, text: '' };
        request('turn/start', codexTurnParams(options, sessionId, prompt)).catch((error) => {
          if (!currentTurn) return;
          currentTurn = null;
          reject(error);
        });
      });
    },
    close() {
      closed = true;
      failAll(new Error('codex-cli: session closed'));
      try { proc?.stdin?.end(); } catch { /* already closing */ }
      try { proc?.kill?.(); } catch { /* already closing */ }
      proc = null;
    },
    get sessionId() { return sessionId; },
  };
}
