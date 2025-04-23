import subprocess
import sys
import re
import tempfile
import time
from pathlib import Path
import sendtobrain
import output_core
from load_config import AgentState

agent_state = AgentState()

import cdp_instance

cdp = cdp_instance.cdp

_input_handlers = {}

def stream_reply_loop(conversation_id):
    cdp_instance.switch_tab(conversation_id)
    output_core.send_output("shell", "\n🔁 Polling for brain reply. Ctrl+C to stop.\n")

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
    accumulated = ""
    last_update_time = time.time()
    timeout = 10
    poll_interval = 0.5

    try:
        while True:
            result = cdp.evaluate(js)
            messages = result.get("result", {}).get("result", {}).get("value", [])
            new_content = False
            for m in messages[-1:]:
                msg_id = m.get("id")
                txt = m.get("text", "")  # ← do NOT strip!
                if not msg_id or not txt:
                    continue
                if seen.get(msg_id) != txt:
                    seen[msg_id] = txt
                    prefix = "🧍 You:" if m.get("role") == "user" else "🤖 e:"
                    accumulated += f"{prefix}\n{txt}\n"
                    output_core.send_output("all", accumulated, is_final=False)
                    last_update_time = time.time()
                    new_content = True
            if not new_content and time.time() - last_update_time > timeout:
                output_core.send_output("all", accumulated.strip(), is_final=True)

                from output_core import update_output_handler_state
                update_output_handler_state("telegram", "last_msg_id", None)

                output_core.send_output("shell", f"🛑 No new messages for {timeout} seconds. Stopping.")
                break
            time.sleep(poll_interval)

    except KeyboardInterrupt:
        output_core.send_output("shell", "\n🚫 Polling cancelled by user.")
    except Exception as e:
        output_core.send_output("shell", f"\n❌ Error during polling: {e}")


def interpret_input(prompt, is_shell=True):
    prompt = prompt.strip()

    if prompt == "@paste":
        output_core.send_output("shell", "📂 Paste mode enabled — press Ctrl+D when done.\n-------- begin paste --------")
        try:
            pasted = sys.stdin.read().strip()
            agent_state["pending_output"] = ("text", pasted, 0)
            output_core.send_output("shell", "-------- end paste --------")
            sendtobrain.reflect(pasted)
            stream_reply_loop()
            return "✅ Pasted and sent."
        except KeyboardInterrupt:
            return "❌ Paste cancelled."

    split = prompt.rsplit('---', 1)
    body = split[-1] if len(split) > 1 else prompt
    body = body.replace("<<EOF", "<<'EOF'")

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
            output_core.send_output("shell", f"\n📄 Output:\n====\n{output}\n====\n🔚 Exit Status: {status}")
            agent_state["pending_exec"] = None
            from telegram_runner import send_telegram
            chat_id = agent_state.get("telegram_chat_id")
            if chat_id:
                send_telegram(chat_id, f"📄 Output:\n{output.strip()}\n\n🔚 Exit Status: {status}")
            sendtobrain.reflect(output)
            stream_reply_loop()
            return None
        elif prompt.lower() == "n":
            agent_state["pending_exec"] = None
            output_core.send_output("shell", "❌ Command cancelled.")
            return "✅ Command cancelled — waiting for next input."

    # if agent_state.get("pending_exec"):
    #     agent_state["pending_exec"] = None
    #     sendtobrain.reflect(prompt)
    #     stream_reply_loop()
    #     return None

    if len(prompt) == 1:
        output_core.send_output("shell", "⚠️ Single-character responses are ignored unless approving a command.")
        # return "✅ Ignored single character."
        return None

    return prompt

def register_input_handler(name, handler, editable=False):
    global agent_state

    _input_handlers[name] = {
        "handler": handler,
        "editable": editable,
        "last_msg_id": None
    }
