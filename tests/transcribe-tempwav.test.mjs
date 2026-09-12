// Where the decoded 16kHz wav is written, and that it always goes away.
//
// Live on reve 2026-09-12: the wav was written as `<source>.tmp.wav`, i.e. INSIDE the
// messaging client's media store. On a LocalSystem Beeper that store lives under the
// system profile — the spine user could not write there (ffmpeg exited 4294967283 ==
// -13, access denied, and every voice note failed), and once granted write it still
// could not DELETE, so the scratch wavs piled up. Both halves are locked here.
//
// ffmpeg/whisper are faked by mocking node:child_process (same importActual shape as
// tests/outbox-send.test.mjs's node:os mock) — the seam has to be the spawn itself,
// since the path under test is the one _run() hands to ffmpeg.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { runner } = vi.hoisted(() => ({ runner: { current: null } }));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return { ...actual, spawn: (cmd, args) => runner.current(cmd, args) };
});

const { convertToWav16k, transcribeAudioFile } = await import('../src/tools/transcribe.mjs');

const FFMPEG = 'ffmpeg-fake';
const WHISPER = 'whisper-fake';
const ONE_SEC_WAV = Buffer.alloc(44 + 32000);   // 16kHz mono s16le → wavDurationSec 1

// _run attaches its listeners synchronously after spawn returns, so emit on the next tick.
function fakeChild({ code = 0, stdout = '', stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('exit', code);
  });
  return child;
}

let srcDir, audio, wavPaths;

// Route by command. `ffmpeg` gets the real ACL behaviour of the live store: it can read
// the source, but writing the output INTO `deniedDir` fails the way it failed on the ear.
function install({ deniedDir = null, ffmpegCode = 0, ffmpegWrites = true, whisperCode = 0, transcript = 'hola' } = {}) {
  runner.current = (cmd, args) => {
    if (cmd === FFMPEG) {
      const out = args[args.length - 1];
      wavPaths.push(out);
      if (deniedDir && dirname(out) === deniedDir) return fakeChild({ code: 4294967283, stderr: 'Permission denied' });
      if (ffmpegWrites) writeFileSync(out, ONE_SEC_WAV);
      return fakeChild({ code: ffmpegCode });
    }
    return fakeChild({ code: whisperCode, stdout: whisperCode === 0 ? `${transcript}\n` : '', stderr: whisperCode === 0 ? '' : 'model load failed' });
  };
}

beforeEach(() => {
  srcDir = mkdtempSync(join(tmpdir(), 'egpt-transcribe-src-'));
  audio = join(srcDir, 'note.ogg');
  writeFileSync(audio, Buffer.from('fake-audio-bytes'));
  wavPaths = [];
});
afterEach(() => {
  for (const p of wavPaths) rmSync(p, { force: true });
  rmSync(srcDir, { recursive: true, force: true });
  runner.current = null;
});

describe('convertToWav16k — scratch goes to the OS temp dir', () => {
  it('transcribes a source whose directory is NOT writable, and leaves nothing in it', async () => {
    install({ deniedDir: srcDir });
    const meta = {};
    const text = await transcribeAudioFile(audio, { ffmpeg_command: FFMPEG, command: WHISPER, model_path: 'm.bin' }, () => {}, meta);

    expect(text).toBe('hola');
    expect(wavPaths).toHaveLength(1);
    expect(dirname(wavPaths[0])).toBe(tmpdir());       // not beside the source
    expect(readdirSync(srcDir)).toEqual(['note.ogg']); // and nothing dropped there
    expect(meta.durationSec).toBe(1);                  // the temp wav was really statable
  });

  it('names the wav uniquely per call — same source, concurrent notes', async () => {
    install();
    const [a, b] = await Promise.all([convertToWav16k(audio, FFMPEG), convertToWav16k(audio, FFMPEG)]);
    expect(a).not.toBe(b);
    expect(dirname(a)).toBe(tmpdir());
    expect(dirname(b)).toBe(tmpdir());
  });

  it('removes its own partial wav when ffmpeg fails (the caller never gets the path)', async () => {
    install({ ffmpegCode: 1 });   // writes a partial file, THEN exits nonzero
    await expect(convertToWav16k(audio, FFMPEG)).rejects.toThrow();
    expect(wavPaths).toHaveLength(1);
    expect(existsSync(wavPaths[0])).toBe(false);
    expect(readdirSync(srcDir)).toEqual(['note.ogg']);
  });
});

describe('transcribeAudioFile — the temp wav never survives the call', () => {
  it('cleans up when the transcode step throws', async () => {
    install({ ffmpegCode: 1 });
    expect(await transcribeAudioFile(audio, { ffmpeg_command: FFMPEG, command: WHISPER, model_path: 'm.bin' })).toBe(null);
    expect(existsSync(wavPaths[0])).toBe(false);
    expect(readdirSync(srcDir)).toEqual(['note.ogg']);
  });

  it('cleans up when whisper throws', async () => {
    install({ whisperCode: 1 });
    expect(await transcribeAudioFile(audio, { ffmpeg_command: FFMPEG, command: WHISPER, model_path: 'm.bin' })).toBe(null);
    expect(existsSync(wavPaths[0])).toBe(false);
    expect(readdirSync(srcDir)).toEqual(['note.ogg']);
  });

  it('cleans up on the happy path too', async () => {
    install();
    expect(await transcribeAudioFile(audio, { ffmpeg_command: FFMPEG, command: WHISPER, model_path: 'm.bin' })).toBe('hola');
    expect(existsSync(wavPaths[0])).toBe(false);
  });
});
