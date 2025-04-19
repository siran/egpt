import time
import yaml
import os
import requests
import threading
from telegram.ext import Updater, MessageHandler, Filters
from router import route_message, register_output_handler
from load_config import get_config
from cdp_instance import switch_tab, cdp
from main import agent_state, interpret_input

active_polls = {}

def send_telegram(chat_id, message):
    token = get_config().get("telegram_bot_token")
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    r = requests.post(url, json={"chat_id": chat_id, "text": message[:4000]})
    if r.status_code == 200:
        return r.json()["result"]["message_id"]
    return None

def edit_telegram(chat_id, message_id, new_text):
    token = get_config().get("telegram_bot_token")
    url = f"https://api.telegram.org/bot{token}/editMessageText"
    requests.post(url, json={
        "chat_id": chat_id,
        "message_id": message_id,
        "text": new_text[:4000]
    })

def get_conversation_id(user_id):
    path = f"/home/{user_id}/conversationids.txt"
    if not os.path.exists(path):
        print(f"⚠️ conversationids.txt not found for {user_id}")
        return None

    try:
        with open(path) as f:
            lines = [line.strip() for line in f if ":" in line]
            if not lines:
                print(f"⚠️ No valid lines found in conversationids.txt for {user_id}")
                return None
            last_line = lines[0] # first line is the most recent
            _, conv_id = last_line.split(":", 1)
            return conv_id.strip()
    except Exception as e:
        print(f"❌ Failed to read conversation ID for {user_id}: {e}")
        return None

def start_polling_loop(chat_id, message_id=None, duration=30, stable_time=5, force_send=False, interval=2):
    if chat_id in active_polls:
        return

    def poll(**kwargs):
        print(f"🌀 Streaming reply for chat {chat_id}...")

        seen = {}
        last_msg_text = ""

        js_aria = '''
        (() => {
            const labels = ['voice', 'send', 'stop'];
            for (const value of labels) {
                const btn = document.querySelector(`form button[aria-label~="${value}" i]`);
                if (btn) {
                    return btn.getAttribute("aria-label");
                }
            }
            return "unknown-aria-label";
        })();
        '''

        js_reply = '''
        (() => {
            return Array.from(document.querySelectorAll("[data-message-id]")).map(el => {
                const id = el.getAttribute("data-message-id") || "";
                const role = el.closest('[data-message-author-role]')?.getAttribute('data-message-author-role') || "assistant";
                const text = el.innerText || "";
                return { id, role, text };
            });
        })();
        '''

        try:
            while True:
                time.sleep(interval)

                # Get latest reply from assistant
                try:
                    result = cdp.evaluate(js_reply)
                    messages = result.get("result", {}).get("result", {}).get("value", [])
                    assistant_msgs = [m for m in messages if m.get("role") == "assistant"]
                    if assistant_msgs:
                        last = assistant_msgs[-1]
                        txt = last.get("text", "").strip()
                        msg_id = last.get("id")
                        if seen.get(msg_id) != txt:
                            seen[msg_id] = txt
                            last_msg_text = txt
                            print(f"📡 New assistant message: {txt[:60]}...")

                            if "@exec:" in txt.lower():
                                print("🛠️ Executing @exec from brain via interpret_input()")
                                from main import interpret_input
                                parsed = interpret_input(txt, is_shell=False)
                                if parsed:
                                    send_telegram(chat_id, parsed)
                            elif message_id:
                                edit_telegram(chat_id, message_id, txt)
                except Exception as e:
                    print(f"⚠️ Failed to fetch reply: {e}")

                # Stop polling if aria-label indicates response is complete
                try:
                    result = cdp.evaluate(js_aria)
                    label = result.get("result", {}).get("result", {}).get("value", "")
                    print(f"🔍 aria-label: {label}")
                    if "voice" in label.lower() or "unknown" in label.lower():
                        print("🛑 Polling complete.")
                        break
                except Exception as e:
                    print(f"⚠️ aria-label error: {e}")

        except Exception as e:
            print(f"❌ Polling loop error: {e}")

        finally:
            active_polls.pop(chat_id, None)
            print(f"✅ Finalized polling for chat {chat_id}")

    threading.Thread(target=poll, daemon=True).start()


def main():
    token = get_config().get("telegram_bot_token")
    if not token:
        print("❌ No Telegram token found in config.yaml")
        return

    updater = Updater(token, use_context=True)
    dp = updater.dispatcher

    def handle(update, context):
        msg = update.message.text.strip()
        user = update.effective_user
        user_id = f"tg{user.id}"
        username = user.username
        username_chat = f"@{username}({user_id})"
        chat_id = update.effective_chat.id
        user_home = f"/home/{user_id}"

        print(f"📨 {username_chat}> {msg}")

        if not os.path.isdir(user_home):
            print(f"❌ Access denied for {username_chat}")
            send_telegram(chat_id, "⚠️ You are not authorized.")
            return

        os.chdir(user_home)
        conv_id = get_conversation_id(user_id)
        if conv_id:
            print(f"🔗 Conversation ID found for {user_id}")
            switch_tab(conv_id)

        if chat_id in active_polls:
            send_telegram(chat_id, "⚠️ Still processing previous message...")
            return

        if msg == "p":
            start_polling_loop(chat_id, duration=10, stable_time=1, force_send=True)
            return

        if msg:
            route_message(msg, source="telegram", chat_id=chat_id)

        if not agent_state.get("pending_exec"):
            msg_id = send_telegram(chat_id, "⏳ Waiting for brain to reply...")
            if msg_id:
                start_polling_loop(chat_id, message_id=msg_id, duration=30, stable_time=3, interval=2)


    dp.add_handler(MessageHandler(Filters.text & ~Filters.command, handle))
    print("🤖 Telegram bridge running...")
    updater.start_polling()
    updater.idle()

register_output_handler("telegram", send_telegram)

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"❌ Telegram error: {e}")
