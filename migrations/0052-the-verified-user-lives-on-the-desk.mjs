// 0052 — each chatbox conversation's verified user moves to the desk: usuario.json, usuario.md become
// desktop/user.json, desktop/user.md (the chatbox seeds, and /ayde reads, only the new paths since #23).
//
// Acts per file, only where the target is missing: a conversation that already has desktop/user.* is
// left as it is (the old file stays, with a note). A rename, so nothing is copied and no backup is
// needed; a re-run finds nothing to move. Output names folders, never the file's contents.
//
// Satisfied: no conversations/http/ on this node, or nothing left to move. Refuses: nothing.
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const elevated = false;
export const summary = "each chatbox conversation's usuario.json/usuario.md move to desktop/user.json/user.md, where the chatbox now writes them";

const MOVES = [['usuario.json', 'user.json'], ['usuario.md', 'user.md']];

export async function plan(ctx) {
  const root = join(ctx.egptHome, 'conversations', 'http');
  if (!existsSync(root)) return { satisfied: true, notes: [`no ${root}`] };
  const todo = [];
  const notes = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const [from, to] of MOVES) {
      const src = join(root, d.name, from);
      if (!existsSync(src)) continue;
      const dst = join(root, d.name, 'desktop', to);
      if (existsSync(dst)) notes.push(`${d.name}/ has both ${from} and desktop/${to} - left`);
      else todo.push({ src, dst, label: `${d.name}/${from} -> ${d.name}/desktop/${to}` });
    }
  }
  if (!todo.length) return { satisfied: true, notes };
  return {
    satisfied: false,
    changes: [...todo.map((t) => t.label), ...notes],
    apply: async () => {
      for (const { src, dst } of todo) {
        mkdirSync(join(dst, '..'), { recursive: true });
        renameSync(src, dst);
      }
    },
  };
}
