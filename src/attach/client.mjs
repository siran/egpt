// src/attach/client.mjs — loopback-TCP attach client used by thin surfaces (the
// TTY shell today, the extension later). Single connection: connect, sign + send
// HELLO, await WELCOME, then stream frames. Reconnect is the CALLER's job (the
// UI wraps this in a retry loop), so this stays a clean one-shot transport.
//
// Resolves to a handle once WELCOME arrives; rejects on auth BYE, early close,
// or timeout — so `await connectAttachClient(...)` either gives you a live,
// authenticated channel or a clear error.

import net from 'node:net';
import { encodeFrame, createFrameDecoder, C2N, N2C } from './protocol.mjs';
import { signEvent, keyFromString } from '../tools/bus-sign.mjs';

const WELCOME_TIMEOUT_MS = 5_000;

export async function connectAttachClient({
  host = '127.0.0.1',
  port,
  keyB64,
  kind = 'shell',
  cols = null,
  rows = null,
  version = null,
  onFrame = null,     // (frame) => void   — every post-WELCOME frame from the nucleus
  onClose = null,     // (err|null) => void
  logger = console,
} = {}) {
  if (!port) throw new Error('connectAttachClient: port required');
  if (!keyB64) throw new Error('connectAttachClient: keyB64 required');
  const keyBytes = keyFromString(keyB64);

  const socket = net.connect({ host, port });
  socket.setNoDelay(true);

  const writeFrame = (frame) => {
    try { socket.write(encodeFrame(frame)); return true; }
    catch (e) { logger?.error?.(`attach client: write failed: ${e?.message ?? e}`); return false; }
  };

  return await new Promise((resolve, reject) => {
    let welcomed = false;
    let settled = false;
    const settle = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    const welcomeTimer = setTimeout(() => {
      settle(reject, new Error('attach client: no WELCOME within timeout'));
      try { socket.destroy(); } catch {}
    }, WELCOME_TIMEOUT_MS);
    welcomeTimer.unref?.();

    const decode = createFrameDecoder({ onError: (e) => logger?.error?.(`attach client: ${e.message}`) });

    const makeHandle = (welcomeFrame) => ({
      welcome: welcomeFrame,
      input: (text, chatId = null) => writeFrame({ t: C2N.INPUT, text: String(text ?? ''), ...(chatId ? { chatId } : {}) }),
      resize: (c, r) => writeFrame({ t: C2N.RESIZE, cols: c, rows: r }),
      ping: () => writeFrame({ t: C2N.PING }),
      send: (frame) => writeFrame(frame),
      close: () => { try { socket.destroy(); } catch {} },
      get connected() { return !socket.destroyed && welcomed; },
    });

    socket.on('data', (chunk) => {
      for (const frame of decode(chunk)) {
        if (!welcomed) {
          if (frame.t === N2C.WELCOME) {
            welcomed = true;
            clearTimeout(welcomeTimer);
            settle(resolve, makeHandle(frame));
          } else if (frame.t === N2C.BYE) {
            clearTimeout(welcomeTimer);
            settle(reject, new Error(`attach client: rejected (${frame.reason ?? 'bye'})`));
            try { socket.destroy(); } catch {}
          }
          continue;
        }
        try { onFrame?.(frame); } catch (e) { logger?.error?.(`attach client: onFrame threw: ${e?.message ?? e}`); }
      }
    });

    socket.on('connect', async () => {
      try {
        const hello = await signEvent({ t: C2N.HELLO, kind, cols, rows, v: version, ts: Date.now() }, keyBytes);
        writeFrame(hello);
      } catch (e) { settle(reject, e); try { socket.destroy(); } catch {} }
    });

    socket.on('error', (e) => settle(reject, e));
    socket.on('close', () => {
      clearTimeout(welcomeTimer);
      if (!welcomed) settle(reject, new Error('attach client: closed before WELCOME'));
      try { onClose?.(welcomed ? null : new Error('closed before welcome')); } catch {}
    });
  });
}
