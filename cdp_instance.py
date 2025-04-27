import asyncio
import os
import json
import traceback
import requests
import time
import websocket
from chromebridge_cdp import ChromeCDP
import output_core

cdp = ChromeCDP()

async def find_chatgpt_tab(conversation_id):
    try:
        targets = await asyncio.get_event_loop().run_in_executor(
            None, lambda: requests.get("http://localhost:9222/json").json()
        )
        await output_core.send_output("shell", "🔍 Available tabs:")
        for t in targets:
            await output_core.send_output("shell", f"- {t.get('title', '')} | url: {t.get('url', '')}")
            if str(conversation_id) in t.get("url", ""):
                return t["webSocketDebuggerUrl"]
        return None
    except Exception as e:
        traceback.print_exc()
        await output_core.send_output("shell", f"❌ Failed to query CDP targets: {e}")
        return None

async def open_chatgpt_tab(conversation_id):
    url = f"https://chat.openai.com/c/{conversation_id}"
    return await cdp.create_and_navigate(url)

async def switch_tab(conversation_id):

    async def connect(ws_url):
        try:
            await cdp.connect(ws_url)
            await output_core.send_output("shell", f"🔁 Connected to tab in CDP to conversation ID: {conversation_id}")
            return True
        except Exception as e:
            traceback.print_exc()
            await output_core.send_output("shell", f"❌ Failed to connect to tab for conversation ID: {conversation_id}, exception: {e}")
        return False

    n=0
    while True:
        n += 1
        if n > 2:
            break
        ws_url = await find_chatgpt_tab(conversation_id)
        if ws_url:
            return  await connect(ws_url)
        else:
            await open_chatgpt_tab(conversation_id)
            await asyncio.sleep(2)
            continue

    print("❌ Still unable to connect to new tab.")
    await output_core.send_output("shell", f"❌ Still unable to connect to new tab for conversation ID: {conversation_id}")
    return False
