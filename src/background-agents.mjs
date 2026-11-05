// config.yaml `background_agents: { model, effort }` (node default) and
// agents.<name>.background_agents (override per key) -> the two env vars the claude CLI reads
// for the sub-agents a being launches. Unset or invalid keys pass nothing.
export const SUBAGENT_MODELS = ['sonnet', 'opus', 'haiku'];
export const SUBAGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const KEYS = [
  { key: 'model', env: 'CLAUDE_CODE_SUBAGENT_MODEL', allowed: SUBAGENT_MODELS },
  { key: 'effort', env: 'CLAUDE_CODE_SUBAGENT_EFFORT', allowed: SUBAGENT_EFFORTS },
];
const logged = new Set();
const isMap = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// NAME=VALUE entries (the -SetEnv shape). An invalid value is logged once and skipped,
// and does not shadow a valid node default beneath it.
export function backgroundAgentEnvOf(nodeValue, agentValue, onLog = () => {}) {
  const out = [];
  for (const { key, env, allowed } of KEYS) {
    for (const [scope, block] of [['agents.*.background_agents', agentValue], ['background_agents', nodeValue]]) {
      const raw = isMap(block) ? block[key] : undefined;
      if (raw == null || raw === '') continue;
      const v = String(raw).trim().toLowerCase();
      if (allowed.includes(v)) { out.push(`${env}=${v}`); break; }
      const id = `${scope}.${key}=${v}`;
      if (!logged.has(id)) { logged.add(id); onLog(`${scope}.${key}: '${raw}' is not one of ${allowed.join('|')} - ignored`); }
    }
  }
  return out;
}
