// Locks the per-being per-chat mode resolver (operator 2026-06-14): generalizes
// the E-only auto-mode to every being, surface-agnostic, with a '*' wildcard and
// backward-compat with the legacy whatsapp.auto_e_modes. The emit gate is
// unchanged — this only picks WHICH mode applies to WHICH being in WHICH chat.
import { describe, it, expect } from 'vitest';
import { resolveBeingMode } from '../src/auto-mode.mjs';

const CHAT = '!room:beeper.local';

describe('resolveBeingMode', () => {
  it('explicit per-being mode wins', () => {
    const autoModes = { [CHAT]: { e: 'mention', wren: 'on', don: 'mute' } };
    expect(resolveBeingMode({ autoModes, chatId: CHAT, being: 'wren' })).toBe('on');
    expect(resolveBeingMode({ autoModes, chatId: CHAT, being: 'don' })).toBe('mute');
    expect(resolveBeingMode({ autoModes, chatId: CHAT, being: 'e' })).toBe('mention');
  });

  it("the per-chat '*' wildcard covers any being without an explicit entry (the /e auto … all form)", () => {
    const autoModes = { [CHAT]: { '*': 'on', don: 'mention' } };
    expect(resolveBeingMode({ autoModes, chatId: CHAT, being: 'wren' })).toBe('on');   // via *
    expect(resolveBeingMode({ autoModes, chatId: CHAT, being: 'don' })).toBe('mention'); // explicit beats *
  });

  it('legacy whatsapp.auto_e_modes still resolves E (back-compat) but not other beings', () => {
    const autoEModes = { [CHAT]: 'on' };
    expect(resolveBeingMode({ autoEModes, chatId: CHAT, being: 'e' })).toBe('on');
    expect(resolveBeingMode({ autoEModes, chatId: CHAT, being: 'wren', defaultMode: 'mention' })).toBe('mention');
  });

  it('precedence: explicit > "*" > legacy-e > default', () => {
    const autoModes = { [CHAT]: { e: 'mute', '*': 'on' } };
    const autoEModes = { [CHAT]: 'mention' };
    expect(resolveBeingMode({ autoModes, autoEModes, chatId: CHAT, being: 'e' })).toBe('mute');   // explicit
    expect(resolveBeingMode({ autoModes, autoEModes, chatId: CHAT, being: 'l' })).toBe('on');     // * (not legacy)
  });

  it('falls back to defaultMode (and to DEFAULT_AUTO_MODE if that is invalid)', () => {
    expect(resolveBeingMode({ chatId: CHAT, being: 'wren', defaultMode: 'mention' })).toBe('mention');
    expect(resolveBeingMode({ chatId: CHAT, being: 'wren', defaultMode: 'on' })).toBe('on');
    expect(resolveBeingMode({ chatId: CHAT, being: 'wren', defaultMode: 'bogus' })).toBe('mention'); // DEFAULT_AUTO_MODE
  });

  it('ignores invalid configured modes', () => {
    const autoModes = { [CHAT]: { wren: 'nonsense', '*': 'on' } };
    expect(resolveBeingMode({ autoModes, chatId: CHAT, being: 'wren' })).toBe('on'); // falls through bad explicit → *
  });
});
