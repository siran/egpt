import asyncio
import requests
import traceback
from load_config import get_config
import sendtobrain
from telegram_runner import conversations, Conversation
import output_core

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

async def send_output(target, text, is_final=False, **kwargs):
    if target == "all":
        delivered = False
        for name, config in _output_handlers.items():
            await _safe_dispatch(name, config, text, is_final, **kwargs)
            delivered = True
        if not delivered:
            print(f"📥 [fallback] {text}")
    elif target == "brain":
        if len(text) > 1:
            conversation = kwargs.get("conversation")
            if not conversation:
                msg = "⚠️ No conversation provided for brain output"
                print(msg)
                return False
            tab_url = conversation.tab_url
            if not tab_url:
                msg = "⚠️ No tab URL provided in conversation for brain output"
                await output_core.send_output("shell", msg)
                return False
            import cdp_instance
            await cdp_instance.switch_tab(tab_url)
            response = await sendtobrain.reflect(text)
            return response
    elif target == "telegram":
        #print("sending to telegram")
        await output_core.send_output("shell", f"sending to telegram: {text}")

        conversation = kwargs.get("conversation")
        if not conversation:
            msg = "⚠️ No conversation provided for Telegram output"
            await output_core.send_output("shell", msg)
            return False

        chat_id = conversation.chat_id
        if not chat_id:
            await output_core.send_output("shell", "⚠️ No chat ID provided for Telegram output")
            return False

        last_msg_id = chat_id
        last_msg_id = None # debugging
        # if not last_msg_id:
        #     await output_core.send_output("shell", "⚠️ No last message ID provided for Telegram output")
        #     return False
        await output_core.send_output("shell", f"Last message ID: {last_msg_id}")
        msg_id = await send_telegram(chat_id, text, msg_id=last_msg_id, is_final=is_final)
        # if msg_id:
        #     update_output_handler_state("telegram", "last_msg_id", msg_id)
        #     if chat_id in conversations.conversations:
        #         conversations[chat_id].last_msg_id = msg_id
        # config = _output_handlers.get("cdp")
        # if config:
        #     import cdp_instance
        #     from cdp_instance import cdp
        #     await cdp_instance.switch_tab(chat_id)
        #     cdp.type_and_send(text)
    else:
        config = _output_handlers.get(target)
        if config:
            await _safe_dispatch(target, config, text, is_final, **kwargs)
        else:
            print(f"📥 [fallback] {text}")

async def _safe_dispatch(name, config, text, is_final, **kwargs):
    handler = config["handler"]
    editable = config.get("editable", False)
    msg_id = config.get("last_msg_id")

    try:
        if editable:
            msg_id = await handler(text, msg_id=msg_id, is_final=is_final, **kwargs)
            if msg_id:
                config["last_msg_id"] = msg_id
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
            content = text.rstrip("\n.") if is_final else text + "\n..."
            response = await loop.run_in_executor(None, lambda: requests.post(
                url, json={"chat_id": chat_id, "message_id": msg_id, "text": content[:4000]}
            ))
        else:
            url = f"https://api.telegram.org/bot{token}/sendMessage"
            response = await loop.run_in_executor(None, lambda: requests.post(
                url, json={"chat_id": chat_id, "text": text[:4000]}
            ))
        if response.status_code == 200:
            return response.json()["result"]["message_id"]
        print(f"Telegram API error: {response.text}")
        return None
    except Exception as e:
        print(f"Failed to send Telegram message: {e}")
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
