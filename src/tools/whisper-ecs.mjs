// whisper-ecs.mjs — an on-demand whisper-server behind an ECS service: desired 1 to wake it,
// desired 0 to put it back to sleep after idle_stop_ms with no note in flight.
// `api` is src/tools/aws-ecs.mjs createEcsClient (or a fake); the decode itself is the pipeline's.

// whisper-server answers GET / with its page once the model is loaded.
async function serverAnswers(url, timeoutMs) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })).ok; }
  catch { return false; }
}

export function createEcsWaker({
  eng, api,
  ready = serverAnswers,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimer = clearTimeout,
  onLog = () => {},
}) {
  const label = `gpu "${eng.name}" (${eng.cluster}/${eng.service})`;
  const port = eng.port ?? 8089;
  const wakeTimeoutMs = eng.wake_timeout_ms ?? 240_000;
  const idleStopMs = eng.idle_stop_ms ?? 1_200_000;
  const pollMs = eng.poll_ms ?? 5_000;
  const probeMs = eng.connect_timeout_ms ?? 3_000;
  const cooldownMs = eng.cooldown_ms ?? 600_000;

  let url = null;          // the ready task's whisper-server
  let awake = false;       // desired may be 1: the idle stop owes it a 0
  let inFlight = 0;
  let waking = null;       // the ONE wake every note arriving meanwhile shares
  let stopping = null;
  let idleTimer = null;
  let downUntil = 0;       // after a failed wake: quick checks only, no waiting

  async function wake() {
    const t0 = now();
    await stopping;
    const { desiredCount } = await api.describeService();
    awake = true;
    if (desiredCount < 1) { await api.setDesired(1); onLog(`${label}: waking (desired 0→1)`); }
    else onLog(`${label}: desired ${desiredCount}, waiting for its task`);
    for (;;) {
      const ip = await api.runningTaskIp();
      if (ip && await ready(`http://${ip}:${port}`, probeMs)) {
        onLog(`${label}: ready at ${ip}:${port} in ${Math.round((now() - t0) / 1000)}s`);
        return `http://${ip}:${port}`;
      }
      const left = t0 + wakeTimeoutMs - now();
      if (left <= 0) throw new Error(`not ready within ${Math.round(wakeTimeoutMs / 1000)}s`);
      await sleep(Math.min(pollMs, left));
    }
  }

  // { url } of a ready worker, or { url: null, why } (already logged once, however many notes shared it).
  // Every acquire() is paired with a release(), whatever it returned.
  async function acquire({ onWait = async () => {} } = {}) {
    inFlight++;
    if (idleTimer) { clearTimer(idleTimer); idleTimer = null; }
    if (url && await ready(url, probeMs)) return { url };
    url = null;
    if (now() < downUntil) return quickCheck();
    await onWait();
    if (url) return { url };
    waking ??= wake().then(
      (u) => { url = u; return { url: u }; },
      (e) => {
        const why = e?.message ?? String(e);
        downUntil = now() + cooldownMs;
        onLog(`${label}: ${why} — next engine; no waiting for ${Math.round(cooldownMs / 60_000)} min`);
        return { url: null, why };
      },
    ).finally(() => { waking = null; });
    return waking;
  }

  // Cooldown: one look for a task that came up anyway (ECS keeps trying), never a wait or an UpdateService.
  async function quickCheck() {
    try {
      const ip = await api.runningTaskIp();
      if (ip && await ready(`http://${ip}:${port}`, probeMs)) {
        url = `http://${ip}:${port}`; awake = true; downUntil = 0;
        onLog(`${label}: ready at ${ip}:${port} (found during cooldown)`);
        return { url };
      }
    } catch { /* still down: the failed wake already said why */ }
    return { url: null, why: 'cooling down after a failed wake' };
  }

  function release() {
    inFlight = Math.max(0, inFlight - 1);
    if (inFlight === 0 && awake) armIdle();
  }

  function armIdle() {
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = setTimer(sleepNow, idleStopMs);
  }

  function sleepNow() {
    idleTimer = null;
    if (inFlight > 0 || !awake) return;
    awake = false; url = null;
    stopping = api.setDesired(0).then(
      () => onLog(`${label}: asleep (desired 0 after ${Math.round(idleStopMs / 60_000)} min idle)`),
      (e) => { awake = true; onLog(`${label}: idle stop failed (${e?.message ?? e}) — retrying in ${Math.round(idleStopMs / 60_000)} min`); if (inFlight === 0) armIdle(); },
    ).finally(() => { stopping = null; });
  }

  // Boot: a service left awake by a previous run gets its idle stop, unless a note already holds it.
  async function boot() {
    try {
      const { desiredCount } = await api.describeService();
      if (desiredCount < 1) return;
      awake = true;
      if (inFlight === 0 && !idleTimer) { armIdle(); onLog(`${label}: awake at boot — idle stop in ${Math.round(idleStopMs / 60_000)} min`); }
    } catch (e) { onLog(`${label}: boot check failed (${e?.message ?? e})`); }
  }

  function stop() { if (idleTimer) { clearTimer(idleTimer); idleTimer = null; } }

  return { acquire, release, boot, stop };
}
