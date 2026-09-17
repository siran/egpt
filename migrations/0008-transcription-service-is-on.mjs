// 0008 — a node with a transcription chain has its transcription service on.
//
// Operator ruling, 2026-09-16: kg's `transcription_service.enabled` comes back on. kg offers no
// transcription itself; its notes go to dolly's worker, or its own cli when that fails
// (fallback_order [ worker, cli ]). It had been switched off by hand (operator, 2026-09-13, quoted in
// src/spine/transcription.mjs: "me touching enable was a desperate attempt"). So the rule is: a node
// whose ACTIVE profile (transcription_service[use_config]) has a non-empty fallback_order runs it.
// do already has `enabled: true` and reads satisfied.
//
// WHAT TURNING IT ON MAKES VISIBLE IN CHATS (read from src/transcription-service.mjs and
// src/bridges/beeper.mjs, 2026-09-16):
//   - NO transcript message. `posts_back` is opt-in (parseTranscriptionConfig: only an explicit `true`
//     enables it), and neither node's config.yaml sets it (as read 2026-09-16); kg also has
//     posts_back_delay_ms: -1, a hard mute. This migration does not read conversations.yaml or the entity folders: a conversation whose
//     OWN rung sets posts_back: true (with a non-negative delay) would start echoing there.
//   - The 🎧 listening reaction. beeper.mjs sets it on each voice note it transcribes, gated on this
//     same `enabled`, and removes it when the transcription ends.
//
// PER-CHAT OVERRIDES ARE NOT TOUCHED. A `transcription_service.enabled: false` in conversations.yaml or
// an entity folder is a deliberate opt-out; it still wins over the node rung.
//
// config.yaml IS READ ONCE, AT BOOT (boot.mjs: `const cfg = readConfig()`), and upgrade.ps1 runs the
// migrations after the deploy's restart: this takes effect at the next spine start.
//
// The edit goes through the splice (src/tools/config-io.mjs): one scalar, every other byte kept. A
// block with no `enabled:` needs no edit: the runtime reads a missing key as on.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlScalar } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = 'a node with a transcription chain (fallback_order) has transcription_service.enabled on';

const refuse = (why) => { throw new Error(`0008 refuses: ${why}`); };

export async function plan(ctx) {
  const file = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(file)) refuse(`there is no ${file}`);
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; a splice would re-encode bytes it never meant to touch`);

  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);
  const cfg = doc.toJS() ?? {};

  const tx = cfg.transcription_service;
  if (tx == null) return { satisfied: true, notes: ['this node has no transcription_service block - nothing to switch on'] };
  if (tx.enabled === true) return { satisfied: true, notes: ['transcription_service.enabled is already true'] };
  // enabled is opt-OUT at runtime (parseTranscriptionConfig: `enabled !== false`), so no key is ON.
  if (!Object.hasOwn(tx, 'enabled')) return { satisfied: true, notes: ['transcription_service has no enabled: key, which the runtime reads as on'] };

  const use = tx.use_config;
  const profile = tx[use];
  if (!profile || typeof profile !== 'object') refuse(`transcription_service.use_config (${JSON.stringify(use)}) names no profile block`);
  if (!Array.isArray(profile.fallback_order) || !profile.fallback_order.length) {
    refuse(`transcription_service.${use} has no fallback_order - no chain to switch on`);
  }
  if (typeof tx.enabled !== 'boolean') refuse(`transcription_service.enabled is ${JSON.stringify(tx.enabled)}, not true or false`);

  const next = spliceYamlScalar(text, ['transcription_service', 'enabled'], { expect: false, to: true });

  const changes = [`because transcription_service.${use} has the chain [${profile.fallback_order.join(', ')}], on this node:`];
  const a = text.split('\n');
  const b = next.split('\n');
  a.forEach((line, i) => {
    if (line !== b[i]) changes.push(`${file}:${i + 1}`, `  - ${line.replace(/\r$/, '')}`, `  + ${b[i].replace(/\r$/, '')}`);
  });
  changes.push('takes effect at the next spine start (config.yaml is read once, at boot)');
  changes.push('backup first, beside it: config.yaml.bak-0008-<timestamp>');

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
