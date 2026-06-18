export async function bootSpineRuntime({
  engine,
  startSpineRuntime,
  processObj = process,
  onExit = () => {},
} = {}) {
  if (!engine || typeof engine.startAttach !== 'function') {
    throw new Error('bootSpineRuntime: engine.startAttach required');
  }
  if (typeof startSpineRuntime !== 'function') {
    throw new Error('bootSpineRuntime: startSpineRuntime required');
  }

  const stopSpineRuntime = startSpineRuntime();
  await engine.startAttach();
  processObj.on('exit', (code) => onExit(code, stopSpineRuntime));
  return stopSpineRuntime;
}

export function stopSpineRuntimeOnExit({
  code = 0,
  bridge = null,
  waBridge = null,
  clearNucleusInfoSync = () => {},
  clearPidfile = () => {},
  stopAliveHeartbeat = () => {},
  stopSpineRuntime = null,
  engine = null,
  llamaProc = null,
} = {}) {
  bridge?.stop?.();
  waBridge?.stop?.();
  try { clearNucleusInfoSync(); } catch {}
  if (code !== 0) {
    try { llamaProc?.kill?.(); } catch {}
  }
  clearPidfile();
  stopAliveHeartbeat();
  stopSpineRuntime?.();
  engine?.stop?.();
}
