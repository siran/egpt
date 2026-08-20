// Select the CLI primitive named by an agent type. Keep ccode as the default;
// adding a Codex agent must never change the shipped eGPT persona implicitly.
import { createWarmCliSession } from './warm-cli-session.mjs';
import { createCodexCliSession } from './codex-cli-session.mjs';

export function createBrainSession(options = {}) {
  const engine = String(options.engine ?? 'ccode').toLowerCase();
  if (engine === 'ccode' || engine === 'claude-code') return createWarmCliSession(options);
  if (engine === 'codex') return createCodexCliSession(options);
  throw new Error(`unsupported local brain engine: ${engine}`);
}
