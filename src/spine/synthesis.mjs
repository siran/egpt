// synthesis.mjs — the voice-reply TTS service. Wraps the kept
// buildSynthesisPipeline with its real engine (piper-server-remote →
// synthesizeViaEndpoint), resolving the active profile from config
// voice_service[use_config] — mirrors transcription.mjs's profile resolution, but
// this is NOT a per-chat resolver: no conv-state IO, no posts-back logic. The
// profile's `voice` key is the ONE home for "which voice is egpt's own voice".
import { buildSynthesisPipeline } from '../synthesis-pipeline.mjs';
import { synthesizeViaEndpoint } from '../tools/synthesizer.mjs';
import { readSecret, SYNTH_TOKEN_FILE } from '../secrets.mjs';
import { EGPT_HOME } from '../egpt-home.mjs';

export function createVoiceSynthesis({
  getConfig = () => ({}),
  onLog = () => {},
  home = EGPT_HOME,
} = {}) {
  const cfg = getConfig() ?? {};
  const vsCfg = cfg.voice_service;
  const profile = vsCfg?.[vsCfg?.use_config] ?? {};

  const pipeline = buildSynthesisPipeline({
    profile,
    synthesizeViaEndpoint,
    token: () => readSecret(home, SYNTH_TOKEN_FILE).token,
    reachable: async (url, ms) => { try { await fetch(url, { method: 'GET', signal: AbortSignal.timeout(ms) }); return true; } catch { return false; } },
    onLog,
  });

  const voice = profile.voice ?? null;

  return { synthesize: pipeline.synthesize, voice };
}
