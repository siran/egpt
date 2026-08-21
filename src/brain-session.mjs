// Select the session primitive named by an agent type. Keep ccode as the
// default; adding an engine must never change the shipped eGPT persona
// implicitly. Not all engines are CLIs — llama is plain HTTP against a local
// llama-server, and is sessionless (sessionId is always null).
import { createWarmCliSession } from './warm-cli-session.mjs';
import { createCodexCliSession } from './codex-cli-session.mjs';
import { createLlamaHttpSession } from './llama-http-session.mjs';

export function createBrainSession(options = {}) {
  const engine = String(options.engine ?? 'ccode').toLowerCase();
  if (engine === 'ccode' || engine === 'claude-code') return createWarmCliSession(options);
  if (engine === 'codex') return createCodexCliSession(options);
  // HTTP, not a CLI: local llama-server, sessionless (see llama-http-session.mjs).
  if (engine === 'llama') return createLlamaHttpSession(options);
  throw new Error(`unsupported local brain engine: ${engine}`);
}
