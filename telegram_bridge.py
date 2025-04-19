import threading
import yaml
from telegram.ext import Updater, MessageHandler, Filters

# Will be set externally by main.py
_interpret = None

def register_handler(fn):
    global _interpret
    _interpret = fn

def load_config():
    with open("config.yaml", "r") as f:
        return yaml.safe_load(f)

def handle_message(update, context):
    user_input = update.message.text.strip()
    print(f"📨 Telegram from {update.effective_user.username}: {user_input}")
    try:
        if _interpret:
            result = _interpret(user_input, is_shell=False)
            if result:
                update.message.reply_text(result)
        else:
            update.message.reply_text("⚠️ Interpreter not set.")
    except Exception as e:
        update.message.reply_text(f"❌ Error: {e}")

def start_telegram_bridge():
    config = load_config()
    token = config.get("telegram_bot_token")
    if not token:
        print("⚠️ Telegram token not found in config.yaml")
        return

    updater = Updater(token, use_context=True)
    dp = updater.dispatcher
    dp.add_handler(MessageHandler(Filters.text & ~Filters.command, handle_message))
    print("🤖 Telegram bridge is running...")
    updater.start_polling()
    return updater

def launch_telegram_thread():
    thread = threading.Thread(target=start_telegram_bridge, daemon=True)
    thread.start()
