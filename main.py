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

with open("config.yaml", "r") as f:
    config = yaml.safe_load(f)

MODEL = config.get("model", "gpt-4")
try:
    say("loading openai", "boot")
    from openai import OpenAI
    say("loaded openai", "boot")
    client = OpenAI(api_key=config["openai_api_key"])
    say("created client OAI", "boot")
except:
    client = None

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
    "interactive_local": False,
}

seen_messages = {}

def detect_structured_command(text):
    body = text.split("---")[-1]
    match = re.search(r"(^|\n\n)@(\w+):\s*(.*?)\s*\n\n", body, re.DOTALL)
    if match:
        cmd, payload = match[2].strip().lower(), match[3].strip()
        return cmd, payload
    return None, None

def interpret_input(prompt, is_shell=True):
    import sys
    import re
    import tempfile
    from pathlib import Path
    import subprocess

    prompt = prompt.strip()

    if prompt == "@paste":
        print("📂 Paste mode enabled — press Ctrl+D when done.\n")
        print("-------- begin paste --------")
        try:
            pasted = sys.stdin.read().strip()
            agent_state["pending_output"] = ("text", pasted, 0)
            print("-------- end paste --------\n")
            return "📝 Pasted block detected.\n💡 Reflect to ChatGPT? (y/n)"
        except KeyboardInterrupt:
            return "❌ Paste cancelled."

    # === Detect @exec ===
    split = prompt.rsplit('---', 1)
    body = split[-1] if len(split) > 1 else prompt

    # HEREDOC-style block
    match = re.search(r"@exec:\s*(cat\s+<<EOF\s+>.*?\nEOF)", body, re.DOTALL)
    if match:
        script_block = match.group(1).strip()
        agent_state["pending_exec"] = script_block
        return f"⚙️ Detected patch block:\n\n{script_block}\n\n💡 Apply this patch? (y/n)"

    # Single-line command
    match2 = re.search(r"(?:^|\n)@exec:\s*(.+)", body)
    if match2:
        command = match2.group(1).strip()
        agent_state["pending_exec"] = command
        return f"⚙️ Proposed Command:\n\n{command}\n\n💡 Apply this command? (y/n)"

    # === Confirm exec ===
    if len(prompt.lower()) == 1 or prompt == "":
        if agent_state["pending_exec"]:
            if prompt == "y":
                cmd = agent_state["pending_exec"]
                try:
                    if "\n" in cmd:
                        # HEREDOC multiline patch
                        patch_file = Path(tempfile.gettempdir()) / "patch_apply.sh"
                        patch_file.write_text(cmd + "\n", encoding="utf-8")
                        result = subprocess.run(["bash", str(patch_file)], capture_output=True, text=True)
                    else:
                        # Single-line command
                        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)

                    output = result.stdout.strip() + "\n" + result.stderr.strip()
                    status = result.returncode
                except Exception as e:
                    output = str(e)
                    status = -1

                print(f"\n📄 Output:\n====\n\n{output}\n\n====\n🔚 Exit Status: {status}")
                agent_state["pending_exec"] = None

                try:
                    msg = f"📄 Output:\n{output.strip()}\n\n🔚 Exit Status: {status}"
                    import sendtobrain
                    sendtobrain.reflect(msg)
                    print("🧠 Output sent to ChatGPT.")
                    from cdp_instance import cdp
                    if cdp:
                        cdp.wait_for_reply_end(timeout=90)
                except Exception as e:
                    print(f"❌ Failed to reflect output: {e}")
                return None
            else:
                agent_state["pending_exec"] = None
                return "❌ Patch/command aborted."

        # === Handle confirmed message reflection ===
        elif agent_state["pending_output"]:
            cmd, output, status = agent_state["pending_output"]
            if prompt in ["y", ""]:
                print("🧠 Sending to ChatGPT via CDP:")
                try:
                    msg = output.strip() if cmd == "text" else f"📄 Output:\n{output}\n\n🔚 Exit Status: {status}"
                    import sendtobrain
                    sendtobrain.reflect(msg)
                    print("🧠 Output sent to ChatGPT.")
                    from cdp_instance import cdp
                    if cdp:
                        cdp.wait_for_reply_end(timeout=90)
                except Exception as e:
                    print(f"❌ Failed to send to brain: {e}")
                agent_state["pending_output"] = None
                return None
            else:
                agent_state["pending_output"] = None
                return "❌ Skipped sending to ChatGPT."

        return "✅ Response received, but no command/output was pending."

    # === Handle @reflect ===
    cmd, payload = detect_structured_command(prompt)
    if cmd == "reflect":
        import sendtobrain
        sendtobrain.reflect(payload)
        return f"🪞 Reflected to brain: {payload}"

    # === Handle plain input ===
    if is_shell and len(prompt) > 1 and not prompt.startswith("@"):
        agent_state["pending_output"] = ("text", prompt, 0)
        return "📝 Detected plain message.\n💡 Send this to ChatGPT context? (y/n)"

    return None

def fetch_latest_messages(n=fetch_n_messages):
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
    last_msg = None

    try:
        while True:
            result = cdp.evaluate(js)
            messages = result.get("result", {}).get("result", {}).get("value", [])[-4:]
            for m in messages:
                msg_id = m.get("id")
                txt = m.get("text", "").strip()
                if not msg_id or not txt:
                    continue
                if seen.get(msg_id) == txt:
                    continue
                seen[msg_id] = txt
                last_msg = m
                prefix = "🧍 You:" if m.get("role") == "user" else "🤖 e:"
                print(f"\n{prefix}\n{txt}\n")
            time.sleep(2)

    except KeyboardInterrupt:
        print("\n🛑 Stream ended.")
        if last_msg:
            txt = last_msg.get("text", "").strip()
            parsed = interpret_input(txt, is_shell=False)
            if parsed:
                print("\n📡 Interpreted:\n" + parsed)
                if parsed.startswith("⚙️ Proposed Command") or parsed.startswith("✅ Executed locally:"):
                    while True:
                        answer = input("\n🧠 Approve? y/n > ").strip().lower()
                        if answer in {"y", "n"}:
                            result = interpret_input(answer, is_shell=True)
                            if result:
                                print("\n📡 Result:\n" + result)
                            break
                        else:
                            print("❗ Please answer 'y' or 'n'.")

def input_loop():
    global fetch_n_messages
    print("🧠 e is in shell mode.")
    while True:
        try:
            prompt = input("\n====================\n🧍 You (↩,s,l,p,?)> ").strip()
            mode = "s" if prompt == "" else prompt
            if prompt == "?":
                print("↩: fetch+parse | s: skip | l: last only | a: all | p: enter polling mode | @paste: multiline input")
                continue
            if prompt == "p":
                stream_reply_loop()
                continue
            if prompt.isdigit():
                fetch_n_messages = int(prompt)
                continue

            if mode in {"s", "a", "l"}:
                messages = fetch_latest_messages(n=fetch_n_messages)
                if not messages:
                    print("⚠️ No messages found.")
                    continue

                for i, msg in enumerate(messages):
                    msg_id = msg.get("id")
                    txt = msg.get("text", "").strip()
                    role = msg.get("role", "")
                    if not msg_id or not txt:
                        continue
                    if mode != "l" and seen_messages.get(msg_id) == txt:
                        continue

                    seen_messages[msg_id] = txt
                    prefix = "🧍 You:" if role == "user" else "🤖 e:"
                    print(f"\n====================\n{prefix}\n{txt}\n====================\n\n")

                    if mode == "s":
                        continue
                    if mode == "l" and i != len(messages) - 1:
                        continue

                    parsed = interpret_input(txt, is_shell=False)
                    if parsed:
                        print("\n📡 Interpreted:\n" + parsed)
                        if agent_state["pending_exec"]:
                            answer = input("\n🧠 Approve? y/n > ").strip().lower()
                            result = interpret_input(answer, is_shell=False)
                            if result:
                                print("\n📡 Result:\n" + result)
                continue

            parsed = interpret_input(prompt, is_shell=True)
            if parsed:
                print("\n📡 Interpreted:\n" + parsed)
                if parsed.startswith("⚙️ Proposed Command") or parsed.startswith("✅ Executed locally:") or parsed.startswith("📝 Detected plain message") or parsed.startswith("📝 Pasted block"):
                    answer = input("\n🧠 Approve? y/n > ").strip().lower()
                    result = interpret_input(answer, is_shell=True)
                    if result:
                        print("\n📡 Result:\n" + result)

        except KeyboardInterrupt:
            print("\n👋 Ctrl+C exit request.")
            raise

if __name__ == "__main__":
    input_loop()
