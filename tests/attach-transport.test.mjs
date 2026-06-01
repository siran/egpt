// Attach transport end-to-end over real loopback TCP (no WhatsApp, no egpt
// process): handshake + auth, input/item/stream round-trip, ping/pong, wrong-key
// rejection, and detach-on-close. This is the contract the nucleus's TCP server
// and the thin Ink client both depend on.
import { describe, it, expect } from 'vitest';
import { generateKey } from '../src/tools/bus-sign.mjs';
import { startAttachServer } from '../src/attach/server.mjs';
import { connectAttachClient } from '../src/attach/client.mjs';

const quiet = { error() {} };

function waitFor(pred, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const id = setInterval(() => {
      let ok = false; try { ok = pred(); } catch {}
      if (ok) { clearInterval(id); resolve(); }
      else if (Date.now() - t0 > timeout) { clearInterval(id); reject(new Error('waitFor timeout')); }
    }, 10);
  });
}

describe('attach transport (loopback TCP)', () => {
  it('handshakes, then round-trips input, items, stream, and ping/pong', async () => {
    const key = await generateKey();
    const inputs = [];
    let surface = null;
    const server = await startAttachServer({
      port: 0, keyB64: key, logger: quiet,
      onAttach: (s) => { surface = s; },
      onInput: (e) => inputs.push(e),
    });

    const frames = [];
    const client = await connectAttachClient({
      port: server.port, keyB64: key, kind: 'shell', cols: 80, rows: 24,
      onFrame: (f) => frames.push(f), logger: quiet,
    });

    expect(client.welcome.t).toBe('welcome');
    expect(surface).toBeTruthy();
    expect(surface.id).toMatch(/^shell:\d+$/);
    expect(server.connections()).toBe(1);

    // client → nucleus
    client.input('hello there', 'wa:123');
    await waitFor(() => inputs.length === 1);
    expect(inputs[0]).toMatchObject({ surfaceId: surface.id, chatId: 'wa:123', text: 'hello there' });

    // nucleus → client (one item)
    surface.send({ author: 'wa', body: 'hi back' });
    await waitFor(() => frames.some(f => f.t === 'item'));
    expect(frames.find(f => f.t === 'item')).toMatchObject({ author: 'wa', body: 'hi back' });

    // nucleus → client (stream)
    const st = surface.startStream('par');
    st.push('tial');
    st.finish('partial done');
    await waitFor(() => frames.some(f => f.t === 'streamEnd'));
    expect(frames.filter(f => f.t === 'stream').map(f => f.chunk)).toEqual(['par', 'tial']);
    expect(frames.find(f => f.t === 'streamEnd').text).toBe('partial done');

    // keepalive
    client.ping();
    await waitFor(() => frames.some(f => f.t === 'pong'));

    await client.close();
    await server.close();
  });

  it('rejects a client presenting the wrong key', async () => {
    const key = await generateKey();
    const wrong = await generateKey();
    const server = await startAttachServer({ port: 0, keyB64: key, logger: quiet, onAttach() {}, onInput() {} });
    await expect(
      connectAttachClient({ port: server.port, keyB64: wrong, logger: quiet })
    ).rejects.toThrow(/auth failed|bye|closed/i);
    await server.close();
  });

  it('fires onDetach when the client disconnects', async () => {
    const key = await generateKey();
    const detached = [];
    const server = await startAttachServer({
      port: 0, keyB64: key, logger: quiet,
      onAttach() {}, onDetach: (id) => detached.push(id), onInput() {},
    });
    const client = await connectAttachClient({ port: server.port, keyB64: key, logger: quiet });
    await client.close();
    await waitFor(() => detached.length === 1);
    expect(detached[0]).toMatch(/^shell:\d+$/);
    await server.close();
  });

  it('broadcastBye reaches a connected client as a bye frame', async () => {
    const key = await generateKey();
    const server = await startAttachServer({ port: 0, keyB64: key, logger: quiet, onAttach() {}, onInput() {} });
    const frames = [];
    const client = await connectAttachClient({ port: server.port, keyB64: key, onFrame: (f) => frames.push(f), logger: quiet });
    server.broadcastBye('restart');
    await waitFor(() => frames.some(f => f.t === 'bye' && f.reason === 'restart'));
    await client.close();
    await server.close();
  });
});
