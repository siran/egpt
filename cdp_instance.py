import os
import json
import requests
from chromebridge_cdp import ChromeCDP

def find_chatgpt_tab(conversation_id):
    try:
        targets = requests.get("http://localhost:9222/json").json()
        print("🔍 Available tabs:")
        for t in targets:
            print(f"- title: {t.get('title', '')} | url: {t.get('url', '')}")
            if conversation_id in t.get("url", ""):
                return t["webSocketDebuggerUrl"]
        return None
    except Exception as e:
        print(f"❌ Failed to query CDP targets: {e}")
        return None

cdp = ChromeCDP()

def switch_tab(conversation_id):
    ws_url = find_chatgpt_tab(conversation_id)
    if ws_url:
        print(f"🔁 Switching CDP to conversation ID: {conversation_id}")
        cdp.connect(ws_url)
        return True
    else:
        print(f"❌ Could not find conversation tab for ID: {conversation_id}")
        return False
