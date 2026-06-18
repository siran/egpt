import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLASH_DIR = join(ROOT, 'slash');

async function loadSlashModules() {
  const files = readdirSync(SLASH_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .sort();
  const loaded = [];
  for (const file of files) {
    loaded.push({
      file,
      module: await import(pathToFileURL(join(SLASH_DIR, file)).href),
    });
  }
  return loaded;
}

describe('slash command modules', () => {
  it('all slash modules import cleanly and expose the command contract', async () => {
    const loaded = await loadSlashModules();
    expect(loaded.length).toBeGreaterThan(40);

    const commands = new Map();
    for (const { file, module } of loaded) {
      expect(module, `${file} should export meta`).toHaveProperty('meta');
      expect(module, `${file} should export run()`).toHaveProperty('run');
      expect(typeof module.run, `${file} run export`).toBe('function');

      const metas = Array.isArray(module.meta) ? module.meta : [module.meta];
      expect(metas.length, `${file} meta entries`).toBeGreaterThan(0);
      for (const meta of metas) {
        expect(meta, `${file} meta`).toMatchObject({
          cmd: expect.stringMatching(/^\/[a-z0-9-]+$/),
          section: expect.any(String),
          surface: expect.stringMatching(/^(shell|both)$/),
          usage: expect.any(String),
          desc: expect.any(String),
        });
        expect(meta.usage, `${file} ${meta.cmd} usage`).toContain(meta.cmd);
        expect(commands.has(meta.cmd), `${meta.cmd} must be declared once`).toBe(false);
        commands.set(meta.cmd, file);
      }
    }

    expect(commands.size).toBeGreaterThan(60);
  });
});
