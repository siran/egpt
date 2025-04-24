import os
import asyncio
import input_core
import output_core
from memory import Memory
from telegram_runner import Conversation, AgentState

fetch_n_messages = 1
memory = Memory("state/memory.json")
memory.load_reminiscence()

boot_msg = f"(booted)\n🧠 e started at {os.uname().nodename}, cwd: {os.getcwd()}"
memory.append({"role": "system", "content": boot_msg})
memory.save()

def sync_send_output(target, text, **kwargs):
    asyncio.run(output_core.send_output(target, text, **kwargs))

sync_send_output("shell", boot_msg)

seen_messages = {}

def input_loop():
    sync_send_output("shell", "🧠 e is in shell mode.")
    conversation = Conversation(chat_id="shell", tab_url=None, chat_name="shell")
    while True:
        try:
            prompt = input("\n====================\n🧍 You (↩,s,l,p,?)> ").strip()
            if prompt == "?":
                sync_send_output("shell", "↩: fetch+parse | s: skip | l: last only | a: all | p: poll | @paste = multiline")
                continue
            if prompt == "p":
                asyncio.run(input_core.stream_reply_loop("shell", conversation))
                continue
            if prompt.isdigit():
                asyncio.run(input_core.stream_reply_loop("shell", conversation))
                continue
            parsed = asyncio.run(input_core.interpret_input(prompt, conversation, is_shell=True))
            if parsed:
                sync_send_output("shell", f"\n📡 Interpreted:\n{parsed}")
                continue
        except KeyboardInterrupt:
            sync_send_output("shell", "\n👋 Ctrl+C exit request.")
            raise

if __name__ == "__main__":
    input_loop()
