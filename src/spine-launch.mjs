import { bootSpineRuntime } from './spine-runtime.mjs';

export async function launchSpineProcess({
  mode = 'interactive',
  engine,
  startSpineRuntime,
  processObj = process,
  takeoverIfRunning,
  writePidfile,
  startAliveHeartbeat,
  startSpineOutputLog,
  log = console.log,
  onExit = () => {},
} = {}) {
  if (typeof takeoverIfRunning !== 'function') {
    throw new Error('launchSpineProcess: takeoverIfRunning required');
  }
  if (typeof writePidfile !== 'function') {
    throw new Error('launchSpineProcess: writePidfile required');
  }
  if (typeof startAliveHeartbeat !== 'function') {
    throw new Error('launchSpineProcess: startAliveHeartbeat required');
  }
  if (typeof startSpineOutputLog !== 'function') {
    throw new Error('launchSpineProcess: startSpineOutputLog required');
  }

  await takeoverIfRunning(mode);
  writePidfile(mode);
  startAliveHeartbeat();
  const stopOutputLog = startSpineOutputLog();
  log(`egpt spine booted (${mode})`);

  return bootSpineRuntime({
    engine,
    startSpineRuntime,
    processObj,
    onExit: (code, stopSpineRuntime) => onExit({
      code,
      stopSpineRuntime,
      stopOutputLog,
    }),
  });
}
