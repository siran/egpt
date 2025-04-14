#!/usr/bin/env python3
"""
sendtobrain.py — Types message into ChatGPT UI using CDP key events.
"""

import sys
import time
from cdp_instance import cdp

def focus_textarea():
    js = '''
    (() => {
        const ta = document.querySelector('textarea');
        if (!ta) return false;
        ta.focus();
        return true;
    })();
    '''
    result = cdp.evaluate(js)
    return result.get("result", {}).get("result", {}).get("value", False)

def type_text(text):
    for c in text:
        if c == "\n":
            cdp.send("Input.dispatchKeyEvent", {
                "type": "keyDown",
                "key": "Enter",
                "code": "Enter",
                "windowsVirtualKeyCode": 13,
                "nativeVirtualKeyCode": 13,
                "modifiers": 8  # Shift
            })
            cdp.send("Input.dispatchKeyEvent", {
                "type": "keyUp",
                "key": "Enter",
                "code": "Enter",
                "windowsVirtualKeyCode": 13,
                "nativeVirtualKeyCode": 13,
                "modifiers": 8
            })
        else:
            cdp.send("Input.dispatchKeyEvent", {
                "type": "char",
                "text": c,
                "unmodifiedText": c,
                "key": c
            })
        time.sleep(0.01)

def press_enter():
    cdp.send("Input.dispatchKeyEvent", {
        "type": "keyDown",
        "key": "Enter",
        "code": "Enter",
        "windowsVirtualKeyCode": 13,
        "nativeVirtualKeyCode": 13
    })
    cdp.send("Input.dispatchKeyEvent", {
        "type": "keyUp",
        "key": "Enter",
        "code": "Enter",
        "windowsVirtualKeyCode": 13,
        "nativeVirtualKeyCode": 13
    })

def reflect(msg):
    print("sending", end="", flush=True)
    focused = focus_textarea()
    if not focused:
        print("❌ Could not focus textarea.")
        return
    time.sleep(0.3)
    type_text(msg)
    time.sleep(0.3)
    press_enter()
    print("...sent!")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("❌ No message provided. Must pass as CLI argument.")
        sys.exit(1)

    message = sys.argv[1]
    if message.strip():
        reflect(message.strip())
    else:
        print("❌ Message was empty. Aborting.")
