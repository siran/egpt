import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { startSpineOutputLog } from '../src/spine-output-log.mjs';

describe('spine output log', () => {
  it('rotates a large log and appends new spine items', () => {
    const dir = mkdtempSync(join(tmpdir(), 'egpt-spine-log-'));
    const logPath = join(dir, 'headless.log');
    writeFileSync(logPath, 'x'.repeat(500 * 1024 + 1));
    const calls = [];
    let handler = null;

    const stop = startSpineOutputLog({
      engine: {
        subscribe: (fn) => {
          calls.push('subscribe');
          handler = fn;
          return () => calls.push('unsubscribe');
        },
      },
      logPath,
      file: 'egpt-spine.mjs',
      pid: 12345,
      maxBytes: 500 * 1024,
    });

    expect(calls).toEqual(['subscribe']);
    expect(typeof stop).toBe('function');
    expect(existsSync(`${logPath}.1`)).toBe(true);

    handler({ author: 'e', body: ' hello  ' });
    handler({ _log: true, author: 'system', body: 'ignored' });
    stop();

    const current = readFileSync(logPath, 'utf8');
    const rotated = readFileSync(`${logPath}.1`, 'utf8');
    expect(rotated.startsWith('x'.repeat(20))).toBe(true);
    expect(current).toContain('egpt spine starting (pid 12345, file egpt-spine.mjs)');
    expect(current).toContain('e:  hello');
    expect(current).not.toContain('ignored');
  });

  it('requires an engine subscription hook and log path', () => {
    expect(() => startSpineOutputLog({ engine: {} })).toThrow(/engine.subscribe required/);
    expect(() => startSpineOutputLog({ engine: { subscribe: () => {} } })).toThrow(/logPath required/);
  });
});
