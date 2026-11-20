// daemon-graph.mjs — which files of the checkout the DAEMON process loads, found from the code, not a list:
// the relative import graph from egpt-daemon.mjs (static `import … from './x.mjs'`, `import './x.mjs'`, and
// a dynamic import of a literal path), plus the setup/ scripts those files name (`'beeper-window.ps1'`), plus
// whether any of them imports a non-relative package (then package.json / package-lock.json count).
// egpt-update.mjs asks it which upstream changes need `/upgrade full` (the daemon renewed) rather than a spine-only one.
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"\n]+)\1/g;
const SCRIPT = /['"`]([\w.-]+\.(?:ps1|vbs|cmd))['"`]/g;
export const PACKAGE_FILES = ['package.json', 'package-lock.json'];

// → { files: Set<repo-relative, forward-slash paths>, packages: boolean }
export async function daemonGraph(root, { entry = 'egpt-daemon.mjs', read = (p) => readFile(join(root, p), 'utf8') } = {}) {
  const files = new Set(), todo = [entry];
  let packages = false;
  while (todo.length) {
    const file = todo.pop();
    if (files.has(file)) continue;
    let src;
    try { src = String(await read(file)); } catch (e) { if (file === entry) throw e; continue; }   // a specifier that is no file (a template, a directory): not part of the graph
    files.add(file);
    for (const [, , spec] of src.matchAll(SPECIFIER)) {
      if (spec.startsWith('.')) todo.push(posix.normalize(posix.join(posix.dirname(file), spec)));
      else if (!spec.startsWith('node:')) packages = true;
    }
    for (const [, name] of src.matchAll(SCRIPT)) {
      const script = `setup/${name}`;
      if (files.has(script)) continue;
      try { await read(script); files.add(script); } catch { /* named in a comment, not a script */ }
    }
  }
  return { files, packages };
}

// the changed paths (git diff --name-only) that force the daemon to be renewed
export const daemonChanges = (changed, { files, packages }) => changed.filter((f) => files.has(f) || (packages && PACKAGE_FILES.includes(f)));
