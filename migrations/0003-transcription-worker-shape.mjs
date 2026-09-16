// 0003 — the transcription worker entry is named `worker`, the same on every node.
//
// Hand-applied on do on 2026-09-15 and never on kg. The target, as do carries it, under the
// ACTIVE profile (transcription_service[use_config]): the fallback entry formerly named `remote`
// is named `worker`, both in fallback_order AND as the block key. Its `type:` stays
// whisper-server-remote - src/transcription-pipeline.mjs dispatches on type, never on the key,
// so the rename changes no behaviour.
//
// THE KEY NAME ONLY. Deliberately NOT touched:
//   - transcription_service.enabled: off on kg by operator decision (2026-09-13), a separate
//     choice from the shape.
//   - cli.model_path: whatever each node has stays. do's hand-applied ggml-base.bin was a
//     response to memory exhaustion whose cause was not the model size - the worker rung was
//     failing, so every note fell through to the CLI while the resident model was still loaded.
//     That is a separate defect, and pointing kg at a smaller model would only hide it
//     (operator, 2026-09-16).
//
// The edit goes through the splice (src/tools/config-io.mjs): only the bytes of the key and of
// the one list element change; every comment and every other byte stays. A profile that is not
// the shape this migration knows is refused by name, never guessed at.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlScalar, spliceYamlKey } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = 'transcription: the resident worker entry is named `worker`, not `remote`';

const REMOTE_TYPE = 'whisper-server-remote';

const refuse = (why) => { throw new Error(`0003 refuses: ${why}`); };

export async function plan(ctx) {
  const file = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(file)) refuse(`there is no ${file}`);
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  // A splice works on characters. If decoding and re-encoding does not give back the same
  // bytes, writing the result would change bytes nobody edited - so do not.
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; a splice would re-encode bytes it never meant to touch`);

  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);
  const tx = doc.toJS()?.transcription_service;
  if (tx === undefined) return { satisfied: true, notes: ['no transcription_service block - nothing of this shape on this node'] };

  const name = tx?.use_config;
  const profile = tx?.[name];
  const at = `transcription_service.${name}`;
  if (typeof name !== 'string' || !profile || typeof profile !== 'object') refuse(`transcription_service.use_config (${JSON.stringify(name)}) names no profile block`);
  const order = profile.fallback_order;
  if (!Array.isArray(order)) refuse(`${at}.fallback_order is not a list`);

  const hasRemote = Object.hasOwn(profile, 'remote');
  const hasWorker = Object.hasOwn(profile, 'worker');
  if (hasRemote && hasWorker) refuse(`${at} has BOTH a remote and a worker block - which one is live is a human decision`);

  // NOTHING TO RENAME IS NOT A REFUSAL. A refusal stops the chain on EVERY deploy, so a profile this
  // migration has no business with must read satisfied - or it blocks every migration numbered
  // after it on that node, forever. That covers two shapes NODE-SHAPE.md supports: a node whose
  // entry is already `worker` (whatever its type - a local whisper-server is a `worker` too, and the
  // key name is all this migration moves), and a node with no remote entry at all, e.g. CLI-only.
  if (hasWorker) return { satisfied: true, notes: [`${at}: the worker entry is \`worker\` (fallback_order [${order.join(', ')}])`] };
  if (!hasRemote) return { satisfied: true, notes: [`${at} has no \`remote\` entry - nothing to rename (keys: ${Object.keys(profile).join(', ')})`] };

  // From here we are about to RENAME, so the `remote` must be the thing we mean.
  if (profile.remote?.type !== REMOTE_TYPE) refuse(`${at}.remote.type is ${JSON.stringify(profile.remote?.type)}, not ${REMOTE_TYPE}`);
  if (order.includes('worker')) refuse(`${at}.fallback_order names worker while the block is still remote`);
  const idx = order.indexOf('remote');
  if (idx === -1 || order.indexOf('remote', idx + 1) !== -1) refuse(`${at}.fallback_order must name remote exactly once, it is [${order.join(', ')}]`);

  let next = spliceYamlKey(text, ['transcription_service', name], { from: 'remote', to: 'worker' });
  next = spliceYamlScalar(next, ['transcription_service', name, 'fallback_order', idx], { expect: 'remote', to: 'worker' });

  // What changes, line by line. A splice never changes the line count.
  const changes = [];
  const a = text.split('\n');
  const b = next.split('\n');
  a.forEach((line, i) => {
    if (line !== b[i]) changes.push(`${file}:${i + 1}`, `  - ${line.replace(/\r$/, '')}`, `  + ${b[i].replace(/\r$/, '')}`);
  });
  changes.push('backup first, beside it: config.yaml.bak-0003-<timestamp>');

  return {
    satisfied: false,
    changes,
    apply: async () => {
      // The operator edits this file by hand, in parallel. Write only over exactly what was planned.
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      const backup = ctx.backup(file);
      ctx.log(`backup: ${backup}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
