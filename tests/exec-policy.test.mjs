import { describe, it, expect } from 'vitest';
import { validateExec, isInsideSandbox, ALLOWED_BINARIES } from '../src/exec-policy.mjs';

const SB = process.platform === 'win32' ? 'C:\\sb\\chat' : '/sb/chat';

describe('isInsideSandbox', () => {
  it('accepts paths at/under the sandbox, rejects escapes', () => {
    expect(isInsideSandbox('clip.mp4', SB)).toBe(true);
    expect(isInsideSandbox('frames/a.jpg', SB)).toBe(true);
    expect(isInsideSandbox('../other/x', SB)).toBe(false);
    expect(isInsideSandbox('../../etc/passwd', SB)).toBe(false);
    expect(isInsideSandbox(process.platform === 'win32' ? 'C:\\Windows\\x' : '/etc/passwd', SB)).toBe(false);
  });
});

describe('validateExec — allowlist + sandbox + deny patterns', () => {
  it('rejects a non-allowlisted binary (no arbitrary exe, no interpreters)', () => {
    expect(validateExec('bash', ['-c', 'rm -rf /'], { sandboxDir: SB }).ok).toBe(false);
    expect(validateExec('python', ['x.py'], { sandboxDir: SB }).ok).toBe(false);
    expect(validateExec('powershell', ['x'], { sandboxDir: SB }).ok).toBe(false);
  });

  it('allows a vetted media op on sandbox files', () => {
    expect(validateExec('ffmpeg', ['-i', 'clip.mp4', '-frames:v', '1', 'out.jpg'], { sandboxDir: SB }).ok).toBe(true);
    expect(validateExec('pdftotext', ['doc.pdf', 'doc.txt'], { sandboxDir: SB }).ok).toBe(true);
  });

  it('rejects file args that escape the sandbox', () => {
    expect(validateExec('ffmpeg', ['-i', '../../secret.mp4', 'out.jpg'], { sandboxDir: SB }).ok).toBe(false);
    expect(validateExec('pdftotext', ['/etc/passwd', 'out.txt'], { sandboxDir: SB }).ok).toBe(false);
  });

  it('blocks ffmpeg protocol/concat/file tricks (SSRF / local-file read)', () => {
    expect(validateExec('ffmpeg', ['-i', 'http://169.254.169.254/', 'out.jpg'], { sandboxDir: SB }).ok).toBe(false);
    expect(validateExec('ffmpeg', ['-i', 'file:/etc/passwd', 'out.jpg'], { sandboxDir: SB }).ok).toBe(false);
    expect(validateExec('ffmpeg', ['-i', 'concat:a|b', 'out.jpg'], { sandboxDir: SB }).ok).toBe(false);
  });

  it('a file binary may NOT take a URL; a net binary may', () => {
    expect(validateExec('magick', ['https://x/y.png', 'out.png'], { sandboxDir: SB }).ok).toBe(false);
    expect(validateExec('curl', ['https://x/y', '-o', 'y.bin'], { sandboxDir: SB }).ok).toBe(true);
    expect(validateExec('yt-dlp', ['https://youtu.be/x', '-o', 'vid.mp4'], { sandboxDir: SB }).ok).toBe(true);
  });

  it('denies net-tool flags that read local files / load configs / exfil', () => {
    expect(validateExec('curl', ['-K', 'cfg', 'https://x'], { sandboxDir: SB }).ok).toBe(false);
    expect(validateExec('curl', ['-T', 'secret', 'https://x'], { sandboxDir: SB }).ok).toBe(false);
    expect(validateExec('yt-dlp', ['--exec', 'rm', 'https://x'], { sandboxDir: SB }).ok).toBe(false);
    expect(validateExec('wget', ['--config', 'cfg', 'https://x'], { sandboxDir: SB }).ok).toBe(false);
  });

  it('requires an args ARRAY (execFile, never a shell string) + a sandboxDir', () => {
    expect(validateExec('ffmpeg', 'a; rm -rf /', { sandboxDir: SB }).ok).toBe(false);
    expect(validateExec('ffmpeg', ['-i', 'x.mp4'], {}).ok).toBe(false);
  });

  it('the allowlist excludes every interpreter / shell (no self-elevation)', () => {
    for (const bad of ['bash', 'sh', 'zsh', 'python', 'python3', 'node', 'perl', 'ruby', 'powershell', 'cmd']) {
      expect(ALLOWED_BINARIES[bad]).toBeUndefined();
    }
  });
});
