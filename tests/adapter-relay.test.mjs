// Command Surface Phase 4 — the chatgpt web-brain adapter drives cleanly through the
// CDP relay seam. This is the reproduce-first proof for the ADAPTER half of the relay:
// a member's turn text reaches the adapter's injectScript, the adapter's assistant-
// message POLL heuristic is handed to the poller, and streamed partials + the finalized
// reply propagate back — ALL through an INJECTED fake streamFromTab (the task's seam:
// no live Chrome, no real socket). The room-member fan-out that will CALL this (routing a
// room message to each brain member per mode + feeding the guard) is the hot-path change
// held at the design checkpoint — see the phase-4 report; it is not wired here.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Inject a fake CDP: replace streamFromTab (the relay engine) with a recorder and stub
// peekTab. The adapter imports `* as cdp from '../../src/tools/cdp.mjs'`, which resolves
// to the SAME module id this mock targets, so the adapter calls the spy — no live socket.
vi.mock('../src/tools/cdp.mjs', () => ({
  streamFromTab: vi.fn(),
  peekTab: vi.fn(async () => ''),
}));

import * as cdp from '../src/tools/cdp.mjs';
import * as chatgpt from '../config/brains/chatgpt-cdp.mjs';

beforeEach(() => { cdp.streamFromTab.mockReset(); });

describe('chatgpt-cdp adapter — web-brain contract', () => {
  it('exposes { name, urlMatch, homeUrl, requires:[targetId] } — the fields the fan-out matches + drives on', () => {
    expect(chatgpt.name).toBe('chatgpt-cdp');
    expect(chatgpt.requires).toContain('targetId');
    expect(chatgpt.homeUrl).toMatch(/chatgpt\.com/);
    // urlMatch is what the adapter registry (phase 2) uses to admit a tab as a brain member.
    expect(chatgpt.urlMatch.test('https://chatgpt.com/c/abc')).toBe(true);
    expect(chatgpt.urlMatch.test('https://chat.openai.com/')).toBe(true);
    expect(chatgpt.urlMatch.test('https://mail.google.com')).toBe(false);
  });

  it('EXPORTS injectScript(message) + pollScript — the two the room relay drives directly', () => {
    // Phase 4: `streamFromTab(targetId, adapter.injectScript(text), adapter.pollScript)`.
    expect(typeof chatgpt.injectScript).toBe('function');
    expect(chatgpt.injectScript('hello')).toContain(JSON.stringify('hello'));   // the turn text is embedded
    expect(typeof chatgpt.pollScript).toBe('string');
    expect(chatgpt.pollScript).toContain('data-message-author-role');           // reads the LAST assistant message
    expect(chatgpt.pollScript).toContain('streaming');                          // the stop-button / streaming-flag heuristic
  });
});

describe('chatgpt-cdp adapter — drives the relay through an injected streamFromTab', () => {
  it("a member turn: 'hello' reaches injectScript, the assistant-message POLL feeds pollScript, partials + reply stream back", async () => {
    // The fake CDP seam: stream two partials, then finalize — modeling a streamed answer.
    cdp.streamFromTab.mockImplementation(async ({ onUpdate }) => {
      onUpdate?.('Hel');
      onUpdate?.('Hello there');
      return 'Hello there';
    });

    const seen = [];
    const reply = await chatgpt.stream({ message: 'hello' }, (p) => seen.push(p), { targetId: 'T1' });

    expect(cdp.streamFromTab).toHaveBeenCalledTimes(1);
    const arg = cdp.streamFromTab.mock.calls[0][0];
    expect(arg.targetId).toBe('T1');                                 // the member's live tab
    expect(arg.injectScript).toContain('hello');                    // the turn text is embedded in the inject
    expect(arg.pollScript).toContain('data-message-author-role');   // reads the LAST assistant message
    expect(arg.pollScript).toContain('streaming');                  // the stop-button / streaming-flag stability heuristic
    expect(typeof arg.onUpdate).toBe('function');

    expect(seen).toEqual(['Hel', 'Hello there']);                   // partials propagate to the caller's onUpdate
    expect(reply).toBe('Hello there');                              // the finalized reply is returned to post into the room
  });

  it('embeds the message as an escaped JS string literal — a quote/newline in the turn cannot break the inject', async () => {
    cdp.streamFromTab.mockResolvedValue('ok');
    await chatgpt.stream({ message: 'say "hi"\nline2' }, () => {}, { targetId: 'T9' });
    const { injectScript } = cdp.streamFromTab.mock.calls[0][0];
    // The adapter interpolates JSON.stringify(message), so the raw quote/newline survive
    // as an escaped literal, never as raw script — the safe seam the fan-out relies on.
    expect(injectScript).toContain(JSON.stringify('say "hi"\nline2'));
  });

  it('an empty streamed reply returns empty (the fan-out decides whether to post nothing) ', async () => {
    cdp.streamFromTab.mockResolvedValue('');
    const reply = await chatgpt.stream({ message: 'x' }, () => {}, { targetId: 'T2' });
    expect(reply).toBe('');
  });
});
