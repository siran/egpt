import os
import subprocess
import re
import sys
import time
import yaml
from memory import Memory
from executor import execute_command, log, say
from patcher import propose_patch, apply_patch_if_approved, update_patch, show_patch
from chromebridge_cdp import ChromeCDP

with open("config.yaml", "r") as f:
    config = yaml.safe_load(f)

MODEL = config.get("model", "gpt-4")
try:
    from openai import OpenAI
    client = OpenAI(api_key=config["openai_api_key"])
except:
    client = None

memory = Memory("state/memory.json")
memory.load_reminiscence()

boot_msg = "(booted)\n🧠 e started at " + os.uname().nodename + ", cwd: " + os.getcwd()
memory.append({"role": "system", "content": boot_msg})
memory.save()
say(boot_msg)

conversation_log = []
cdp = ChromeCDP()
cdp.connect()

agent_state = {
    "pending_exec": None,
    "pending_output": None,
    "interactive_local": False
}

def detect_exec_block(text):
    body = text.split("---")[-1]
    blocks = re.split(r"\n\n", body)
    for block in blocks:
        line = block.strip()
        if line.startswith("@"):
            keyval = line[1:].split(":", 1)
            if len(keyval) == 2 and keyval[0].strip().lower() == "exec":
                cmd = keyval[1].strip()
                agent_state["pending_exec"] = cmd
                return "⚙️ Proposed Command: " + cmd + "\n💡 Reply 'y' to approve execution, or 'n' to cancel."
    return None

def interpret_input(prompt):
    prompt = prompt.strip()
    if prompt.lower() in {"y", "n"}:
        if agent_state["pending_exec"]:
            if prompt.lower() == "y":
                cmd = agent_state["pending_exec"]
                try:
                    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
                    output = result.stdout.strip() + "\n" + result.stderr.strip()
                    status = result.returncode
                except Exception as e:
                    output = str(e)
                    status = -1
                agent_state["pending_output"] = (cmd, output, status)
                agent_state["pending_exec"] = None
                return "✅ Executed locally:\n@exec: " + cmd + "\n\n📤 Result:\n" + output.strip() + "\n\n🔚 Exit Status: " + str(status) + "\n\n💡 Send this to ChatGPT context? (y/n)"
            else:
                agent_state["pending_exec"] = None
                return "❌ Command aborted."
        return "✅ y/n received, but no command was pending."

    maybe = detect_exec_block(prompt)
    if maybe:
        return maybe
    return None

def chat_with_gpt(prompt=None):
    js = '''
    (() => {
        return Array.from(document.querySelectorAll(".text-message"))
            .map(el => el.innerText)
            .filter(t => t && t.trim().length > 0)
            .join("\n---\n");
    })();
    '''
    print("🔄 Waiting for reply", end="", flush=True)
    last_seen = ""
    stable_count = 0
    while True:
        try:
            result = cdp.evaluate(js)
            current = result["result"]["result"]["value"].strip()
            if current in {"", "\n", "\u200b", "​"}:
                print(".", end="", flush=True)
                time.sleep(1)
                continue
            if current != last_seen:
                last_seen = current
                stable_count = 0
                with open("stream_reply.txt", "w", encoding="utf-8") as f:
                    f.write(current)
            else:
                stable_count += 1
            print(".", end="", flush=True)
            time.sleep(1)
            if stable_count >= 2:
                print("\n🧠 brain says:\n" + current)
                return current
        except Exception as e:
            input("\n⚠️ CDP error: " + str(e) + " — Press Enter to retry.")

def log_input(prompt):
    log("🧍 You: " + prompt)

def main():
    os.makedirs("logs", exist_ok=True)
    os.makedirs("state", exist_ok=True)
    say("🧠 e is online. Watching ChatGPT.\n")
    while True:
        try:
            response = chat_with_gpt()
            say("\n🤖 e:\n" + response)
            parsed = interpret_input(response)
            if parsed:
                say("\n📡 Interpreted:\n" + parsed)
                if parsed.startswith("⚙️ Proposed Command:"):
                    answer = input("\nApprove? [y/n] ").strip().lower()
                    second = interpret_input(answer)
                    if second:
                        say("\n📡 Result:\n" + second)
        except KeyboardInterrupt:
            print("\n👋 Exiting.")
            break

if __name__ == "__main__":
    main()
