// 0007 — a node that routes its notes to its OWN transcriptor runs that transcriptor.
//
// Measured on do, 2026-09-16: its active transcription profile sends every note to
// http://127.0.0.1:23390 - its own transcriptor endpoint - yet `transcriptor.enabled` and
// `transcriptor.server.enabled` were both false (switched off on 2026-09-15 between 14:11 and 15:04,
// during the memory incident; the 09-14 backup has both true). With the role off the worker returns
// silently at boot, :23390 never binds, the worker rung fails every note, and every note fell through
// to the CLI. kg is NOT such a node: its worker rung points at dolly, so this reads satisfied there.
//
// BOTH FLAGS, TOGETHER, OR NEITHER. With only `transcriptor.enabled` on, the worker transcribes each
// note with whisper-cli on the transcription.cli model (large-v3 on do) - a second model beside the
// WhisperServer service's resident one, which is the double load that exhausted do's memory. With
// `server.enabled` on as well, the worker ADOPTS the service's server instead (the fix shipped with
// this migration). So both are written in one splice-verified write.
//
// WHICH NODE IS ITS OWN WORKER is not re-derived here: it is src/spine/transcriptor-worker.mjs's
// routesToOwnTranscriptor, the same definition the worker uses to warn at boot.
//
// THE WORKER READS THESE FLAGS ONLY AT BOOT (there is no config watcher), so flipping them changes
// nothing until the spine next starts. Apply this BEFORE the deploy that ships the adopt/guard fix,
// so the new code boots with the role already on - otherwise the node declines every note until a
// second restart.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlScalar } from '../src/tools/config-io.mjs';
import { routesToOwnTranscriptor } from '../src/spine/transcriptor-worker.mjs';

export const elevated = false;
export const summary = 'a node that routes notes to its own transcriptor runs it (transcriptor.enabled + server.enabled)';

const refuse = (why) => { throw new Error(`0007 refuses: ${why}`); };

export async function plan(ctx) {
  const file = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(file)) refuse(`there is no ${file}`);
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; a splice would re-encode bytes it never meant to touch`);

  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);
  const cfg = doc.toJS() ?? {};

  // ctx.localAddresses is a test seam; production reads this machine's real interfaces.
  const own = routesToOwnTranscriptor(cfg, ctx.localAddresses ? { localAddresses: ctx.localAddresses } : undefined);
  if (!own) return { satisfied: true, notes: ['this node does not route notes to its own transcriptor - nothing to enable'] };

  const tx = cfg.transcriptor;
  if (!tx || typeof tx !== 'object') refuse(`${own.at} sends notes to ${own.endpoint} on this node, but there is no transcriptor: block, and a splice cannot insert one`);
  if (!tx.server || typeof tx.server !== 'object') refuse(`${own.at} sends notes to ${own.endpoint} on this node, but transcriptor has no server: block, and a splice cannot insert one`);
  if (!Object.hasOwn(tx, 'enabled')) refuse('transcriptor has no enabled: key, and a splice cannot insert one');
  if (!Object.hasOwn(tx.server, 'enabled')) refuse('transcriptor.server has no enabled: key, and a splice cannot insert one');

  // The worker's server needs a model path even when it only adopts a running server: it falls back
  // to transcription.cli.model_path when transcriptor.server.model is unset.
  const model = tx.server.model ?? cfg.transcription?.cli?.model_path;
  if (typeof model !== 'string' || !model.trim()) refuse('neither transcriptor.server.model nor transcription.cli.model_path is set - the worker would have no model to name');

  if (tx.enabled === true && tx.server.enabled === true) {
    return { satisfied: true, notes: [`${own.at} sends notes to ${own.endpoint}, and the transcriptor and its server are on`] };
  }
  for (const [label, v] of [['transcriptor.enabled', tx.enabled], ['transcriptor.server.enabled', tx.server.enabled]]) {
    if (typeof v !== 'boolean') refuse(`${label} is ${JSON.stringify(v)}, not true or false`);
  }

  let next = text;
  if (tx.enabled !== true) next = spliceYamlScalar(next, ['transcriptor', 'enabled'], { expect: tx.enabled, to: true });
  if (tx.server.enabled !== true) next = spliceYamlScalar(next, ['transcriptor', 'server', 'enabled'], { expect: tx.server.enabled, to: true });

  const changes = [`because ${own.at} sends notes to ${own.endpoint}, on this node:`];
  const a = text.split('\n');
  const b = next.split('\n');
  a.forEach((line, i) => {
    if (line !== b[i]) changes.push(`${file}:${i + 1}`, `  - ${line.replace(/\r$/, '')}`, `  + ${b[i].replace(/\r$/, '')}`);
  });
  changes.push('takes effect at the next spine start (the worker reads these only at boot)');
  changes.push('backup first, beside it: config.yaml.bak-0007-<timestamp>');

  return {
    satisfied: false,
    changes,
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      const backup = ctx.backup(file);
      ctx.log(`backup: ${backup}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
