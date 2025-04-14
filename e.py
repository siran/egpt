#!/usr/bin/env python3
"""
e.py — Embodied GPT Daemon (CDP Watcher — Restored Reflex Loop)
"""
seen = {}

def initialize_seen(cdp):
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

    while True:
        from main import interpret_input
        try:
            msgs = fetch_chat()
            for msg in msgs[-2:]:
                msg_id = msg.get("id")
                txt = msg.get("text", "").strip()
                if not msg_id or not txt:
                    continue
                last = seen.get(msg_id)
                if last == txt:
                    resp = input('Press enter to continue... ctrl-break to reload.')
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
        import time
        from cdp_instance import cdp
        seen = initialize_seen(cdp)
        print("Starting 🧠 e ... Press Ctrl+C to stop.\n")
        loop()
        print('\n\n--- \n... restarting ... \n---\n\n')
