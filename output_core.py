import requests
import traceback
import cdp_instance
from load_config import get_config
import sendtobrain


_output_handlers = {}
_output_state = {}
agent_state = {}

def register_output_handler(name, handler, editable=False, **kwargs):
    global agent_state
    import main
    agent_state = main.agent_state

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

def send_output(target, text, is_final=False, **kwargs):
    if target == "all":
        delivered = False
        for name, config in _output_handlers.items():
            _safe_dispatch(name, config, text, is_final)
            delivered = True
        if not delivered:
            print(f"📥 [fallback] {text}")
    elif target == "brain":
        if len(text) > 1:
            tab_url = kwargs.get("tab_url")
            if not tab_url:
                msg = "⚠️ No tab URL provided for brain output"
                print(msg)
                print("⚠️ No tab URL provided for brain output")
                return False


            cdp_instance.switch_tab(tab_url)
            return sendtobrain.reflect(text)

    elif target == "telegram":
        output_handler = _output_handlers.get("telegram")
        if output_handler:
            chat_id = kwargs.get("chat_id")
            if not chat_id:
                send_output("shell", "⚠️ No chat ID provided for Telegram output")
                return False

            msg_id = output_handler(text, chat_id=chat_id, msg_id=msg_id, is_final=is_final)

            msg_id = send_telegram(chat_id, text)

            if msg_id:
                update_output_handler_state("telegram", "last_msg_id", msg_id)
        if chat_id:
            config = _output_handlers.get("cdp")
            cdp_instance.switch_tab(chat_id)
            cdp_instance.type_and_send(text)

    else:
        config = _output_handlers.get(target)
        if config:
            _safe_dispatch(target, config, text, is_final)
        else:
            print(f"📥 [fallback] {text}")

def _safe_dispatch(name, config, text, is_final):
    handler = config["handler"]
    editable = config.get("editable", False)
    msg_id = config.get("last_msg_id")

    try:
        if editable:
            # Call with optional msg_id and is_final
            msg_id = handler(text, msg_id=msg_id, is_final=is_final)
            if msg_id:
                config["last_msg_id"] = msg_id
        else:
            handler(text)
    except Exception as e:
        traceback.print_exc()
        print(f"⚠️ Failed to send to '{name}': {e}")

# --- Telegram output handler ---

# def telegram_stream_handler(text, msg_id=None, is_final=False):
#     chat_id = agent_state.get("telegram_chat_id")
#     if not chat_id:
#         return None

#     if msg_id:
#         content = text.rstrip("\n.") if is_final else text + "\n..."
#         edit_telegram(chat_id, msg_id, content)
#         return msg_id
#     else:
#         thinking = send_telegram(chat_id, "⏳ Thinking...")
#         return thinking
