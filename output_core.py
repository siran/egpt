import asyncio
import requests
import traceback
from load_config import get_config
import sendtobrain
from telegram_runner import conversations, Conversation
import datetime

_output_handlers = {}
_output_state = {}

def register_output_handler(name, handler, editable=False, **kwargs):
    _output_handlers[name] = {
        "handler": handler,
        "editable": editable,
        "last_msg_id": None
    }

def update_output_handler_state(name, key, value):
    if name in _output_handlers:
        _output_handlers[name][key] = value

def get_output_handler_state(name, key):
    return _output_handlers.get(name, {}).get(key)

async def send_output(target, text, is_final=False, msg_id=None, conversation: Conversation = None, **kwargs):
    now = datetime.datetime.now().replace(microsecond=0)
    if not text:
        await send_output("shell", "⚠️ No text provided for output")
        return None

    if target == "all":
        delivered = False
        for name, config in _output_handlers.items():
            await _safe_dispatch(name, config, text, is_final, **kwargs)
            delivered = True
        if not delivered:
            print(f"[{now}] X Not delivered: -> {text} <-")
        return None

    elif target == "brain":
        if len(text) > 1:
            if not conversation:
                await send_output("shell", "⚠️ No conversation provided for brain output")
                return None
            tab_url = conversation.tab_url
            if not tab_url:
                await send_output("shell", "⚠️ No tab URL provided in conversation for brain output")
                return None
            import cdp_instance
            await cdp_instance.switch_tab(tab_url)
            response = await sendtobrain.reflect(text)
            return response
        return None

    elif target == "telegram":
        if not conversation:
            await send_output("shell", "⚠️ No conversation provided for Telegram output")
            return None

        chat_id = conversation.chat_id
        if not chat_id:
            await send_output("shell", "⚠️ No chat ID provided for Telegram output")
            return None

        msg_id = conversation.last_telegram_msg_id

        msg_id = await send_telegram(chat_id, text, msg_id=msg_id, is_final=is_final)

        if msg_id:
            return msg_id

    else:
        config = _output_handlers.get(target)
        if config:
            await _safe_dispatch(target, config, text, is_final, **kwargs)
        else:
            print(f"[{now}] {text}")
        return None

async def _safe_dispatch(name, config, text, is_final, **kwargs):
    handler = config["handler"]
    editable = config.get("editable", False)
    msg_id = config.get("last_msg_id")

    try:
        if editable:
            new_id = await handler(text, msg_id=msg_id, is_final=is_final, **kwargs)
            if new_id:
                config["last_msg_id"] = new_id
        else:
            await handler(text, **kwargs)
    except Exception as e:
        traceback.print_exc()
        print(f"⚠️ Failed to send to '{name}': {e}")

async def send_telegram(chat_id, text, msg_id=None, is_final=False):
    token = get_config().get("telegram_bot_token")
    loop = asyncio.get_event_loop()
    try:
        if msg_id:
            url = f"https://api.telegram.org/bot{token}/editMessageText"
            content = text.rstrip()
            response = await loop.run_in_executor(None, lambda: requests.post(
                url, json={
                    "chat_id": chat_id,
                    "message_id": msg_id,
                    "text": content[:4000],
                    "parse_mode": "HTML"
                }
            ))
        else:
            url = f"https://api.telegram.org/bot{token}/sendMessage"
            response = await loop.run_in_executor(None, lambda: requests.post(
                url, json={
                    "chat_id": chat_id,
                    "text": text[:4000],
                    "parse_mode": "HTML"
                }
            ))

        if response.status_code == 200:
            result = response.json()
            return result["result"]["message_id"]
        else:
            await send_output("shell", f"Telegram API error: {response.text}")
            return None

    except Exception as e:
        traceback.print_exc()
        await send_output("shell", f"Failed to send Telegram message: {e}")
        return None

async def edit_telegram(chat_id, msg_id, text):
    token = get_config().get("telegram_bot_token")
    url = f"https://api.telegram.org/bot{token}/editMessageText"
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, lambda: requests.post(
            url, json={"chat_id": chat_id, "message_id": msg_id, "text": text[:4000]}
        ))
    except Exception as e:
        print(f"Failed to edit Telegram message: {e}")
