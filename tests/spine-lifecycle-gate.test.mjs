import { describe, expect, it } from 'vitest';
import { firstLifecycleToken, isLifecycleCommand, isSelfLifecycleCommand, LIFECYCLE_COMMANDS } from '../src/spine-lifecycle-gate.mjs';

describe('spine lifecycle gate', () => {
  it('recognizes lifecycle commands by their first token', () => {
    expect(LIFECYCLE_COMMANDS.has('/restart')).toBe(true);
    expect(isLifecycleCommand('  /restart now')).toBe(true);
    expect(isLifecycleCommand('/help')).toBe(false);
    expect(firstLifecycleToken('   /upgrade   please')).toBe('/upgrade');
  });

  it('treats a self-chat lifecycle slash as eligible even without sender authorization', () => {
    expect(isSelfLifecycleCommand({
      text: '/restart',
      fromChatId: 'room-123',
      selfChatId: 'room-123',
    })).toBe(true);
    expect(isSelfLifecycleCommand({
      text: '/restart',
      fromChatId: 'room-123',
      selfChatId: 'room-456',
    })).toBe(false);
    expect(isSelfLifecycleCommand({
      text: 'plain text',
      fromChatId: 'room-123',
      selfChatId: 'room-123',
    })).toBe(false);
  });
});
