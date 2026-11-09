// docker/scripts/dbq (the SQL-only query runner of the chatbox beings) checks its input and its credentials
// before it connects, and formats what it gets back: tests/dbq_test.py, run here when a python3 is on PATH.
// It runs against a fake psycopg2; the grants of the real database are the boundary and are not testable here.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS = dirname(fileURLToPath(import.meta.url));
const python = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import sys; sys.exit(sys.version_info < (3, 8))']).status === 0);

describe('docker/scripts/dbq', () => {
  it.skipIf(!python)('tests/dbq_test.py passes', () => {
    const r = spawnSync(python, ['-I', 'dbq_test.py'], { cwd: TESTS, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });
});
