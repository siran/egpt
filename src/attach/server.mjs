// src/attach/server.mjs — loopback-TCP attach server that runs INSIDE the
// nucleus. Each accepted connection becomes a CLIENT Surface (shell/ext) after
// a signed handshake. The server is transport-only: it turns sockets into
// Surfaces + input events and hands them to the nucleus via callbacks. It does
// not know about dispatch or the surface registry — the nucleus wires those.
//
// Handshake: the first frame from a client MUST be a signed HELLO (HMAC via
// bus-sign.mjs over the whole frame, keyed by ~/.egpt/bus.key). We verify the
// signature AND a timestamp freshness window before creating the surface, so a
// local process that doesn't hold the key can neither forge nor replay a hello.

import net from 'node:net';
import { encodeFrame, createFrameDecoder, C2N, N2C } from './protocol.mjs';
import { verifyEvent, keyFromString } from '../tools/bus-sign.mjs';

const HELLO_TIMEOUT_MS = 5_000;     // drop a connection that never sends a valid HELLO
const HELLO_MAX_AGE_MS = 60_000;    // reject HELLOs whose ts is too old/new (replay guard)
const VALID_CLIENT_KINDS = new Set(['shell', 'ext']);

export async function startAttachServer({
  host = '127.0.0.1',
  port = 0,                 // 0 = OS-assigned ephemeral port (returned to caller)
  keyB64,
  onAttach,                 // (surface, helloMeta) => void  — nucleus adds surface to its registry
  onDetach = null,          // (surfaceId) => void
  onInput,                  // ({ surfaceId, chatId, text, meta }) => void
  onResize = null,          // ({ surfaceId, cols, rows }) => void
  logger = console,
} = {}) {
  if (!keyB64) throw new Error('startAttachServer: keyB64 (shared HMAC key) required');
  if (typeof onAttach !== 'function') throw new Error('startAttachServer: onAttach required');
  if (typeof onInput !== 'function') throw new Error('startAttachServer: onInput required');
  const keyBytes = keyFromString(keyB64);

  let _counter = 0;
  const _conns = new Set();   // every live socket (handshaking or attached)

  const server = net.createServer((socket) => {
    _conns.add(socket);
    socket.setNoDelay(true);
    let surface = null;
    let surfaceId = null;
    let helloDeadline = setTimeout(() => {
      if (!surface) { try { socket.destroy(); } catch {} }
    }, HELLO_TIMEOUT_MS);
    helloDeadline.unref?.();

    const writeFrame = (frame) => {
      try { socket.write(encodeFrame(frame)); return true; }
      catch (e) { logger?.error?.(`attach: write to ${surfaceId ?? 'pending'} failed: ${e?.message ?? e}`); return false; }
    };
    const decode = createFrameDecoder({ onError: (e) => logger?.error?.(`attach: ${surfaceId ?? 'pending'} ${e.message}`) });

    async function handleHello(frame) {
      let verdict = 'invalid';
      try { verdict = await verifyEvent(frame, keyBytes); }
      catch (e) { logger?.error?.(`attach: verify threw: ${e?.message ?? e}`); }
      if (verdict !== 'valid') { writeFrame({ t: N2C.BYE, reason: 'auth failed' }); socket.destroy(); return; }
      const ts = Number(frame.ts);
      if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > HELLO_MAX_AGE_MS) {
        writeFrame({ t: N2C.BYE, reason: 'stale handshake' }); socket.destroy(); return;
      }
      const kind = VALID_CLIENT_KINDS.has(frame.kind) ? frame.kind : 'shell';
      surfaceId = `${kind}:${++_counter}`;
      const meta = { cols: frame.cols ?? null, rows: frame.rows ?? null };
      surface = {
        id: surfaceId,
        kind,
        send: (item) => writeFrame({ t: N2C.ITEM, ...item }),
        startStream: (initial = '') => {
          const id = `${surfaceId}#${Date.now().toString(36)}`;
          writeFrame({ t: N2C.STREAM, id, chunk: initial });
          return {
            push: (chunk) => writeFrame({ t: N2C.STREAM, id, chunk }),
            finish: (text = '') => writeFrame({ t: N2C.STREAM_END, id, text }),
          };
        },
        sys: (body) => writeFrame({ t: N2C.SYS, body }),
        stop: () => { try { socket.destroy(); } catch {} },
      };
      if (helloDeadline) { clearTimeout(helloDeadline); helloDeadline = null; }
      try { onAttach(surface, meta); } catch (e) { logger?.error?.(`attach: onAttach threw: ${e?.message ?? e}`); }
      writeFrame({ t: N2C.WELCOME, nucleusPid: process.pid, version: frame.v ?? null });
    }

    socket.on('data', (chunk) => {
      let frames;
      try { frames = decode(chunk); } catch (e) { logger?.error?.(`attach: decode threw: ${e?.message ?? e}`); return; }
      for (const frame of frames) {
        if (!surface) {
          if (frame.t === C2N.HELLO) handleHello(frame);   // anything before a valid hello is ignored
          continue;
        }
        switch (frame.t) {
          case C2N.INPUT:
            try { onInput({ surfaceId, chatId: frame.chatId ?? null, text: String(frame.text ?? ''), meta: { kind: surface.kind } }); }
            catch (e) { logger?.error?.(`attach: onInput threw: ${e?.message ?? e}`); }
            break;
          case C2N.RESIZE:
            try { onResize?.({ surfaceId, cols: frame.cols, rows: frame.rows }); } catch {}
            break;
          case C2N.PING:
            writeFrame({ t: N2C.PONG });
            break;
          default:
            break;   // unknown post-hello frame — ignore
        }
      }
    });

    const cleanup = () => {
      if (helloDeadline) { clearTimeout(helloDeadline); helloDeadline = null; }
      _conns.delete(socket);
      if (surfaceId) { try { onDetach?.(surfaceId); } catch (e) { logger?.error?.(`attach: onDetach threw: ${e?.message ?? e}`); } }
    };
    socket.on('close', cleanup);
    socket.on('error', (e) => logger?.error?.(`attach: socket ${surfaceId ?? 'pending'} error: ${e?.message ?? e}`));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
  const addr = server.address();
  const boundPort = (addr && typeof addr === 'object') ? addr.port : port;

  return {
    host,
    port: boundPort,
    connections: () => _conns.size,
    // Tell every attached client we're going down (e.g. before /restart) so they
    // reconnect cleanly instead of seeing a bare socket drop.
    broadcastBye: (reason = 'restart') => {
      for (const s of _conns) { try { s.write(encodeFrame({ t: N2C.BYE, reason })); } catch {} }
    },
    close: () => new Promise((resolve) => {
      for (const s of _conns) { try { s.destroy(); } catch {} }
      server.close(() => resolve());
    }),
  };
}
