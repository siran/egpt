# main.py — Reflex loop with proper exec approval and post-reflection polling

import os
import subprocess
import sys
import time
import re
import yaml
from memory import Memory
from executor import execute_command, log, say
from patcher import propose_patch, apply_patch_if_approved, update_patch, show_patch
from cdp_instance import cdp
import sendtobrain
from load_config import get_config

fetch_n_messages = 1
memory = Memory("state/memory.json")
memory.load_reminiscence()

boot_msg = "(booted)\n🧠 e started at " + os.uname().nodename + ", cwd: " + os.getcwd()
memory.append({"role": "system", "content": boot_msg})
memory.save()
say(boot_msg)

agent_state = {
    "pending_exec": None,
    "pending_output": None,
    "telegram_chat_id": None,
}

seen_messages = {}

def detect_structured_command(text):
    body = text.split("---")[-1]
    match = re.search(r"(^|\n\n)@(\w+):\s*(.*?)\s*\n\n", body, re.DOTALL)
    if match:
        cmd, payload = match[2].strip().lower(), match[3].strip()
        return cmd, payload
    return None, None

def fetch_latest_messages(n=fetch_n_messages, msg_id=None):
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

        if msg_id:
            return [m for m in messages if m.get("id") == msg_id].get(0, None)

        return messages[-n:]
    except Exception as e:
        print(f"\n⚠️ Failed to fetch messages: {e}")
        return []

def maybe_send_telegram(msg):
    chat_id = agent_state.get("telegram_chat_id")
    try:
        from telegram_runner import send_telegram
        if chat_id:
            # if len(msg) == 1:
            #     msg = msg + " - Single character messages are ignored until pending answer."D
            msg_id = send_telegram(chat_id, msg[:4000])
            if msg_id:
                print(f"📬 Sent to Telegram chat {chat_id}: {msg[:100]}...")
                return msg_id
            else:
                print("⚠️ Telegram message failed to send.")
                return False
        else:
            print("⚠️ There is no registered chatid, Could not send to Telegram. Message ignored.")
            return False
    except:
        import traceback
        traceback.print_exc()
        print("⚠️ Telegram integration failed. Not sending to telegram. Message ignored.")

def interpret_input(prompt, is_shell=True):
    import tempfile
    from pathlib import Path

    prompt = prompt.strip()

    if prompt == "@paste":
        print("📂 Paste mode enabled — press Ctrl+D when done.\n")
        print("-------- begin paste --------")
        try:
            pasted = sys.stdin.read().strip()
            agent_state["pending_output"] = ("text", pasted, 0)
            print("-------- end paste --------\n")
            sendtobrain.reflect(pasted)
            stream_reply_loop()
            return "✅ Pasted and sent."
        except KeyboardInterrupt:
            return "❌ Paste cancelled."

    split = prompt.rsplit('---', 1)
    body = split[-1] if len(split) > 1 else prompt

    body = body.replace("<<EOF", "<<'EOF'", )
    match = re.search(r"@exec:\s*(cat\s+<<'EOF'\s+>.*?\nEOF)", body, re.DOTALL)
    if match:
        script_block = match.group(1).strip()
        agent_state["pending_exec"] = script_block
        return f"⚙️ Detected patch block:\n\n{script_block}\n\n💡 Reply 'y' to approve execution, or 'n' to cancel."

    match2 = re.search(r"(?:^|\n)@exec:\s*(.+)", body)
    if match2:
        command = match2.group(1).strip()
        agent_state["pending_exec"] = command
        return f"⚙️ Proposed Command:\n\n{command}\n\n💡 Reply 'y' to approve execution, or 'n' to cancel."

    if prompt.lower() in {"y", "n"} and agent_state["pending_exec"]:
        if prompt.lower() == "y":
            cmd = agent_state["pending_exec"]
            try:
                if "\n" in cmd:
                    patch_file = Path(tempfile.gettempdir()) / "patch_apply.sh"
                    patch_file.write_text(cmd + "\n", encoding="utf-8")
                    result = subprocess.run(["bash", str(patch_file)], capture_output=True, text=True)
                else:
                    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
                output = result.stdout.strip() + "\n" + result.stderr.strip()
                status = result.returncode
            except Exception as e:
                output = str(e)
                status = -1
            print(f"\n📄 Output:\n====\n{output}\n====\n🔚 Exit Status: {status}")
            agent_state["pending_exec"] = None
            msg = f"📄 Output:\n{output.strip()}\n\n🔚 Exit Status: {status}"
            maybe_send_telegram(msg)
            sendtobrain.reflect(msg)
            stream_reply_loop()
            return None
        elif prompt.lower() == "n":
            agent_state["pending_exec"] = None
            print("❌ Command cancelled.")
            # stream_reply_loop()
            return "✅ Command cancelled — waiting for next input."
        else:
            msg = "⚠️ Invalid response. Reply 'y' to approve or 'n' to cancel, or send a new prompt."
            print(msg)
            maybe_send_telegram(msg)
            return None

    if len(prompt) == 1:
        message = "⚠️ Single-character responses are ignored unless approving a command."
        print(message)
        maybe_send_telegram(message)
        return "✅ Ignored single character."

    if len(prompt) > 0:
        agent_state["pending_output"] = ("text", prompt, 0)
        sendtobrain.reflect(prompt)
        stream_reply_loop()
        return None

    return None

def stream_reply_loop():
    print("\n🔁 Polling for brain reply. Ctrl+C to stop.\n")
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
    last_update_time = time.time()
    timeout = 10
    poll_interval = 2

    try:
        while True:
            result = cdp.evaluate(js)
            messages = result.get("result", {}).get("result", {}).get("value", [])
            new_content = False
            for m in messages[-1:]:
                msg_id = m.get("id")
                txt = m.get("text", "").strip()
                if not msg_id or not txt:
                    continue
                if seen.get(msg_id) != txt:
                    seen[msg_id] = txt
                    prefix = "🧍 You:" if m.get("role") == "user" else "🤖 e:"
                    print(f"\n-- update ---\n{prefix}\n{txt}\n")
                    last_update_time = time.time()
                    new_content = True
            if not new_content and time.time() - last_update_time > timeout:
                print(f"🛑 No new messages for {timeout} seconds. Stopping.")
                break
            time.sleep(poll_interval)

    except KeyboardInterrupt:
        print("\n🚫 Polling cancelled by user.")
    except Exception as e:
        print(f"\n❌ Error during polling: {e}")

def input_loop():
    global fetch_n_messages
    print("🧠 e is in shell mode.")
    while True:
        try:
            prompt = input("\n====================\n🧍 You (↩,s,l,p,?)> ").strip()
            mode = "s" if prompt == "" else prompt
            if prompt == "?":
                print("↩: fetch+parse | s: skip | l: last only | a: all | p: poll | @paste = multiline")
                continue
            if prompt == "p":
                stream_reply_loop()
                continue
            if prompt.isdigit():
                fetch_n_messages = int(prompt)
                continue
            parsed = interpret_input(prompt, is_shell=True)
            if parsed:
                print("\n📡 Interpreted:\n" + parsed)
        except KeyboardInterrupt:
            print("\n👋 Ctrl+C exit request.")
            raise

if __name__ == "__main__":
    input_loop()
