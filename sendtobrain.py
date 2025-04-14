#!/usr/bin/env python3
"""
sendtobrain.py — Injects a message into ChatGPT UI via CDP.
Now only accepts message via command-line argument.
"""

import sys
import time
from cdp_instance import cdp

def reflect(msg):
    print("sending", end="", flush=True)
    cdp.focus_chat()
    time.sleep(0.5)
    # for _ in range(5):
    #     time.sleep(5)
    #     print(".", end="", flush=True)
    for c in msg:
        if c == "\n":
            cdp.send("Input.dispatchKeyEvent", {
                "type": "keyDown",
                "key": "Enter",
                "code": "Enter",
                "windowsVirtualKeyCode": 13,
                "nativeVirtualKeyCode": 13,
                "modifiers": 8
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
    time.sleep(0.3)
    cdp.press_enter()
    print("sent!")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("❌ No message provided. Must pass as CLI argument.")
        sys.exit(1)

    message = sys.argv[1]
    if message.strip():
        reflect(message.strip())
    else:
        print("❌ Message was empty. Aborting.")
