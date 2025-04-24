import os
import json
import traceback
import requests
import time
import websocket
from chromebridge_cdp import ChromeCDP
import output_core

cdp = ChromeCDP()

def find_chatgpt_tab(conversation_id):
    try:
        targets = requests.get("http://localhost:9222/json").json()
        output_core.send_output("shell", "🔍 Available tabs:")
        for t in targets:
            output_core.send_output("shell", f"- {t.get('title', '')} | url: {t.get('url', '')}")
            if str(conversation_id) in t.get("url", ""):
                return t["webSocketDebuggerUrl"]
        return None
    except Exception as e:
        traceback.print_exc()
        output_core.send_output("shell", f"❌ Failed to query CDP targets: {e}")
        return None

def open_chatgpt_tab(conversation_id):
    url = f"https://chat.openai.com/c/{conversation_id}"
    return cdp.create_and_navigate(url)

def switch_tab(conversation_id):
    conversation_id = str(conversation_id)
    ws_url = find_chatgpt_tab(conversation_id)
    if ws_url:
        cdp.connect(ws_url)
        output_core.send_output("shell", f"🔁 Connected to tab in CDP to conversation ID: {conversation_id}")
        return ws_url
    else:
        output_core.send_output("shell", f"🔁 No tab found for conversation ID: {conversation_id} — launching...")
        open_chatgpt_tab(conversation_id)
        time.sleep(2)
        ws_url = find_chatgpt_tab(conversation_id)
        if ws_url:
            cdp.connect(ws_url)
            output_core.send_output("shell", f"🔁 Connected to tab in CDP to conversation ID: {conversation_id}")
            return ws_url
        print("❌ Still unable to connect to new tab.")
        output_core.send_output("shell", f"❌ Failed to connect to tab for conversation ID: {conversation_id}")
        return False
