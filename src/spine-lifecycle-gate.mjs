const LIFECYCLE_COMMANDS = new Set(['/rewind', '/upgrade', '/restart', '/exit', '/chrome']);

export function firstLifecycleToken(text) {
  return String(text ?? '').trimStart().split(/\s+/)[0] || '';
}

export function isLifecycleCommand(text) {
  return LIFECYCLE_COMMANDS.has(firstLifecycleToken(text));
}

export function isSelfLifecycleCommand({ text, fromChatId, selfChatId }) {
  return !!selfChatId && fromChatId === selfChatId && isLifecycleCommand(text);
}

export { LIFECYCLE_COMMANDS };
