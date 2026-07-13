// brain-errors.mjs — pure brain/CLI error-result predicates, lifted out of the
// old-spine dispatch.mjs (dies at cutover) so v2 doesn't drag that 56 KB file in.

// The resumed claude session + the new message overflowed the model's context
// window. Distinct from a missing-resume (the session loads fine; it's just too
// big now) and from a generic brain failure. Recovery = reset the thread and
// retry fresh; transcript.md preserves the conversation regardless. (Confirmed
// 2026-06-21: SPOILER's session grew to 4 MB / 179k tok and the periodic
// compactor couldn't reduce it, so the live being kept emitting this verbatim.)
export function isContextOverflowError(text) {
  const msg = String(text ?? '');
  return /prompt is too long/i.test(msg)
    || /too many tokens/i.test(msg)
    || /maximum context length/i.test(msg)
    || /context (?:window|length)[^.]{0,40}exceed/i.test(msg)
    || /exceed[^.]{0,40}context (?:window|length)/i.test(msg);
}

// The CLI's own session store no longer has the resumed session (e.g. its
// cwd-keyed store moved/renamed out from under a stored threadId). Distinct
// from context-overflow (the session loads fine; it's just too big) and from
// the legacy isMissingResumeError in dispatch.mjs (the per-contact dispatch path's
// "no rollout found" / "resume failed" shape) — this is the CLI's own exact
// error string. Recovery = reset the thread and retry fresh, same as overflow.
export function isDeadSessionError(text) {
  const msg = String(text ?? '');
  return /no conversation found with session id/i.test(msg);
}

export function isBrainFailureResult(text) {
  const msg = String(text ?? '').trim();
  return /^!!\s+/.test(msg)
    || /^\[(?:codex|claude(?:-sdk|-code)?)\s+(?:exit|timed out)\b/i.test(msg)
    || /invalid_request_error/i.test(msg)
    || /model .*not supported/i.test(msg)
    || /not supported when using Codex/i.test(msg)
    || /\b(?:401|403|429)\b/.test(msg)
    || /\b(?:unauthorized|authentication|rate.?limit|quota)\b/i.test(msg);
}
