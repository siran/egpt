#!/usr/bin/env python3
"""
sendtobrain.py — Injects ChatGPT message via ProseMirror-compatible innerHTML (<p> blocks).
"""

import sys
import time
import html
import json
from cdp_instance import cdp

def press_enter():
    js_click = '''
    (() => {
        const btn = document.querySelector('button#composer-submit-button');
        if (!btn) return false;
        btn.click();
        console.log("🚀 Submit button clicked.");
        return true;
    })();
    '''
    result = cdp.evaluate(js_click)
    return result.get("result", {}).get("result", {}).get("value", False)

def reflect(msg, source="shell"):
    print("📤 Injecting content...")
    try:
        # Escape HTML and split by lines
        lines = html.escape(msg).splitlines()
        wrapped = "".join(f"<p>{line}</p>" for line in lines)
        wrapped_escaped = wrapped.replace("`", "\\`")

        js = f"""
        (() => {{
            const ta = document.querySelector('#prompt-textarea');
            if (!ta) {{
                console.log("❌ Textarea not found.");
                return false;
            }}
            ta.focus();
            ta.innerHTML = `{wrapped_escaped}`;
            ta.dispatchEvent(new InputEvent('input', {{ bubbles: true }}));
            ta.dispatchEvent(new Event('change', {{ bubbles: true }}));
            console.log("✅ innerHTML injected with <p> blocks.");
            return true;
        }})();
        """

        result = cdp.evaluate(js)
        injected = result.get("result", {}).get("result", {}).get("value", False)
        if not injected:
            print("❌ Text injection failed.")
            return

        time.sleep(0.3)
        if press_enter():
            print("✅ Message submitted.")
        else:
            print("❌ Failed to click submit button.")

    except Exception as e:
        import traceback
        print(f"❌ Failed to inject message: {e}")
        traceback.print_exc()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("❌ No message provided. Must pass as CLI argument.")
        sys.exit(1)

    message = sys.argv[1]
    if message.strip():
        reflect(message.strip())
    else:
        print("❌ Message was empty. Aborting.")
