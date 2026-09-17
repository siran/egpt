// bind-retry.mjs — a worker role's listen retries while its port is taken. The ONE bind retry,
// used by both worker roles (src/spine/transcriptor-worker.mjs, src/spine/synthesizer-worker.mjs).
//
// WHY: a spine starts while the spine it replaces still holds the port for a moment, the one
// listen fails with EADDRINUSE, and nothing tries again. :23390 on dolly 2026-09-15 13:27 and
// 14:11 (transcriptor); :23391 on dolly 2026-09-17 07:28 and 12:36 (synthesizer — kg's 🔊 readings
// stayed dead until a manual restart). It re-listens with the console limb's backoff until it
// binds or the worker stops; any other listen error stays fatal.

// The same 3s → 60s shape as the console limb's re-listen
// (src/bridges/shell-port.mjs RELISTEN_MIN_MS / RELISTEN_MAX_MS).
const BIND_RETRY_MIN_MS = 3_000;
const BIND_RETRY_MAX_MS = 60_000;

// listen: () => Promise<server>. signal: the worker's stop — aborting it ends a pending retry at
// once. onRetry(attempt, delayMs): the worker's log line for each failed attempt. Resolves the
// server, or null when stopped during a retry; throws any other listen error.
export async function listenRetrying(listen, { signal, setTimeout, clearTimeout, onRetry }) {
  for (let attempt = 1, delay = BIND_RETRY_MIN_MS; ; attempt += 1) {
    try { return await listen(); }
    catch (e) {
      if (e?.code !== 'EADDRINUSE' || signal.aborted) throw e;
      onRetry(attempt, delay);
      await new Promise((resolve) => {
        const end = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', end); resolve(); }, delay);
        signal.addEventListener('abort', end, { once: true });
      });
      if (signal.aborted) return null;
      delay = Math.min(delay * 2, BIND_RETRY_MAX_MS);
    }
  }
}
