// The nucleus's attach endpoint: advertises nucleus.json, turns each connection
// into a CLIENT surface, routes their input to the interpreter (onInput), and
// fans every shell-visible item to ALL attached clients (the shared-room model,
// replacing shell-mirror.jsonl). Runs against an isolated EGPT_HOME so it never
// touches the real ~/.egpt.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { generateKey } from '../src/tools/bus-sign.mjs';
import { startAttachHost } from '../src/nucleus.mjs';
import { connectAttachClient } from '../src/attach/client.mjs';
import { readNucleusInfo } from '../src/attach/discovery.mjs';

const quiet = { error() {} };
const tmpHome = join(os.tmpdir(), `egpt-attach-host-${Date.now()}-${Math.random().toString(36).slice(2)}`);

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

describe('startAttachHost (nucleus attach endpoint)', () => {
  beforeAll(() => { process.env.EGPT_HOME = tmpHome; });
  afterAll(async () => { delete process.env.EGPT_HOME; try { await fs.rm(tmpHome, { recursive: true, force: true }); } catch {} });

  it('advertises nucleus.json, routes client input, and fans items to all clients', async () => {
    const key = await generateKey();
    const inputs = [];
    const host = await startAttachHost({ keyB64: key, version: 'test', onInput: (e) => inputs.push(e), logger: quiet });

    // advertised for clients to discover
    const info = await readNucleusInfo();
    expect(info).toMatchObject({ port: host.port, version: 'test', pid: process.pid });

    // two clients attach to the same nucleus
    const fA = [], fB = [];
    const a = await connectAttachClient({ port: host.port, keyB64: key, onFrame: (f) => fA.push(f), logger: quiet });
    const b = await connectAttachClient({ port: host.port, keyB64: key, onFrame: (f) => fB.push(f), logger: quiet });
    await waitFor(() => host.connections() === 2);

    // client → nucleus interpreter
    a.input('/help');
    await waitFor(() => inputs.length === 1);
    expect(inputs[0]).toMatchObject({ text: '/help' });

    // nucleus → every client (shared room)
    host.pushItem({ id: 'i1', author: 'wa', body: 'hello room' });
    await waitFor(() =>
      fA.some(f => f.t === 'item' && f.id === 'i1') &&
      fB.some(f => f.t === 'item' && f.id === 'i1'));

    // streaming-style update: same id, new body → client replaces in place
    host.pushItem({ id: 'i1', author: 'wa', body: 'hello room (edited)' });
    await waitFor(() => fA.filter(f => f.t === 'item' && f.id === 'i1').length === 2);
    expect(fA.filter(f => f.t === 'item' && f.id === 'i1').pop().body).toBe('hello room (edited)');

    await a.close();
    await b.close();
    await host.close();
    expect(await readNucleusInfo()).toBeNull();   // sidecar cleared on shutdown
  });
});
