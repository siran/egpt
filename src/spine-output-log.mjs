import { appendFileSync, renameSync, statSync, unlinkSync } from 'node:fs';

export function startSpineOutputLog({
  engine,
  logPath,
  file = 'egpt-spine.mjs',
  pid = process.pid,
  maxBytes = 500 * 1024,
} = {}) {
  if (!engine || typeof engine.subscribe !== 'function') {
    throw new Error('startSpineOutputLog: engine.subscribe required');
  }
  if (!logPath) {
    throw new Error('startSpineOutputLog: logPath required');
  }

  const backupPath = `${logPath}.1`;
  const rotateIfBig = () => {
    try {
      const st = statSync(logPath);
      if (st.size <= maxBytes) return;
      try { unlinkSync(backupPath); } catch {}
      renameSync(logPath, backupPath);
    } catch {}
  };

  rotateIfBig();
  try {
    appendFileSync(
      logPath,
      `\n[${new Date().toISOString()}] egpt spine starting (pid ${pid}, file ${file})\n`,
      { mode: 0o600 },
    );
  } catch {}

  return engine.subscribe((item) => {
    if (item?._log) return;
    try {
      rotateIfBig();
      const author = item?.author ?? 'system';
      const body = String(item?.body ?? '').trimEnd();
      appendFileSync(
        logPath,
        `[${new Date().toISOString()}] ${author}: ${body}\n`,
        { mode: 0o600 },
      );
    } catch {}
  });
}
