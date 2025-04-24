import asyncio
import os
import json
from dataclasses import dataclass, asdict
from typing import Dict, Any
from telegram.ext import Application, MessageHandler, filters
import router
import load_config
import cdp_instance
import input_core
import output_core
import sendtobrain
import chromebridge_cdp

@dataclass
class AgentState:
    pending_exec: Any = None
    pending_output: Any = None
    telegram_chat_id: Any = None
    last_msg_id: Any = None

@dataclass
class Conversation:
    chat_id: Any
    tab_url: str
    chat_name: str
    agent_state: AgentState = None
    streaming_input: bool = False

    def __post_init__(self):
        if self.agent_state is None:
            self.agent_state = AgentState(telegram_chat_id=self.chat_id)

@dataclass
class Conversations:
    conversations: Dict[str, Conversation] = None
    active_loops: Dict[str, asyncio.Task] = None

    def __post_init__(self):
        if self.conversations is None:
            self.conversations = {}
        if self.active_loops is None:
            self.active_loops = {}

    def __getitem__(self, key: Any) -> Conversation:
        key_str = str(key)
        if key_str not in self.conversations:
            self.conversations[key_str] = Conversation(
                chat_id=key,
                tab_url=None,
                chat_name=None
            )
        return self.conversations[key_str]

    def __setitem__(self, key: Any, value: Conversation) -> None:
        self.conversations[str(key)] = value

    def save(self, filename: str = "state/conversations.json") -> bool:
        os.makedirs(os.path.dirname(filename), exist_ok=True)
        with open(filename, "w") as file:
            data = {
                "conversations": {
                    k: {
                        "chat_id": v.chat_id,
                        "tab_url": v.tab_url,
                        "chat_name": v.chat_name,
                        "streaming_input": v.streaming_input,
                        "last_msg_id": v.agent_state.last_msg_id
                    }
                    for k, v in self.conversations.items()
                }
            }
            json.dump(data, file)
        return True

    def load(self, filename: str = "state/conversations.json") -> "Conversations":
        os.makedirs(os.path.dirname(filename), exist_ok=True)
        if not os.path.exists(filename):
            return self
        try:
            with open(filename, "r") as file:
                data = json.load(file)
            self.conversations = {
                k: Conversation(
                    chat_id=v["chat_id"],
                    tab_url=v.get("tab_url"),
                    chat_name=v["chat_name"],
                    streaming_input=v.get("streaming_input", False),
                    agent_state=AgentState(
                        telegram_chat_id=v["chat_id"],
                        last_msg_id=v.get("last_msg_id")
                    )
                )
                for k, v in data.get("conversations", {}).items()
            }
        except (json.JSONDecodeError, KeyError) as e:
            print(f"Error loading {filename}: {e}. Using empty conversations.")
            self.conversations = {}
        return self

    async def start_reply_loop(self, chat_id: str, app: Application):
        chat_id_str = str(chat_id)
        if chat_id_str in self.active_loops and not self.active_loops[chat_id_str].done():
            print(f"Reply loop already running for chat_id {chat_id}")
            return
        conversation = self[chat_id]
        task = app.create_task(input_core.stream_reply_loop(chat_id, conversation))
        self.active_loops[chat_id_str] = task

conversations = Conversations().load("state/conversations.json")

async def main():
    token = load_config.get_config().get("telegram_bot_token")
    if not token:
        await output_core.send_output("telegram", "❌ No Telegram token found in config.yaml")
        return

    app = Application.builder().token(token).build()

    async def handle(update, context):
        try:
            msg = update.message.text.strip()
            user = update.effective_user
            user_id = f"tg{user.id}"
            username = user.username
            chat_id = update.effective_chat.id
            chat_name = update.effective_chat.title or "DM"
            user_home = f"/home/{user_id}"
            username_chat = f"@{username}/{chat_name}"

            await output_core.send_output("shell", f"📨 {username_chat}> {msg}")

            conversation = conversations[chat_id]
            conversation.tab_url = cdp_instance.switch_tab(chat_id)
            conversation.chat_name = chat_name
            conversations[chat_id] = conversation

            if not os.path.isdir(user_home):
                await output_core.send_output("telegram", f"❌ Access denied for {username_chat}")
                await output_core.send_telegram(chat_id, "⚠️ You are not authorized.")
                return

            if not conversation.tab_url:
                await output_core.send_output("all", "🔧 Setting up session...", chat_id=chat_id)
                await asyncio.sleep(1)
                conversation.tab_url = cdp_instance.switch_tab(chat_id)
                if not conversation.tab_url:
                    await output_core.send_output("all", "❌ Failed to launch ChatGPT tab.", chat_id=chat_id)
                    return
                conversations[chat_id] = conversation

            await conversations.start_reply_loop(chat_id, context.application)

            if conversation.streaming_input:
                await output_core.send_telegram(chat_id, "⚠️ Still processing previous message...")
                return

            if msg == "p":
                await input_core.stream_reply_loop(chat_id, conversation)
                return

            if msg:
                result = await input_core.interpret_input(msg, conversation, is_shell=False)
                if result:
                    await output_core.send_output("shell", result)
                if len(msg) > 1 and not result:
                    sendtobrain.reflect(msg, "brain")
                    await output_core.send_output("telegram", msg, chat_id=chat_id)
                router.route_message(msg, source="telegram", chat_id=chat_id)

                if not conversation.agent_state.pending_exec:
                    current_id = output_core.get_output_handler_state("telegram", "last_msg_id")
                    if not current_id:
                        msg_id = await output_core.send_telegram(chat_id, "⏳ Waiting for brain to reply...")
                        output_core.update_output_handler_state("telegram", "last_msg_id", msg_id)
                        conversation.agent_state.last_msg_id = msg_id
                        conversations[chat_id] = conversation
                    await input_core.stream_reply_loop(chat_id, conversation)
        except Exception as e:
            await output_core.send_output("telegram", f"Error: {e}", chat_id=chat_id)
            raise

    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle))
    await output_core.send_output("shell", "🤖 Telegram bridge running...")
    try:
        await app.run_polling(drop_pending_updates=True)
    finally:
        for task in conversations.active_loops.values():
            task.cancel()
        cdp_instance.cdp.close()
        conversations.save("state/conversations.json")

if __name__ == "__main__":
    asyncio.run(main())
