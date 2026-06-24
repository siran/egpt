import { describe, expect, it } from 'vitest';
import {
  buildMeshMention,
  createMeshSeenCache,
  makeMeshRequestId,
  meshReplyContext,
  meshRequestId,
  meshTtl,
  nextMeshTtl,
  normalizeMeshTtl,
  returnAddressForMeta,
} from '../src/mesh/envelope.mjs';

describe('mesh envelope', () => {
  it('builds stable request ids with injected clock and random', () => {
    expect(makeMeshRequestId({
      node: 'Dolly Node',
      now: () => 12345,
      random: () => 0.5,
    })).toBe('mesh-dolly-node-9ix-zik0zk');
  });

  it('normalizes and decrements ttl', () => {
    expect(normalizeMeshTtl('4')).toBe(4);
    expect(normalizeMeshTtl(-2)).toBe(0);
    expect(meshTtl({ ttl: 2 })).toBe(2);
    expect(meshTtl({ mesh: { ttl: 5 } })).toBe(5);
    expect(nextMeshTtl({ ttl: 1 })).toBe(0);
  });

  it('derives return addresses from dispatch metadata', () => {
    expect(returnAddressForMeta({ fromWhatsApp: true, waChatId: 'abc@g.us' })).toEqual({
      surface: 'whatsapp',
      chat_id: 'abc@g.us',
    });
    expect(returnAddressForMeta({})).toEqual({ surface: 'shell' });
  });

  it('builds a bus mention carrying mesh request metadata', () => {
    const event = buildMeshMention({
      fromNode: 'reve',
      decision: { kind: 'mesh-foreign', target: 'don.dolly', name: 'don', node: 'dolly', body: 'here?' },
      user: 'An',
      returnTo: { surface: 'whatsapp', chat_id: 'hfm@g.us' },
      requestId: 'req-1',
      ttl: 3,
    });
    expect(event).toEqual({
      type: 'mention',
      to_node: 'dolly',
      target: 'don',
      body: 'here?',
      user: 'An',
      request_id: 'req-1',
      ttl: 3,
      mesh: {
        v: 1,
        kind: 'request',
        request_id: 'req-1',
        target: 'don.dolly',
        from_node: 'reve',
        to_node: 'dolly',
        ttl: 3,
        return_to: { surface: 'whatsapp', chat_id: 'hfm@g.us' },
      },
    });
  });

  it('extracts request ids from either top-level or nested mesh fields', () => {
    expect(meshRequestId({ request_id: 'top', mesh: { request_id: 'nested' } })).toBe('top');
    expect(meshRequestId({ mesh: { request_id: 'nested' } })).toBe('nested');
    expect(meshRequestId({})).toBeNull();
  });

  it('builds reply context with decremented ttl and return fields', () => {
    expect(meshReplyContext({
      from: 'reve',
      to_node: 'dolly',
      target: 'don',
      request_id: 'req-1',
      ttl: 3,
      tg_chat_id: 42,
      mesh: {
        target: 'don.dolly',
        return_to: { surface: 'telegram', chat_id: '42' },
      },
    }, { fromNode: 'dolly' })).toEqual({
      request_id: 'req-1',
      ttl: 2,
      tg_chat_id: 42,
      mesh: {
        v: 1,
        kind: 'reply',
        request_id: 'req-1',
        target: 'don.dolly',
        from_node: 'dolly',
        to_node: 'reve',
        ttl: 2,
        return_to: { surface: 'telegram', chat_id: '42' },
      },
    });
  });

  it('tracks replay ids with a bounded ttl cache', () => {
    let t = 1000;
    const cache = createMeshSeenCache({ ttlMs: 50, now: () => t });
    expect(cache.checkAndMark('req-1')).toBe(false);
    expect(cache.checkAndMark('req-1')).toBe(true);
    expect(cache.size()).toBe(1);
    t = 1051;
    expect(cache.has('req-1')).toBe(false);
    expect(cache.size()).toBe(0);
  });
});
