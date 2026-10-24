// docker/egpt-box (the Linux being box) validates its arguments before it does anything as root:
// tests/egpt_box_test.py, run here when a python3 is on PATH. The wall itself is proven in a container.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS = dirname(fileURLToPath(import.meta.url));
const python = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import sys; sys.exit(sys.version_info < (3, 8))']).status === 0);

describe('docker/egpt-box argument validation', () => {
  it.skipIf(!python)('tests/egpt_box_test.py passes', () => {
    const r = spawnSync(python, ['-I', 'egpt_box_test.py'], { cwd: TESTS, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });
});
