#!/usr/bin/env python3
"""
sendtobrain.py — Copies command output to clipboard via CLIP.exe,
pastes it into ChatGPT UI, and submits using simulated key events.
"""

import sys
import time
from pathlib import Path
import subprocess
from cdp_instance import cdp

TEMP_FILE = Path("temp_reflect.txt")

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

def press_ctrl_v():
    cdp.send("Input.dispatchKeyEvent", {
        "type": "keyDown",
        "modifiers": 2,
        "windowsVirtualKeyCode": 86,
        "nativeVirtualKeyCode": 86,
        "code": "KeyV",
        "key": "v"
    })
    cdp.send("Input.dispatchKeyEvent", {
        "type": "keyUp",
        "modifiers": 2,
        "windowsVirtualKeyCode": 86,
        "nativeVirtualKeyCode": 86,
        "code": "KeyV",
        "key": "v"
    })

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
    print("📋 Writing output to temp file...")
    TEMP_FILE.write_text(msg, encoding="utf-8")

    print("📥 Copying to clipboard...")
    subprocess.run(f'CLIP.exe < "{TEMP_FILE}"', shell=True)

    print("📤 Pasting into ChatGPT...", end="", flush=True)
    if not focus_textarea():
        print(" ❌ Could not focus textarea.")
        return

    time.sleep(0.4)
    press_ctrl_v()
    time.sleep(0.3)
    press_enter()
    print(" ✅ Sent.")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("❌ No message provided. Must pass as CLI argument.")
        sys.exit(1)

    message = sys.argv[1]
    if message.strip():
        reflect(message.strip())
    else:
        print("❌ Message was empty. Aborting.")
