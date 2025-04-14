import os
import subprocess
import re
import sys
import time
import yaml
from memory import Memory
from executor import execute_command, log, say
from patcher import propose_patch, apply_patch_if_approved, update_patch, show_patch
from cdp_instance import cdp

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

agent_state = {
    "pending_exec": None,
    "pending_output": None,
    "interactive_local": False
}

seen_messages = {}

def detect_exec_block(text):
    body = text.split("---")[-1] if "---" in text else text
    for line in body.strip().splitlines():
        line = line.strip()
        if line.startswith("@exec:"):
            agent_state["pending_exec"] = line[6:].strip()
            return "⚙️ Proposed Command: " + agent_state["pending_exec"] + "\n💡 Reply 'y' to approve execution, or 'n' to cancel."
    return None

def interpret_input(prompt, is_shell=True):
    prompt = prompt.strip()

    if prompt.lower() in {"y", "n"}:
        if agent_state["pending_exec"]:
            if prompt == "y":
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
                return f"✅ Executed locally:\n@exec: {cmd}\n\n📤 Output:\n{output.strip()}\n\n🔚 Exit Status: {status}\n\n💡 Send this to ChatGPT context? (y/n)"
            else:
                agent_state["pending_exec"] = None
                return "❌ Command aborted."
        elif agent_state["pending_output"]:
            if prompt in ["", "y"]:
                cmd, output, status = agent_state["pending_output"]
                print("🧠 Sending to ChatGPT via CDP:")
                try:
                    if cmd == "text":
                        msg = output.strip()
                    else:
                        msg = f"📤 Output:\n{output}\n\n🔚 Exit Status: {status}"

                    subprocess.run(["python3",
                                    "sendtobrain.py", msg],
                                    check=True,
                                    stdout=sys.stdout,
                                    stderr=sys.stderr)

                except Exception as e:
                    print(f"❌ Failed to send to brain: {e}")
                agent_state["pending_output"] = None
                print("🧠 Output sent to ChatGPT.")
                stream_reply()
                return None
            else:
                agent_state["pending_output"] = None
                return "❌ Skipped sending to ChatGPT."
        return "✅ y/n received, but no command or output was pending."

    if ":" in prompt and ";" in prompt:
        start = prompt.find(":")
        end = prompt.find(";", start)
        if start != -1 and end != -1:
            reflect_msg = prompt[start+1:end].strip()
            if len(reflect_msg) > 1:
                subprocess.run(
                    ["python3", "sendtobrain.py"],
                    input=reflect_msg,
                    text=True,
                    stdout=sys.stdout,
                    stderr=sys.stderr
                )
                return f"🪞 Reflected to brain: {reflect_msg}"
            else:
                return f"🛑 Ignored single-char reflection: {reflect_msg}"

    maybe = detect_exec_block(prompt)
    if maybe:
        return maybe

    # Only reflect plain text from shell, never from polled UI
    if is_shell and len(prompt) > 1 and not prompt.startswith("@"):
        agent_state["pending_output"] = ("text", prompt, 0)
        return f"📝 Detected plain message.\n💡 Send this to ChatGPT context? (y/n)"

    return None

def fetch_latest_messages(n=4):
    js = '''
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
        result = cdp.evaluate(js)
        messages = result.get("result", {}).get("result", {}).get("value", [])
        return messages[-n:]
    except Exception as e:
        print(f"\n⚠️ Failed to fetch messages: {e}")
        return []

def input_loop():
    while True:
        try:
            prompt = input("\n🧍 You > ").strip()
            mode = "s" if prompt == "" else prompt

            if mode in {"s", "a", "l"}:
                messages = fetch_latest_messages()
                if not messages:
                    print("⚠️ No messages found.")
                    continue

                for i, msg in enumerate(messages):
                    msg_id = msg.get("id")
                    txt = msg.get("text", "").strip()
                    role = msg.get("role", "")
                    if not msg_id or not txt:
                        continue
                    if seen_messages.get(msg_id) == txt:
                        continue

                    seen_messages[msg_id] = txt
                    prefix = "🧍 You:" if role == "user" else "🤖 e:"
                    print(f"\n{prefix}\n{txt}")

                    if mode == "s":
                        continue
                    if mode == "l" and i != len(messages) - 1:
                        continue

                    parsed = interpret_input(txt, is_shell=False)
                    if parsed:
                        print("\n📡 Interpreted:\n" + parsed)
                        if parsed.startswith("⚙️ Proposed Command") or parsed.startswith("✅ Executed locally:"):
                            answer = input("\n🧠 Approve? y/n > ").strip().lower()
                            result = interpret_input(answer, is_shell=False)
                            if result:
                                print("\n📡 Result:\n" + result)
                continue

            parsed = interpret_input(prompt, is_shell=True)
            if parsed:
                print("\n📡 Interpreted:\n" + parsed)
                if parsed.startswith("⚙️ Proposed Command") or parsed.startswith("✅ Executed locally:") or parsed.startswith("📝 Detected plain message"):
                    answer = input("\n🧠 Approve? y/n > ").strip().lower()
                    result = interpret_input(answer, is_shell=True)
                    if result:
                        print("\n📡 Result:\n" + result)

        except KeyboardInterrupt:
            print("\n👋 Exiting.")
            break

def stream_reply():
    js = '''
    (() => {
        return Array.from(document.querySelectorAll("[data-message-id]")).map(el => {
            const id = el.getAttribute("data-message-id") || "";
            const role = el.closest('[data-message-author-role]')?.getAttribute('data-message-author-role') || "assistant";
            const text = el.innerText || "";
            return { id, role, text };
        });
    })();
    '''
    seen = {}

    for _ in range(3):  # 15 seconds total
        try:
            result = cdp.evaluate(js)
            messages = result.get("result", {}).get("result", {}).get("value", [])
            for m in messages:
                msg_id = m.get("id")
                txt = m.get("text", "").strip()
                if not msg_id or not txt:
                    continue
                if seen.get(msg_id) == txt:
                    continue
                seen[msg_id] = txt
                prefix = "🧍 You:" if m.get("role") == "user" else "🤖 e:"
                print(f"\n{prefix}\n{txt}")
        except Exception as e:
            print(f"\n⚠️ stream error: {e}")
        time.sleep(5)

    while True:
        prompt = input("\n↻ Hit Enter to poll again, or type a message to send: ").strip()
        if prompt == "":
            try:
                result = cdp.evaluate(js)
                messages = result.get("result", {}).get("result", {}).get("value", [])
                for m in messages:
                    msg_id = m.get("id")
                    txt = m.get("text", "").strip()
                    if not msg_id or not txt:
                        continue
                    if seen.get(msg_id) == txt:
                        continue
                    seen[msg_id] = txt
                    prefix = "🧍 You:" if m.get("role") == "user" else "🤖 e:"
                    print(f"\n{prefix}\n{txt}")
            except Exception as e:
                print(f"\n⚠️ stream error: {e}")
            time.sleep(5)
        else:
            parsed = interpret_input(prompt, is_shell=True)
            if parsed:
                print("\n📡 Interpreted:\n" + parsed)
                if parsed.startswith("⚙️ Proposed Command") or parsed.startswith("✅ Executed locally:") or parsed.startswith("📝 Detected plain message"):
                    answer = input("\n🧠 Approve? y/n > ").strip().lower()
                    result = interpret_input(answer)
                    if result:
                        print("\n📡 Result:\n" + result)
            break



if __name__ == "__main__":
    while True:
        print("🧠 e is in shell mode — polling disabled.")
        print("Press:\n  ↩ Enter = fetch and parse 4\n  s = fetch 4 and skip\n  l = parse only the last\n")
        input_loop()
        print("\n\nrespawning...\n\n")
