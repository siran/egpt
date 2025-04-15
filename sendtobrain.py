#!/usr/bin/env python3
"""
sendtobrain.py — Inject message into ChatGPT UI via CDP using #prompt-textarea with focus and event dispatch.
"""

import sys
import time
from cdp_instance import cdp

def press_enter():
    cdp.send("Input.dispatchKeyEvent", {
        "type": "keyDown", "key": "Enter", "code": "Enter",
        "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13
    })
    cdp.send("Input.dispatchKeyEvent", {
        "type": "keyUp", "key": "Enter", "code": "Enter",
        "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13
    })

def wait_for_reply_end(timeout=90, poll_interval=1, stable_time=6):
    print("⏳ Waiting for reply to finish", end="", flush=True)
    js = '''
    (() => {
        const btn = document.querySelector('form')?.querySelectorAll('button')[6];
        if (!btn) return "none";
        return btn.getAttribute("aria-label") || "none";
    })();
    '''
    start = time.time()
    recent = []
    try:
        while time.time() - start < timeout:
            result = cdp.evaluate(js)
            label = result.get("result", {}).get("result", {}).get("value", "")
            print(f"\n🧪 aria-label: {label}", flush=True)
            recent.append(label)
            if len(recent) > 3:
                recent = recent[-3:]
                if recent[0] == recent[1] == recent[2] and (time.time() - start) > stable_time:
                    print(" ✅")
                    return True
            print(".", end="", flush=True)
            time.sleep(poll_interval)
    except KeyboardInterrupt:
        print(" 🛑 [cancelled by user]")
        return False
    print(" ⏱️ timeout")
    return False

def reflect(msg):
    print("📤 Injecting into #prompt-textarea...")
    js = f"""
    (() => {{
        const div = document.querySelector('#prompt-textarea');
        if (!div) return false;
        div.focus();
        div.innerText = `{msg}`;
        div.dispatchEvent(new InputEvent('input', {{ bubbles: true, data: `{msg}` }}));
        div.dispatchEvent(new Event('change', {{ bubbles: true }}));
        return true;
    }})();
    """
    result = cdp.evaluate(js)
    injected = result.get("result", {}).get("result", {}).get("value", False)
    if injected:
        time.sleep(0.3)
        press_enter()
        print(" ✅ Sent.")
        wait_for_reply_end()
    else:
        print(" ❌ Injection failed — #prompt-textarea not found.")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("❌ No message provided. Must pass as CLI argument.")
        sys.exit(1)

    message = sys.argv[1]
    if message.strip():
        reflect(message.strip())
    else:
        print("❌ Message was empty. Aborting.")
