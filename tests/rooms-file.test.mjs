import { describe, it, expect } from 'vitest';
import { readRoomsFile, readRoomConfig, setRoomConfigBlock, setRoomConfigKey, removeRoomRow } from '../src/rooms-file.mjs';

const mkIO = (text) => {
  const store = { text };
  return {
    store,
    path: 'rooms.yaml',
    read: async () => { if (store.text == null) throw new Error('ENOENT'); return store.text; },
    write: async (_p, t) => { store.text = t; },
    ensureDir: async () => {},
  };
};

describe('rooms.yaml — the room rung', () => {
  it('reads the wrapped shape', async () => {
    const io = mkIO('rooms:\n  room/dj-son:\n    heartbeats:\n      dj: false\n');
    expect(await readRoomConfig('room/dj-son', io)).toEqual({ heartbeats: { dj: false } });
  });

  it('tolerates a bare top-level map', async () => {
    const io = mkIO('shell/lobby:\n  members: []\n');
    expect(await readRoomConfig('shell/lobby', io)).toEqual({ members: [] });
  });

  it('returns {} for a missing row or missing file', async () => {
    expect(await readRoomConfig('nope/here', mkIO('rooms:\n'))).toEqual({});
    expect(await readRoomConfig('nope/here', mkIO(null))).toEqual({});
    expect(await readRoomsFile(mkIO(null))).toEqual({});
  });

  it('NO ROOM IS SPECIAL — dj-son is just a row', async () => {
    const io = mkIO('rooms:\n  room/dj-son:\n    heartbeats: {dj: false}\n  room/other:\n    heartbeats: {x: true}\n');
    const all = await readRoomsFile(io);
    expect(Object.keys(all).sort()).toEqual(['room/dj-son', 'room/other']);
  });

  it('writes one block without clobbering other rows or comments', async () => {
    const io = mkIO('# operator notes\nrooms:\n  room/a:\n    heartbeats: {x: true}\n');
    await setRoomConfigBlock('room/b', 'members', [{ kind: 'brain', id: 'c1' }], io);
    expect(io.store.text).toContain('# operator notes');
    expect(await readRoomConfig('room/a', io)).toEqual({ heartbeats: { x: true } });
    expect(await readRoomConfig('room/b', io)).toEqual({ members: [{ kind: 'brain', id: 'c1' }] });
  });

  it('creates the file when absent', async () => {
    const io = mkIO(null);
    await setRoomConfigBlock('room/new', 'heartbeats', { dj: false }, io);
    expect(await readRoomConfig('room/new', io)).toEqual({ heartbeats: { dj: false } });
  });

  it('sets a DOTTED key inside a row', async () => {
    const io2 = mkIO('rooms:\n');
    await setRoomConfigKey('room/dj-son', 'radio_service.wildnloyal.enabled', false, io2);
    expect(await readRoomConfig('room/dj-son', io2))
      .toEqual({ radio_service: { wildnloyal: { enabled: false } } });
  });

  it('never splits ns — a slug with dots and spaces stays ONE key', async () => {
    const io2 = mkIO('rooms:\n');
    const ns = 'whatsapp/HFM - high.frequency-2606300017';
    await setRoomConfigKey(ns, 'radio.join', 'wildnloyal', io2);
    expect(await readRoomConfig(ns, io2)).toEqual({ radio: { join: 'wildnloyal' } });
    expect(Object.keys(await readRoomsFile(io2))).toEqual([ns]);
  });

  it('removes a whole row without touching its siblings', async () => {
    const io2 = mkIO('rooms:\n  room/a:\n    heartbeats: {x: true}\n  room/b:\n    heartbeats: {y: true}\n');
    await removeRoomRow('room/a', io2);
    expect(await readRoomConfig('room/a', io2)).toEqual({});
    expect(await readRoomConfig('room/b', io2)).toEqual({ heartbeats: { y: true } });
  });
});
