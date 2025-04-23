from main import agent_state
import threading
import time
import yaml
import os
import requests
from telegram.ext import Updater, MessageHandler, Filters
import router
import load_config
import cdp_instance
import input_core
import output_core
import sendtobrain
import chromebridge_cdp
from dataclasses import dataclass, asdict
from typing import Any, List, Dict
import json

@dataclass
class Conversation:
    chat_id: Any
    chat_name: str
    tab_url_id: str = None
    last_msg_id: str = None
    pending_exec: bool = False
    streaming_input: bool = False

@dataclass
class Conversations:
    conversations: Dict[str, Conversation] = None

    def __post_init__(self):
        if self.conversations is None:
            self.conversations = {}

    def __getitem__(self, key: Any) -> Conversation:
        if str(key) not in self.conversations:
            self.conversations[str(key)] = Conversation(
                chat_id=key,
                tab_url=None,
                chat_name=None
            )

        return self.conversations[str(key)]


    def __setitem__(self, key: str, value: Conversation) -> None:
        self.conversations[str(key)] = value

    def save(self, filename: str = "state/conversations.json") -> bool:
        with open(filename, "w") as file:
            json.dump(asdict(self), file)

        return True

    def load(self, filename: str = "state/conversations.json") -> "Conversations":
        if not os.path.exists(filename):
            return self

        with open(filename, "r") as file:
            data = json.load(file)

        return Conversations(**data)

        # return cls(
        #     conversations={
        #         k: Conversation(**v) for k, v in data["conversations"].items()
        #     }
        # )

conversations = Conversations().load("state/conversations.json")

def send_telegram(chat_id, message, **kwargs):
    msg_id = kwargs.get("conversation")
    # if conversation:
    #     conversations[chat_id] = conversation
    token = load_config.get_config().get("telegram_bot_token")
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    r = requests.post(url, json={"chat_id": chat_id, "text": message[:4000]})
    if r.status_code == 200:
        return r.json()["result"]["message_id"]
    return None

def edit_telegram(chat_id, message_id, new_text):
    token = load_config.get_config().get("telegram_bot_token")
    url = f"https://api.telegram.org/bot{token}/editMessageText"
    requests.post(url, json={
        "chat_id": chat_id,
        "message_id": message_id,
        "text": new_text[:4000]
    })

def main():
    token = load_config.get_config().get("telegram_bot_token")
    if not token:
        output_core.send_output("telegram", "❌ No Telegram token found in config.yaml")
        return

    telegram_updater = Updater(token, use_context=True)
    dp = telegram_updater.dispatcher

    try:
        def handle(update, context):
            msg = update.message.text.strip()
            user = update.effective_user
            user_id = f"tg{user.id}"
            username = user.username
            chat_id = update.effective_chat.id
            chat_name = update.effective_chat.title or "DM"
            user_home = f"/home/{user_id}"
            # username_chat = f"@{username}({user_id}-{chat_name})"
            username_chat = f"@{username}/{chat_name})"


            output_core.send_output("shell", f"📨 {username_chat}> {msg}")

            conversation = conversations[chat_id]

            output_core.register_output_handler("telegram", send_telegram, editable=True, conversation=conversation)

            if not os.path.isdir(user_home):
                output_core.send_output("telegram", f"❌ Access denied for {username_chat}")
                output_core.send_telegram(chat_id, "⚠️ You are not authorized.")
                return

            conversation_id = conversation["tab_url_id"]
            ws_url = cdp_instance.switch_tab(conversation_id=conversation_id)

            # os.chdir(user_home)

            threading.Thread(target=input_core.stream_reply_loop, args=((chat_id),)).start()

            if conversation and conversation["streaming_input:"]:
                output_core.send_telegram(chat_id, "⚠️ Still processing previous message...")
                return

            if msg == "p":
                input_core.stream_reply_loop(chat_id=chat_id)
                return

            if msg:

                result = input_core.interpret_input(msg, is_shell=False)

                if not result:
                    # result = sendtobrain.reflect(msg, "brain", )
                    result = output_core.send_output("brain", msg, chat_id=chat_id)

                # agent_state["telegram_chat_id"] = chat_id
                # router.route_message(msg, source="telegram", chat_id=chat_id)

                if not agent_state.get("pending_exec"):
                    from output_core import get_output_handler_state
                    current_id = get_output_handler_state("telegram", "last_msg_id")
                    if not current_id:
                        msg_id = output_core.send_telegram(chat_id, "⏳ Waiting for brain to reply...")

                        output_core.update_output_handler_state("telegram", "last_msg_id", msg_id)
                    input_core.stream_reply_loop()
    except Exception as e:
        output_core.send_output("telegram", f"Error: {e}", chat_id=chat_id)
        raise

    dp.add_handler(MessageHandler(Filters.text & ~Filters.command, handle))
    output_core.send_output("shell", "🤖 Telegram bridge running...")
    telegram_updater.start_polling(drop_pending_updates=True,)
    telegram_updater.idle()

output_core.register_output_handler("telegram", send_telegram, kwargs={}, editable=True)
output_core.register_output_handler("cdp",   chromebridge_cdp.ChromeCDP.type_and_send, editable=False)




if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        output_core.send_output("shell", f"❌ Telegram error: {e}")
    finally:
        conversations.save("state/conversations.json")
