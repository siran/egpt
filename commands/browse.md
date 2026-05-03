---
command: browse
---
[browse task — augmented browsing via CDP]

{{task_block}}

━━ MANDATORY: use the browser-tools CDP library — DO NOT use curl, fetch, or any HTTP client ━━
Chrome is running at http://{{cdp_host}} with the user's real logged-in session.
You MUST write and execute a Node.js script that imports and uses browser-tools.

import * as browser from '{{browser_tools_url}}';

Starter pattern:
  const id = await browser.openTab({{url_arg}});
  await browser.waitForLoad(id);
  // interact with the page here
  const text = await browser.getText(id);
  await browser.closeTab(id);

Full API:
  browser.openTab(url)                  -> targetId
  browser.navigate(id, url)
  browser.waitForLoad(id, timeoutMs?)
  browser.getText(id, selector?)        -> string
  browser.evaluate(id, 'expression')    -> primitive
  browser.click(id, 'selector')
  browser.type(id, 'selector', 'text')
  browser.scroll(id, x, y)
  browser.waitForElement(id, 'selector', timeoutMs?)
  browser.getUrl(id)  browser.getTitle(id)
  browser.closeTab(id)
  browser.waitForHuman('message')       — pauses; user acts in browser, types /continue

CAPTCHAs / Cloudflare / login / 2FA: call waitForHuman() — user sees a banner and can act.

Return plain text suitable for Telegram (no markdown, use newlines).
For products: name · price · URL, one per line.
