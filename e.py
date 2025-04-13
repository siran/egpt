#!/usr/bin/env python3
"""
e.py — Embodied GPT Daemon (CDP Watcher — Restored Working Version)
"""

import time
from main import cdp, interpret_input

cdp.connect()

seen = {}

def initialize_seen():
    js = '''
    (() => {
        return Array.from(document.querySelectorAll("[data-message-id]")).map(el => {
            const id = el.getAttribute("data-message-id") || "";
            const role = el.closest('[data-message-author-role]')?.getAttribute('data-message-author-role') || "assistant";
            const text = el.innerText || "";
            return { id, role, text };
        });
    })()
    '''
    try:
        init = cdp.evaluate(js)["result"]["result"]["value"]
        return {m["id"]: m["text"] for m in init[-2:] if m["id"] and m["text"].strip()}
    except Exception as e:
        print("⚠️ Init failed:", e)
        return {}

seen = initialize_seen()

def fetch_chat():
    js = '''
    (() => {
        return Array.from(document.querySelectorAll("[data-message-id]")).map(el => {
            const id = el.getAttribute("data-message-id") || "";
            const role = el.closest('[data-message-author-role]')?.getAttribute('data-message-author-role') || "assistant";
            const text = el.innerText || "";
            return { id, role, text };
        });
    })()
    '''
    result = cdp.evaluate(js)
    return result.get("result", {}).get("result", {}).get("value", [])[-4:]

def loop():
    print("🧠 e is watching ChatGPT via CDP. Press Ctrl+C to stop.\n")
    while True:
        try:
            msgs = fetch_chat()
            for msg in msgs[-2:]:
                msg_id = msg.get("id")
                txt = msg.get("text", "").strip()
                if not msg_id or not txt:
                    continue
                last = seen.get(msg_id)
                if last == txt:
                    continue
                seen[msg_id] = txt
                prefix = "🧍 You:" if msg["role"] == "user" else "🤖 e:"
                print("\n" + prefix + "\n" + txt)
                parsed = interpret_input(txt)
                if parsed:
                    print("\n📡 Interpreted:\n" + parsed)
                    if parsed.startswith("⚙️ Proposed Command"):
                        try:
                            response = input("\n🧠 Approve? y/n > ").strip()
                            result = interpret_input(response)
                            if result:
                                print("\n" + result)
                        except Exception as e:
                            print("⚠️ input() error:", e)
            time.sleep(3)
        except KeyboardInterrupt:
            print("\n👋 Exiting.")
            break
        except Exception as e:
            print("🔥 Loop error:", e)
            time.sleep(2)

if __name__ == "__main__":
    while True:
        loop()
        print('\n\n--- \n... restarting ... \n---\n\n')
