// src/tools/agent-tools.mjs — Phase-1 agentic tools for the local operator
// (@l) and any future tool-using brain. Each tool is an OpenAI-style function
// schema + an executor. The HOST gates execution by per-tool permission
// (allow / ask / deny — see EGPT_CONFIG.tools and `/e tool`): an unleashed
// local model will NOT self-refuse a destructive call, so confinement + the
// permission gate live here, not in the model.
//
// Phase 1 is read + communicate only (read_file, list_dir, web_fetch,
// send_message), file tools confined to a sandbox root. write_file / bash come
// in later phases behind ask/deny.

import { readFile, readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const MODES = ['allow', 'ask', 'deny'];

// Resolve a tool's permission: explicit entry, else the configured default,
// else 'ask' (safe). Unknown mode strings fall back to 'ask'.
export function toolMode(toolsCfg, name) {
  const c = toolsCfg && typeof toolsCfg === 'object' ? toolsCfg : {};
  const m = c[name] ?? c.default ?? 'ask';
  return MODES.includes(m) ? m : 'ask';
}

// Confine a path to the sandbox root; throws if it escapes. Phase-1
// string-resolve confinement (path.resolve + prefix check); symlink hardening
// (realpath on the parent) is a later pass.
export function confinePath(root, p) {
  const base = resolve(root);
  const full = resolve(base, p == null || p === '' ? '.' : String(p));
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`path escapes sandbox: ${p}`);
  }
  return full;
}

const CAP = 8000;
const _cap = (s) => (s.length > CAP ? s.slice(0, CAP) + '\n…[truncated]' : s);

// Registry. Each: { schema (OpenAI function), run(args, ctx) -> string }.
export const AGENT_TOOLS = {
  read_file: {
    schema: { type: 'function', function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the sandbox.',
      parameters: { type: 'object', properties: {
        path: { type: 'string', description: 'path relative to the sandbox root' },
      }, required: ['path'] } } },
    async run({ path }, ctx) {
      return _cap(await readFile(confinePath(ctx.sandboxRoot, path), 'utf8'));
    },
  },
  list_dir: {
    schema: { type: 'function', function: {
      name: 'list_dir',
      description: 'List entries in a directory inside the sandbox.',
      parameters: { type: 'object', properties: {
        path: { type: 'string', description: 'directory relative to the sandbox root (default ".")' },
      }, required: [] } } },
    async run({ path }, ctx) {
      const entries = await readdir(confinePath(ctx.sandboxRoot, path ?? '.'), { withFileTypes: true });
      return entries.map(d => (d.isDirectory() ? `${d.name}/` : d.name)).join('\n') || '(empty)';
    },
  },
  web_fetch: {
    schema: { type: 'function', function: {
      name: 'web_fetch',
      description: 'Fetch an http(s) URL and return its text (read-only).',
      parameters: { type: 'object', properties: {
        url: { type: 'string' },
      }, required: ['url'] } } },
    async run({ url }) {
      if (!/^https?:\/\//i.test(String(url))) throw new Error('url must be http(s)');
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      return `HTTP ${res.status}\n${_cap(await res.text())}`;
    },
  },
  send_message: {
    schema: { type: 'function', function: {
      name: 'send_message',
      description: 'Send a WhatsApp message to a chat (by jid).',
      parameters: { type: 'object', properties: {
        chat: { type: 'string', description: 'destination chat jid' },
        text: { type: 'string' },
      }, required: ['chat', 'text'] } } },
    async run({ chat, text }, ctx) {
      if (typeof ctx.sendMessage !== 'function') throw new Error('send_message not wired');
      await ctx.sendMessage(chat, String(text ?? ''));
      return `sent to ${chat}`;
    },
  },
};

// The tool schemas the model should SEE this turn: everything not denied
// (denied tools are hidden so the model doesn't even attempt them).
export function agentToolSchemas(toolsCfg) {
  return Object.entries(AGENT_TOOLS)
    .filter(([name]) => toolMode(toolsCfg, name) !== 'deny')
    .map(([, t]) => t.schema);
}

// Execute one tool call with permission gating.
// ctx: { toolsCfg, sandboxRoot, sendMessage?, confirm?(name,args)->Promise<bool> }
// Returns { ok, result } — result is always a string to feed back to the model.
export async function runAgentTool(name, args, ctx = {}) {
  const tool = AGENT_TOOLS[name];
  if (!tool) return { ok: false, result: `!! unknown tool: ${name}` };
  const mode = toolMode(ctx.toolsCfg, name);
  if (mode === 'deny') return { ok: false, result: `!! tool "${name}" is denied by operator policy` };
  if (mode === 'ask') {
    const approved = typeof ctx.confirm === 'function' ? await ctx.confirm(name, args) : false;
    if (!approved) return { ok: false, result: `!! tool "${name}" not approved by operator` };
  }
  try {
    return { ok: true, result: String(await tool.run(args ?? {}, ctx) ?? '') };
  } catch (e) {
    return { ok: false, result: `!! ${name} failed: ${e?.message ?? e}` };
  }
}
