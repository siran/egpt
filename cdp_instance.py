import os
import json
import requests
import time

import websocket
from chromebridge_cdp import ChromeCDP

cdp = ChromeCDP()

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

def open_chatgpt_tab(conversation_id):
    url = f"https://chat.openai.com/c/{conversation_id}"
    return cdp.create_and_navigate(url)

def switch_tab(conversation_id):
    ws_url = find_chatgpt_tab(conversation_id)
    if ws_url:
        print(f"🔁 Switching CDP to conversation ID: {conversation_id}")
        cdp.connect(ws_url)
        return True
    else:
        print(f"🧭 No tab found — launching...")
        open_chatgpt_tab(conversation_id)
        time.sleep(2)
        ws_url = find_chatgpt_tab(conversation_id)
        if ws_url:
            print(f"🔁 Connected after launching new tab.")
            cdp.connect(ws_url)
            return True
        print("❌ Still unable to connect to new tab.")
        return False
