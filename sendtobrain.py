#!/usr/bin/env python3
"""
sendtobrain.py — Types message into ChatGPT UI using CDP key events,
then submits using direct button[6] click on the form.
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

def click_send_button():
    js = '''
    (() => {
        const button = document.querySelector('form')?.querySelectorAll('button')[6];
        if (!button) return false;
        button.click();
        return true;
    })();
    '''
    result = cdp.evaluate(js)
    return result.get("result", {}).get("result", {}).get("value", False)

def reflect(msg):
    print("sending", end="", flush=True)
    if not focus_textarea():
        print(" ❌ Could not focus textarea.")
        return
    time.sleep(0.3)
    type_text(msg)
    time.sleep(0.3)
    print(" clicking send...", end="", flush=True)
    if click_send_button():
        print(" clicked.")
    else:
        print(" failed.")
    print("...sent!")

    print("\n⏳ Waiting for reply to complete...", end="")
    done = cdp.wait_for_reply_end(timeout=90)

    if not done:
        try:
            follow = input("\n↻ Press Enter to poll again, or type message to be parsed: ").strip()
            if follow:
                from main import interpret_input
                print("\n📡 Interpreted:\n" + str(interpret_input(follow, is_shell=False)))
        except KeyboardInterrupt:
            print("\n🛑 User cancelled input.")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("❌ No message provided. Must pass as CLI argument.")
        sys.exit(1)

    message = sys.argv[1]
    if message.strip():
        reflect(message.strip())
    else:
        print("❌ Message was empty. Aborting.")
