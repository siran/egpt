// limb-aware-bridge.test.mjs — ONE facade routes every chat-keyed bridge method by owner:
// a chat a limb owns (shell, telegram) is that limb's, Beeper is the default.
// The first block locks that with only the shell it routes exactly as makeShellAwareBridge did.
import { describe, it, expect } from 'vitest';
import { makeLimbAwareBridge, LIMB_ROUTED_METHODS } from '../src/spine/boot.mjs';
import { createBeeperBridgePort } from '../src/bridges/beeper-port.mjs';
import { isTelegramChatId } from '../src/bridges/telegram.mjs';

// The pre-telegram facade, verbatim — the reference the shell-only routing must keep matching.
function legacyShellAware(bridge, shellPort) {
  return {
    ...bridge,
    send: (c, t, o) => (shellPort.owns(c) ? shellPort.send(c, t, o) : bridge.send(c, t, o)),
    startStream: (c, i, tag) => (shellPort.owns(c) ? shellPort.startStream(c, i, tag) : bridge.startStream(c, i, tag)),
    postStatus: (c, t) => (shellPort.owns(c) ? shellPort.postStatus(c, t) : bridge.postStatus(c, t)),
  };
}

// A bridge-shaped recorder: every method answers `${who}:${method}:${chat}`. Trailing undefined
// arguments are dropped: the old facade passed fixed arities, which is not a difference in routing.
function recorder(who, methods, calls) {
  const o = {};
  const trim = (a) => { const r = [...a]; while (r.length && r[r.length - 1] === undefined) r.pop(); return r; };
  for (const m of methods) o[m] = (c, ...rest) => { calls.push({ who, m, c, rest: trim(rest) }); return `${who}:${m}:${c}`; };
  return o;
}

// beeper-port's whole surface, read off a real port over a bare fake transport.
async function beeperPortMethods() {
  const port = await createBeeperBridgePort({}, { start: async () => ({ send() {}, startStreamMessage() { return {}; }, isAlive: () => true, stop() {} }) });
  return Object.keys(port).filter((k) => typeof port[k] === 'function');
}

// Methods that take no chat as their first argument: they pass through, never routed.
const NOT_CHAT_KEYED = ['onMessage', 'onEdit', 'onMedia', 'renderFrame', 'selfIdentities', 'listChats', 'listChatsRaw', 'createGroup', 'resolveUserIdByPhone', 'isAlive', 'setBeeperRestart', 'stop'];

describe('makeLimbAwareBridge with the shell only — exactly the old makeShellAwareBridge', () => {
  const SHELL = ['send', 'startStream', 'postStatus'];
  const owns = (c) => c === 'lobby';

  it('every beeper-port method, on a shell chat and on a Beeper chat, lands where it landed before', async () => {
    const methods = await beeperPortMethods();
    for (const chat of ['lobby', '!room:beeper.local', 'tg:42']) {
      for (const m of methods) {
        const oldCalls = [], newCalls = [];
        const oldShell = { owns, ...recorder('shell', SHELL, oldCalls) };
        const newShell = { owns, ...recorder('shell', SHELL, newCalls) };
        const legacy = legacyShellAware(recorder('beeper', methods, oldCalls), oldShell);
        const routed = makeLimbAwareBridge(recorder('beeper', methods, newCalls), newShell);
        expect(routed[m](chat, 'x'), `${m}(${chat})`).toBe(legacy[m](chat, 'x'));
        expect(newCalls).toEqual(oldCalls);
      }
    }
  });

  it('keeps the old surface: the bridge spread first, a method neither side has stays absent', () => {
    const calls = [];
    const shell = { owns, ...recorder('shell', SHELL, calls) };
    const bridge = { onEdit() {}, ...recorder('beeper', ['send', 'startStream', 'postStatus'], calls) };
    const routed = makeLimbAwareBridge(bridge, shell);
    expect(Object.keys(routed).sort()).toEqual(Object.keys(legacyShellAware(bridge, shell)).sort());
    expect(routed.onEdit).toBe(bridge.onEdit);
    expect(routed.react).toBeUndefined();
  });

  it('no limbs → the bridge itself, untouched', () => {
    const bridge = { send() {} };
    expect(makeLimbAwareBridge(bridge)).toBe(bridge);
  });
});

describe('makeLimbAwareBridge with shell + telegram — every chat-keyed method routes by owner', () => {
  it('a tg: chat goes to the telegram port for every routed method; Beeper and shell chats are untouched', async () => {
    const methods = await beeperPortMethods();
    const calls = [];
    const shell = { owns: (c) => c === 'lobby', ...recorder('shell', ['send', 'startStream', 'postStatus'], calls) };
    const telegram = { owns: isTelegramChatId, ...recorder('telegram', methods, calls) };
    const routed = makeLimbAwareBridge(recorder('beeper', methods, calls), shell, telegram);
    for (const m of LIMB_ROUTED_METHODS) {
      expect(routed[m]('tg:-1001', 'x'), m).toBe(`telegram:${m}:tg:-1001`);
      expect(routed[m]('!room:beeper.local', 'x'), m).toBe(`beeper:${m}:!room:beeper.local`);
    }
    expect(routed.send('lobby', 'x')).toBe('shell:send:lobby');
    expect(routed.react('lobby', 'x')).toBe('beeper:react:lobby');   // the shell has no react: as before
  });

  it('a telegram-only node: the telegram port is the default, the shell still owns its seat', () => {
    const calls = [];
    const shell = { owns: (c) => c === 'lobby', ...recorder('shell', ['send', 'startStream', 'postStatus'], calls) };
    const telegram = { owns: isTelegramChatId, ...recorder('telegram', ['send', 'startStream', 'postStatus', 'react'], calls) };
    const routed = makeLimbAwareBridge(telegram, shell);
    expect(routed.send('tg:42', 'x')).toBe('telegram:send:tg:42');
    expect(routed.send('lobby', 'x')).toBe('shell:send:lobby');
    expect(routed.react('tg:42', 'x')).toBe('telegram:react:tg:42');
  });

  it('every beeper-port method is either routed by owner or named as not chat-keyed (a new one must choose)', async () => {
    const methods = await beeperPortMethods();
    const unclassified = methods.filter((m) => !LIMB_ROUTED_METHODS.includes(m) && !NOT_CHAT_KEYED.includes(m));
    expect(unclassified).toEqual([]);
    expect(LIMB_ROUTED_METHODS.filter((m) => !methods.includes(m))).toEqual([]);
  });
});
