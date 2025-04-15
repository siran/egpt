import sys
import requests
from chromebridge_cdp import ChromeCDP

def find_chatgpt_ws_url():
    try:
        targets = requests.get("http://localhost:9222/json").json()
        for t in targets:
            taburl = t.get("url", "")
            print(f"🔎 inspecting tab: {taburl}")
            if "chat.openai.com" in taburl or "chatgpt.com" in taburl:
                print(f"✅ matched: {taburl}")
                return t.get("webSocketDebuggerUrl")
        print("❌ No matching ChatGPT tab found.")
        return None
    except Exception as e:
        print("❌ Failed to query CDP targets:", e)
        return None

cdp = ChromeCDP()
ws_url = find_chatgpt_ws_url()
if ws_url and cdp.connect(ws_url):
    print("🧠 CDP connected.")
else:
    print("🛑 Fatal: could not connect to ChatGPT via CDP.")
    sys.exit(1)
