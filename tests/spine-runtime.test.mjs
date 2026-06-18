import { describe, expect, it } from 'vitest';
import { bootSpineRuntime, stopSpineRuntimeOnExit } from '../src/spine-runtime.mjs';

describe('spine runtime fake-world harness', () => {
  it('starts the spine runtime before opening the attach host and registers exit cleanup', async () => {
    const order = [];
    const handlers = {};
    const cleanup = () => order.push('cleanup');
    const engine = {
      startAttach: async () => order.push('attach'),
    };
    const stop = await bootSpineRuntime({
      engine,
      startSpineRuntime: () => { order.push('runtime'); return cleanup; },
      processObj: { on: (name, fn) => { handlers[name] = fn; } },
      onExit: (_code, stopSpineRuntime) => stopSpineRuntime(),
    });

    expect(stop).toBe(cleanup);
    expect(order).toEqual(['runtime', 'attach']);
    expect(typeof handlers.exit).toBe('function');

    handlers.exit(0);
    expect(order).toEqual(['runtime', 'attach', 'cleanup']);
  });

  it('exit cleanup stops bridges, pid/heartbeat state, runtime cleanup, and engine', () => {
    const calls = [];
    stopSpineRuntimeOnExit({
      code: 1,
      bridge: { stop: () => calls.push('tg.stop') },
      waBridge: { stop: () => calls.push('wa.stop') },
      clearNucleusInfoSync: () => calls.push('nucleus.clear'),
      clearPidfile: () => calls.push('pid.clear'),
      stopAliveHeartbeat: () => calls.push('heartbeat.stop'),
      stopSpineRuntime: () => calls.push('runtime.stop'),
      engine: { stop: () => calls.push('engine.stop') },
      llamaProc: { kill: () => calls.push('llama.kill') },
    });

    expect(calls).toEqual([
      'tg.stop',
      'wa.stop',
      'nucleus.clear',
      'llama.kill',
      'pid.clear',
      'heartbeat.stop',
      'runtime.stop',
      'engine.stop',
    ]);
  });

  it('clean exit leaves the llama process alive for interactive takeover', () => {
    const calls = [];
    stopSpineRuntimeOnExit({
      code: 0,
      llamaProc: { kill: () => calls.push('llama.kill') },
      clearPidfile: () => calls.push('pid.clear'),
      stopAliveHeartbeat: () => calls.push('heartbeat.stop'),
    });

    expect(calls).toEqual(['pid.clear', 'heartbeat.stop']);
  });
});
