# router.py — Unified message router with output handler registry
from main import interpret_input, agent_state

_output_handlers = {}

def register_output_handler(source, handler):
    _output_handlers[source] = handler

def route_message(text, source="shell", chat_id=None):
    text = text.strip()

    if source == "telegram":
        agent_state["telegram_chat_id"] = chat_id

    result = interpret_input(text, is_shell=(source == "shell"))

    if result and source in _output_handlers and chat_id:
        try:
            _output_handlers[source](chat_id, result)
        except Exception as e:
            print(f"⚠️ Failed to send {source} reply: {e}")

    agent_state["telegram_chat_id"] = None
    return result
