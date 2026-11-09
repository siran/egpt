// 0013 — superseded (operator 2026-11-08: memory-only eviction): a -1 class TTL is no longer turned
// into 12h. kg's fixture is its pre-0013 `warm:` block byte for byte (CRLF, the legend comment).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from '../migrations/0013-warm-sessions-idle-out.mjs';
import { runMigrations } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');
const KG = crlf([
  '# config.yaml - kg (fixture)',
  'node_name: kg',
  '',
  'warm:',
  '  idle_ttl_by_class: # -1 = never idle-evict',
  '    system: -1',
  '    resident: -1',
  '    conversation: -1',
  '    sibling: -1',
  '  idle_ttl_ms: 1800000',
  '  max: 10',
]);
const AFTER_0013 = KG.replace(/: -1\r\n/g, ': 43200000\r\n');   // what the old 0013 wrote on kg and do

function home(config) {
  const h = mkdtempSync(join(tmpdir(), 'egpt-0013-'));
  mkdirSync(join(h, 'config'), { recursive: true });
  writeFileSync(join(h, 'config', 'config.yaml'), config);
  return h;
}
const cfgPath = (h) => join(h, 'config', 'config.yaml');

describe('0013 — a no-op, superseded by memory-only eviction', () => {
  it('a -1 class TTL is satisfied and untouched, naming the ruling', async () => {
    const h = home(KG);
    const p = await plan({ egptHome: h, log: () => {} });
    expect(p.satisfied).toBe(true);
    expect(p.notes.join('\n')).toMatch(/superseded \(operator 2026-11-08: memory-only eviction\)/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
  });

  describe('through the runner', () => {
    // The Windows probes of 0001/0002/0004/0005 are told "nothing there", and localAddresses is empty
    // so 0007 reads nothing as this node's own (as tests/migrations-0012-*).
    const ctx = { ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }), localAddresses: new Set() };
    const dir = join(import.meta.dirname, '..', 'migrations');
    const run = (h) => runMigrations({ through: '0013', dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    const ledgerPath = (h) => join(h, 'state', 'migrations-applied.json');
    const outcome = (h) => JSON.parse(readFileSync(ledgerPath(h), 'utf8'))['0013-warm-sessions-idle-out'].outcome;

    it('a node that never ran it: recorded as already satisfied, the -1s kept, no backup', async () => {
      const h = home(KG);
      expect((await run(h)).exitCode).toBe(0);
      expect(outcome(h)).toBe('already-satisfied');
      expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
      expect(readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-'))).toEqual([]);
    });

    it('a node that ran it (kg, do): its ledger record and the 12h values it wrote are left as they are', async () => {
      const h = home(AFTER_0013);
      mkdirSync(join(h, 'state'), { recursive: true });
      writeFileSync(ledgerPath(h), JSON.stringify({ '0013-warm-sessions-idle-out': { outcome: 'applied', at: '2026-09-20T00:00:00Z' } }));
      expect((await run(h)).exitCode).toBe(0);
      expect(outcome(h)).toBe('applied');
      expect(readFileSync(cfgPath(h), 'utf8')).toBe(AFTER_0013);
    });
  });
});
