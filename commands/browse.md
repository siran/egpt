---
command: browse
---
[browse task] use CDP  to: {{task}}

Chrome is live with the user's real session — connect via port 9222 (visible browser window). Do NOT launch a new browser instance or use Playwright/Puppeteer. Node.js v22 has native `fetch` + `WebSocket` — no libraries needed.

CDP quick reference:
- List tabs: `fetch('http://{{cdp_host}}/json/list').then(r => r.json())`
- New tab: `fetch('http://{{cdp_host}}/json/new?'+encodeURIComponent(url), {method:'PUT'}).then(r=>r.json())`
- Connect: `new WebSocket(tab.webSocketDebuggerUrl)`
- Send command: `ws.send(JSON.stringify({id, method, params}))` / await reply via `ws.onmessage`
- Evaluate JS: `send('Runtime.evaluate', {expression: '...', returnByValue: true})`
- Wait for load: poll `Runtime.evaluate` with `document.readyState === 'complete'`

Return Markdown-formatted text. Use **bold**, *italic*, `code`, and links where appropriate.
