// src/tools/agent-loop.mjs — the ReAct loop that makes a local model agentic.
// Calls the model with the ALLOWED tool schemas; when it returns tool_calls,
// executes each through the permission-gated registry, feeds the results back
// as `tool` messages, and loops until the model returns a plain text reply or
// the iteration cap is hit. The cap + the per-tool gate (deny/ask, in
// runAgentTool) are the runaway/safety bounds — the model is never trusted to
// stop itself.
import { chatWithTools } from '../../config/brains/llama.mjs';
import { agentToolSchemas, runAgentTool } from './agent-tools.mjs';

export async function runAgentLoop({
  systemPrompt, userText, toolsCfg, sandboxRoot, sendMessage, confirm,
  url, model, maxIters = 8, onLog = () => {},
}) {
  const tools = agentToolSchemas(toolsCfg);
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: String(userText ?? '') });

  let lastText = '';
  for (let i = 0; i < maxIters; i++) {
    const { content, toolCalls } = await chatWithTools({ messages, tools }, { url, model, onLog });
    if (!toolCalls.length) return content || lastText;      // plain reply → done
    lastText = content || lastText;
    // Record the assistant's tool-call turn, then append each result.
    messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const name = tc?.function?.name;
      let args = {};
      try { if (tc?.function?.arguments) args = JSON.parse(tc.function.arguments); } catch { args = {}; }
      onLog(`agent: ${name}(${JSON.stringify(args).slice(0, 120)})`);
      const { result } = await runAgentTool(name, args, { toolsCfg, sandboxRoot, sendMessage, confirm });
      messages.push({
        role: 'tool',
        tool_call_id: tc.id ?? name,
        name,
        content: String(result).slice(0, 8000),
      });
    }
  }
  onLog(`agent: hit maxIters=${maxIters}`);
  return lastText || '… (tool loop reached its step limit)';
}
