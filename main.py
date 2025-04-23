import os
import input_core
import output_core
from memory import Memory
from output_core import send_output
from dataclasses import dataclass
import load_config

agent_state = load_config.agent_state()

fetch_n_messages = 1
memory = Memory("state/memory.json")
memory.load_reminiscence()

boot_msg = f"(booted)\n🧠 e started at {os.uname().nodename}, cwd: {os.getcwd()}"
memory.append({"role": "system", "content": boot_msg})
memory.save()
send_output("shell", boot_msg)

# agent_state = {
#     "pending_exec": None,
#     "pending_output": None,
#     "telegram_chat_id": None,
#     "conversations": {}
# }

seen_messages = {}

def input_loop():
    output_core.send_output("shell", "🧠 e is in shell mode.")
    while True:
        try:
            prompt = input("\n====================\n🧍 You (↩,s,l,p,?)> ").strip()
            if prompt == "?":
                send_output("shell", "↩: fetch+parse | s: skip | l: last only | a: all | p: poll | @paste = multiline")
                continue
            if prompt == "p":
                input_core.stream_reply_loop()
                continue
            if prompt.isdigit():
                input_core.stream_reply_loop(fetch_n_messages=prompt)
                continue
            parsed = input_core.interpret_input(prompt, is_shell=True)
            if parsed:
                send_output("shell", f"\n📡 Interpreted:\n{parsed}")
                continue
        except KeyboardInterrupt:
            send_output("shell", "\n👋 Ctrl+C exit request.")
            raise

if __name__ == "__main__":
    input_loop()
