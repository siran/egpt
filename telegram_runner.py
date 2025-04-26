import asyncio
import os
import json
import textwrap
import time
from dataclasses import dataclass, asdict
from typing import Dict, Any, Optional
from telegram.ext import Application, MessageHandler, filters
import router
import load_config
import cdp_instance
import input_core
import output_core

@dataclass
class Conversation:
    chat_id: str
    tab_url: Optional[str] = None
    chat_name: Optional[str] = None
    streaming_input: bool = False

    # Flattened AgentState
    pending_exec: Optional[str] = None
    pending_output: Optional[str] = None
    telegram_chat_id: Optional[str] = None
    last_msg_id: Optional[int] = None # Telegram message ID
    last_seen_msg_id: Optional[int] = None # GPT DOM tracking

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
        value = self.conversations.get(key_str)
        if value is None:
            self.conversations[key_str] = Conversation(chat_id=key_str)
            return self.conversations[key_str]
        if isinstance(value, dict):
            # Lazily upgrade dict to Conversation
            self.conversations[key_str] = Conversation(**value)
        return self.conversations[key_str]


    def __setitem__(self, key: Any, value: Conversation) -> None:
        self.conversations[str(key)] = value

    def save(self, filename: str = "state/conversations.json") -> bool:
        os.makedirs(os.path.dirname(filename), exist_ok=True)
        with open(filename, "w") as file:
            json.dump(asdict(self), file)
        return True

    @classmethod
    def load(cls, filename: str = "state/conversations.json") -> "Conversations":
        try:
            with open(filename, "r") as file:
                data = json.load(file)
            cls = Conversations(**data)
            return cls
        except (json.JSONDecodeError, KeyError) as e:
            print(f"Error loading {filename}: {e}. Using empty conversations.")
            cls.conversations = {}

        return cls

    async def start_reply_loop(self, chat_id: str, app: Application):
        chat_id_str = str(chat_id)
        if chat_id_str in self.active_loops and not self.active_loops[chat_id_str].done():
            await output_core.send_output("shell", f"⚠️ Reply loop already running for chat_id {chat_id}")
            await asyncio.sleep(1)
            return
        task = app.create_task(input_core.stream_reply_loop(chat_id))
        self.active_loops[chat_id_str] = task

conversations = Conversations().load("state/conversations.json")

async def main():
    token = load_config.get_config().get("telegram_bot_token")
    if not token:
        await output_core.send_output("telegram", "❌ No Telegram token found in config.yaml")
        return

    # Create custom JobQueue with enforced pytz.UTC
    # job_queue = JobQueue()
    # job_queue._scheduler = AsyncIOScheduler(timezone=pytz.UTC)  # force pytz scheduler

    try:
        app = app = Application.builder().token(token).build()

        # print(f"Application initialized with scheduler timezone: {scheduler.timezone}")
        await output_core.send_output("shell", f"🤖 Telegram bot initialized with timezone UTC.")
    except Exception as e:
        print(f"Failed to initialize Application: {e}")
        raise

    async def handle(update, context):
        try:
            msg = update.message.text.strip()
            user = update.effective_user
            user_id = f"tg{user.id}"
            username = user.username
            chat_id = update.effective_chat.id
            chat_name = update.effective_chat.title or f"DM({username})"
            user_home = f"/home/{user_id}"
            username_chat = f"@{username}/({chat_name}:{chat_id})"

            await output_core.send_output("shell", textwrap.dedent(f"""\
                                                    🐢 Telegram bridge received message:
                                                    🐢 {chat_name} ({chat_id}) {user_id} {username}
                                                    🐢 {msg}
                                                    """))
            # await output_core.send_output("shell", f"📨 {username_chat}> {msg}")


            if not os.path.isdir(user_home):
                await output_core.send_output("telegram", f"❌ Access denied for {username_chat}")
                await output_core.send_telegram(chat_id, "⚠️ You are not authorized.")
                return

            conversation = conversations[chat_id]
            output_core.send_output("shell", f"🧠 Message from chat_id {chat_id}, conversation tab_url: {conversation.tab_url}")

            result = await cdp_instance.switch_tab(conversation.tab_url)
            # conversation.chat_name = chat_name

            if not result:
                await output_core.send_output("all", "🔧 Setting up session...", chat_id=chat_id)
                await asyncio.sleep(1)
                conversation.tab_url = cdp_instance.switch_tab(conversation.tab_url)
                if not conversation.tab_url:
                    await output_core.send_output("all", "❌ Failed to launch ChatGPT tab.", chat_id=chat_id)
                    return
                # conversations[chat_id] = conversation


            if conversation.streaming_input:
                await output_core.send_output("telegram", "⚠️ Still processing previous message...", chat_id=chat_id)
                return

            # await conversations.start_reply_loop(chat_id, context.application)

            if msg == "p":
                await input_core.stream_reply_loop(conversation=conversation)
                return

            if msg:
                result = await input_core.interpret_input(msg, conversation, is_shell=False)
                if result:
                    await output_core.send_output("telegram", result, chat_id=chat_id)
                else:
                    await router.route_message(msg, source="telegram_user", conversation=conversation)
                # if not conversation.pending_exec:
                    # current_id = output_core.get_output_handler_state("telegram", "last_msg_id", conversation)
                    # if not current_id:
                    # msg_id = await output_core.send_telegram(chat_id, "⏳ Waiting for brain to reply...")
                    # output_core.update_output_handler_state("telegram", "last_msg_id", msg_id)
                    # conversation.last_msg_id = msg_id
                    # conversations[chat_id] = conversation
                    # await input_core.stream_reply_loop(chat_id)
        except Exception as e:
            await output_core.send_output("telegram", f"Error: {e}", chat_id=chat_id)
            raise

    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle))
    await output_core.send_output("shell", "🤖 Telegram bridge waiting...")
    try:
        await app.initialize()
        await app.start()
        await output_core.send_output("shell", "🤖 Telegram bridge started (idle mode)...")
        await app.updater.start_polling(drop_pending_updates=True)

        # Wait forever
        await asyncio.Event().wait()
    finally:
        for task in conversations.active_loops.values():
            task.cancel()
        cdp_instance.cdp.close()
        conversations.save("state/conversations.json")

if __name__ == "__main__":
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            loop.create_task(main())
        else:
            loop.run_until_complete(main())
    except RuntimeError as e:
        print(f"⚠️ Event loop issue: {e}")
