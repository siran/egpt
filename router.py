import input_core
from main import agent_state
import output_core
import sendtobrain

_output_handlers = {}

def register_output_handler(source, handler):
    _output_handlers[source] = handler

def route_message(text, source="shell", chat_id=None):
    text = text.strip()

    # text can be a local command, or reply we try to interpret it
    result = input_core.interpret_input(text, is_shell=(source == "shell"))

    if len(text) > 1 and not result:
        agent_state["pending_output"] = ("text", text, 0)
        sendtobrain.reflect(text)

        return None

    if result:
        output_core.send_output(source, result)

    agent_state["telegram_chat_id"] = None
    return result
