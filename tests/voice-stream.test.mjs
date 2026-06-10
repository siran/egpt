import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { runVoiceStreamTurn } from '../src/voice-stream.mjs';

const tick = () => new Promise(r => setImmediate(r));
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };

function makeHandle() {
  const emitter = new EventEmitter();
  let resolveDone, rejectDone;
  const donePromise = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
  donePromise.catch(() => {});   // the turn attaches its own handler
  return { handle: { emitter, donePromise }, resolveDone, rejectDone };
}

function makeStreamRecorder() {
  const calls = { opened: [], updates: [], finishes: [], cancels: [] };
  const openStream = (body) => {
    calls.opened.push(body);
    return {
      update: (b) => calls.updates.push(b),
      finish: async (b) => calls.finishes.push(b),
      cancel: async () => calls.cancels.push(true),
    };
  };
  return { calls, openStream };
}

const baseMeta = (handle) => ({
  voiceStream: handle,
  fromWhatsApp: true,
  waChatId: '123@s.whatsapp.net',
  waSenderName: 'An',
  replyAllowed: true,
});

describe('runVoiceStreamTurn', () => {
  it('streams a reply and locks the message with the "." marker', async () => {
    const { handle, resolveDone } = makeHandle();
    const { calls, openStream } = makeStreamRecorder();
    const pushed = [];
    const turn = runVoiceStreamTurn(baseMeta(handle), {
      openStream,
      runDefaultBrainTurn: async (prompt) => {
        expect(prompt).toMatch(/^\[\d+:\d{2}\.\d{3}\] An: hola$/);
        return 'hi there';
      },
      pushItem: (item) => pushed.push(item),
      surfaceTag: 'kg',
    });
    await tick();
    handle.emitter.emit('chunk', { cumulative: 'hola' });
    await settle();
    resolveDone();
    await turn;

    expect(calls.opened).toHaveLength(1);            // lazy open, exactly once
    expect(calls.finishes).toEqual(['🐶 e\nhi there\n---\n.']);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].body).toBe('hi there');
    expect(pushed[0].author).toBe('egpt@kg');
  });

  it('all-silence voice note leaves no message and pushes nothing', async () => {
    const { handle, resolveDone } = makeHandle();
    const { calls, openStream } = makeStreamRecorder();
    const pushed = [];
    const turn = runVoiceStreamTurn(baseMeta(handle), {
      openStream,
      runDefaultBrainTurn: async () => '...',
      pushItem: (item) => pushed.push(item),
    });
    await tick();
    handle.emitter.emit('chunk', { cumulative: '[Música]' });
    await settle();
    resolveDone();
    await turn;

    expect(calls.opened).toHaveLength(0);
    expect(calls.finishes).toHaveLength(0);
    expect(pushed).toHaveLength(0);
  });

  it('muted chat: brain still hears, WA stream never opens, shell item still lands', async () => {
    const { handle, resolveDone } = makeHandle();
    const { calls, openStream } = makeStreamRecorder();
    const pushed = [];
    const brain = vi.fn(async () => 'heard you');
    const turn = runVoiceStreamTurn(baseMeta(handle), {
      eMayReplyToChat: () => false,
      openStream,
      runDefaultBrainTurn: brain,
      pushItem: (item) => pushed.push(item),
    });
    await tick();
    handle.emitter.emit('chunk', { cumulative: 'hola' });
    await settle();
    resolveDone();
    await turn;

    expect(brain).toHaveBeenCalled();                // E reads it for context
    expect(calls.opened).toHaveLength(0);            // but never replies in-chat
    expect(pushed).toHaveLength(1);                  // shell record kept
  });

  it('stacks replies from successive chunks joined by ---', async () => {
    const { handle, resolveDone } = makeHandle();
    const { calls, openStream } = makeStreamRecorder();
    let release;
    let pass = 0;
    const turn = runVoiceStreamTurn(baseMeta(handle), {
      openStream,
      runDefaultBrainTurn: async () => {
        pass += 1;
        if (pass === 1) {
          // Hold the first pass so the second chunk lands while in flight.
          await new Promise(r => { release = r; });
          return 'first thought';
        }
        return 'second thought';
      },
      pushItem: () => {},
    });
    await tick();
    handle.emitter.emit('chunk', { cumulative: 'hola' });
    await settle();
    handle.emitter.emit('chunk', { cumulative: 'hola como estas' });   // sets pendingNewChunk
    await settle();
    release();
    await settle(20);
    resolveDone();
    await turn;

    expect(pass).toBe(2);   // in-flight loop consumed the pending chunk
    expect(calls.finishes).toEqual(['🐶 e\nfirst thought\n---\nsecond thought\n---\n.']);
  });

  it('transcription error: drains the in-flight pass before locking the message', async () => {
    const { handle, rejectDone } = makeHandle();
    const { calls, openStream } = makeStreamRecorder();
    let release;
    const errs = [];
    const turn = runVoiceStreamTurn(baseMeta(handle), {
      openStream,
      runDefaultBrainTurn: async () => {
        await new Promise(r => { release = r; });
        return 'late reply';
      },
      errOut: (m) => errs.push(m),
      pushItem: () => {},
    });
    await tick();
    handle.emitter.emit('chunk', { cumulative: 'hola' });
    await settle();
    rejectDone(new Error('whisper died'));
    await settle();
    release();   // brain pass completes AFTER the transcription failure
    await turn;

    expect(errs.some(m => m.includes('whisper died'))).toBe(true);
    // The late reply was waited for and made it into the locked body —
    // no update-after-finish.
    expect(calls.finishes).toEqual(['🐶 e\nlate reply\n---\n.']);
  });
});
