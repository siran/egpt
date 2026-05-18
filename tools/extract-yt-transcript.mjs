/**
 * YouTube Transcript Extractor via Chrome DevTools Protocol
 *
 * Extracts transcripts from YouTube videos by opening the page via CDP,
 * clicking the transcript button, and reading the sidebar content.
 *
 * Usage:
 *   const { extractYouTubeTranscript } = await import('./extract-yt-transcript.mjs');
 *   const transcript = await extractYouTubeTranscript(videoUrl);
 */

import { openTab, listTabs, closeTab } from './cdp.mjs';

export async function extractYouTubeTranscript(url, { verbose = false } = {}) {
  if (verbose) console.log('Opening YouTube video: ' + url);
  const targetId = await openTab(url);

  // Wait for tab to appear in listing
  let tab = null;
  const deadline = Date.now() + 6000;
  while (!tab && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 150));
    const tabs = await listTabs();
    tab = tabs.find(t => t.id === targetId);
  }

  if (!tab) throw new Error('Tab did not appear in Chrome tab list');
  if (verbose) console.log('Tab opened, waiting for YouTube to load...');

  // Wait for page to load
  await new Promise(r => setTimeout(r, 3000));

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    let msgId = 0;
    const pending = new Map();
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('Transcript extraction timeout'));
    }, 30000);

    const cleanup = () => {
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      closeTab(targetId).catch(() => {}); // Close tab in background
    };

    ws.addEventListener('error', () => {
      cleanup();
      reject(new Error('WebSocket error'));
    });

    const cdpSend = (method, params = {}) => {
      const id = ++msgId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
      });
    };

    ws.addEventListener('message', e => {
      try {
        const data = JSON.parse(e.data.toString());
        if (data.id && pending.has(data.id)) {
          const { res, rej } = pending.get(data.id);
          pending.delete(data.id);
          if (data.error) rej(new Error(data.error.message));
          else res(data.result);
        }
      } catch {}
    });

    ws.addEventListener('open', async () => {
      try {
        // Mute video first
        if (verbose) console.log('Muting video...');
        const muteScript = `(() => {
          // Mute all video elements
          const videos = document.querySelectorAll('video');
          videos.forEach(v => { v.muted = true; });

          // Also try the mute button
          const muteBtn = document.querySelector('[aria-label*="Mute"], [title*="Mute"]');
          if (muteBtn && !muteBtn.getAttribute('aria-pressed')?.includes('true')) {
            muteBtn.click();
          }
          return { muted: videos.length > 0 };
        })()`;

        try {
          await cdpSend('Runtime.evaluate', {
            expression: muteScript,
            returnByValue: true
          });
        } catch (e) {
          if (verbose) console.log('Mute result:', e.message);
        }

        // Click transcript button
        if (verbose) console.log('Clicking transcript button...');
        const clickScript = `(() => {
          const btn = document.querySelector('[aria-label*="transcript"], [aria-label*="Transcript"]');
          if (btn) {
            btn.click();
            return { clicked: true };
          }
          return { clicked: false };
        })()`;

        try {
          await cdpSend('Runtime.evaluate', {
            expression: clickScript,
            returnByValue: true
          });
        } catch (e) {
          if (verbose) console.log('Click attempt result:', e.message);
        }

        // Wait for transcript panel to load
        await new Promise(r => setTimeout(r, 5000));

        // Extract transcript via multiple methods
        if (verbose) console.log('Extracting transcript segments...');
        const extractScript = `(() => {
          // Method 1: ytd-transcript-segment-renderer (standard YouTube)
          let segments = Array.from(document.querySelectorAll('ytd-transcript-segment-renderer'));
          if (segments.length > 0) {
            const lines = segments.map(seg => {
              return (seg.textContent || '').trim();
            }).filter(t => t && t.length > 0);
            return {
              success: true,
              transcript: lines.join('\\n'),
              method: 'segments',
              count: segments.length
            };
          }

          // Method 2: Sidebar/panel with transcript content
          const transcriptPanel = document.querySelector('[role="region"] [aria-label*="transcript"]') ||
                                  document.querySelector('.transcript-panel') ||
                                  document.querySelector('[class*="transcript"]');
          if (transcriptPanel) {
            const text = transcriptPanel.innerText;
            if (text && text.length > 50 && !text.includes('Show transcript')) {
              return {
                success: true,
                transcript: text.trim(),
                method: 'panel',
                chars: text.length
              };
            }
          }

          // Method 3: Right sidebar panel
          const rightSidebar = document.querySelector('div#secondary') ||
                               document.querySelector('[aria-label*="secondary"]') ||
                               document.querySelector('div[aria-label*="panel"]');
          if (rightSidebar) {
            const text = rightSidebar.innerText;
            if (text && text.length > 100) {
              return {
                success: true,
                transcript: text.trim(),
                method: 'sidebar',
                chars: text.length
              };
            }
          }

          // Method 4: Find large text container with transcript-like content
          const allDivs = Array.from(document.querySelectorAll('div'));
          const transcriptDiv = allDivs.find(div => {
            const text = div.innerText || '';
            return text.length > 500 &&
                   (text.includes('\\n') || text.split(' ').length > 50) &&
                   !text.includes('Show transcript') &&
                   !text.includes('Advertisement');
          });

          if (transcriptDiv) {
            return {
              success: true,
              transcript: (transcriptDiv.innerText || '').trim(),
              method: 'large_div',
              chars: transcriptDiv.innerText.length
            };
          }

          return {
            success: false,
            error: 'No transcript found with any method'
          };
        })()`;

        const result = await cdpSend('Runtime.evaluate', {
          expression: extractScript,
          returnByValue: true
        });

        cleanup();

        const value = result?.result?.value;
        if (value?.success && value.transcript) {
          if (verbose) console.log('Extracted (' + value.method + '): ' + (value.count || '') + ' chars: ' + value.chars);
          resolve(value.transcript);
        } else {
          reject(new Error(value?.error || 'Failed to extract transcript'));
        }
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  });
}

// CLI entry point
const isMainModule = process.argv[1].includes('extract-yt-transcript');
if (isMainModule) {
  const videoUrl = process.argv[2] || 'https://www.youtube.com/live/AYXCkQsMqEA?si=214oLPmkYrJZPuUW';
  try {
    const transcript = await extractYouTubeTranscript(videoUrl, { verbose: true });
    console.log('\n=== TRANSCRIPT EXTRACTED ===\n');
    console.log(transcript);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}
