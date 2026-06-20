import { describe, expect, it } from 'vitest';
import { launchSpineProcess } from '../src/spine-launch.mjs';

describe('spine launch harness', () => {
  it('orders the startup sequence and wires the runtime exit callback', async () => {
    const calls = [];
    let exitHandler = null;
    let capturedOnExit = null;
    const stopSpineRuntime = () => calls.push('runtime.stop');
    const stopOutputLog = () => calls.push('output.stop');

    const result = await launchSpineProcess({
      mode: 'headless',
      engine: { startAttach: async () => calls.push('attach') },
      startSpineRuntime: () => { calls.push('runtime.start'); return stopSpineRuntime; },
      processObj: { on: (name, fn) => { if (name === 'exit') exitHandler = fn; } },
      takeoverIfRunning: async (mode) => { calls.push(`takeover:${mode}`); },
      writePidfile: (mode) => { calls.push(`pid:${mode}`); },
      startAliveHeartbeat: () => { calls.push('heartbeat'); },
      startSpineOutputLog: () => { calls.push('output.start'); return stopOutputLog; },
      log: (m) => { calls.push(`log:${m}`); },
      onExit: ({ code, stopSpineRuntime, stopOutputLog }) => {
        capturedOnExit = { code, stopSpineRuntime, stopOutputLog };
        stopOutputLog();
        stopSpineRuntime();
      },
    });

    expect(result).toBe(stopSpineRuntime);
    expect(calls).toEqual([
      'takeover:headless',
      'pid:headless',
      'heartbeat',
      'output.start',
      'log:egpt spine booted (headless)',
      'runtime.start',
      'attach',
    ]);
    expect(typeof exitHandler).toBe('function');

    exitHandler(3);
    expect(calls).toContain('output.stop');
    expect(calls).toContain('runtime.stop');
    expect(calls).toContain('attach');
    expect(capturedOnExit).toMatchObject({ code: 3, stopSpineRuntime, stopOutputLog });
  });

  it('requires the boot wiring fns', async () => {
    await expect(launchSpineProcess({ engine: { startAttach: async () => {} }, startSpineRuntime: () => {} }))
      .rejects.toThrow(/takeoverIfRunning required/);
  });
});
