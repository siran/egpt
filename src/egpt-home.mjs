// egpt-home.mjs — the single source of the profile root.
//
// Default ~/.egpt; override with the EGPT_HOME env var so independent
// installs/nodes can coexist on one machine (the mesh model: each principal node
// is independent). E.g. a v2 test profile alongside the production node:
//
//   EGPT_HOME=~/.egpt2  node tests-manual/phase3-v1.mjs
//
// Read ONCE at module load — set EGPT_HOME before launching the process. Imports
// only node builtins so any module (incl. cycle-sensitive room-core) can use it.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const EGPT_HOME = process.env.EGPT_HOME || join(homedir(), '.egpt');
