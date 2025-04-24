import asyncio
import subprocess
import re
import tempfile
from pathlib import Path
import sendtobrain
import output_core
import cdp_instance
from telegram_runner import conversations

cdp = cdp_instance.cdp

_input_handlers = {}

async def stream_reply_loop(chat_id, conversation):
    cdp_instance.switch_tab(chat_id)
    await output_core.send_output("shell", "\n🔁 Polling for brain reply. Ctrl+C to stop.\n")

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
    last_update_time = asyncio.get_event_loop().time()
    timeout = 10
    poll_interval = 0.5

    conversation.streaming_input = True
    try:
        loop = asyncio.get_event_loop()
        while True:
            result = await loop.run_in_executor(None, cdp.evaluate, js)
            messages = result.get("result", {}).get("result", {}).get("value", [])
            new_content = False
            for m in messages[-1:]:
                msg_id = m.get("id")
                txt = m.get("text", "")
                if not msg_id or not txt:
                    continue
                if seen.get(msg_id) != txt:
                    seen[msg_id] = txt
                    prefix = "🧍 You:" if m.get("role") == "user" else "🤖 e:"
                    accumulated += f"{prefix}\n{txt}\n"
                    await output_core.send_output("all", accumulated, chat_id=chat_id, is_final=False)
                    last_update_time = asyncio.get_event_loop().time()
                    new_content = True
            if not new_content and asyncio.get_event_loop().time() - last_update_time > timeout:
                await output_core.send_output("all", accumulated.strip(), chat_id=chat_id, is_final=True)
                output_core.update_output_handler_state("telegram", "last_msg_id", None)
                conversation.agent_state.last_msg_id = None
                conversations[chat_id] = conversation
                await output_core.send_output("shell", f"🛑 No new messages for {timeout} seconds. Stopping.")
                break
            await asyncio.sleep(poll_interval)
    except asyncio.CancelledError:
        await output_core.send_output("shell", "\n🚫 Polling cancelled.")
        raise
    except Exception as e:
        await output_core.send_output("shell", f"\n❌ Error during polling: {e}")
    finally:
        conversation.streaming_input = False

async def interpret_input(prompt, conversation, is_shell=True):
    prompt = prompt.strip()
    agent_state = conversation.agent_state

    if prompt == "@paste":
        await output_core.send_output("shell", "📂 Paste mode enabled — save to temp file and press Enter.\n-------- begin paste --------")
        try:
            temp_file = Path(tempfile.gettempdir()) / f"paste_{conversation.chat_id}.txt"
            await output_core.send_output("shell", f"Write input to {temp_file} and save.")
            input("Press Enter when done: ")  # Synchronous, user-driven
            loop = asyncio.get_event_loop()
            pasted = await loop.run_in_executor(None, lambda: temp_file.read_text(encoding="utf-8"))
            agent_state.pending_output = ("text", pasted, 0)
            await output_core.send_output("shell", "-------- end paste --------")
            sendtobrain.reflect(pasted)
            await stream_reply_loop(conversation.chat_id, conversation)
            return "✅ Pasted and sent."
        except KeyboardInterrupt:
            return "❌ Paste cancelled."
        finally:
            temp_file.unlink(missing_ok=True)

    split = prompt.rsplit('---', 1)
    body = split[-1] if len(split) > 1 else prompt
    body = body.replace("<<EOF", "<<'EOF'")

    match = re.search(r"@exec:\s*(cat\s+<<'EOF'\s+>.*?\nEOF)", body, re.DOTALL)
    if match:
        script_block = match.group(1).strip()
        agent_state.pending_exec = script_block
        return f"⚙️ Detected patch block:\n\n{script_block}\n\n💡 Reply 'y' to approve execution, or 'n' to cancel."

    match2 = re.search(r"(?:^|\n)@exec:\s*(.+)", body)
    if match2:
        command = match2.group(1).strip()
        agent_state.pending_exec = command
        return f"⚙️ Proposed Command:\n\n{command}\n\n💡 Reply 'y' to approve execution, or 'n' to cancel."

    if prompt.lower() in {"y", "n"} and agent_state.pending_exec:
        if prompt.lower() == "y":
            cmd = agent_state.pending_exec
            try:
                loop = asyncio.get_event_loop()
                if "\n" in cmd:
                    patch_file = Path(tempfile.gettempdir()) / "patch_apply.sh"
                    patch_file.write_text(cmd + "\n", encoding="utf-8")
                    result = await loop.run_in_executor(None, lambda: subprocess.run(
                        ["bash", str(patch_file)], capture_output=True, text=True
                    ))
                else:
                    result = await loop.run_in_executor(None, lambda: subprocess.run(
                        cmd, shell=True, capture_output=True, text=True
                    ))
                output = result.stdout.strip() + "\n" + result.stderr.strip()
                status = result.returncode
            except Exception as e:
                output = str(e)
                status = -1
            await output_core.send_output("shell", f"\n📄 Output:\n====\n{output}\n====\n🔚 Exit Status: {status}")
            agent_state.pending_exec = None
            chat_id = agent_state.telegram_chat_id
            if chat_id:
                await output_core.send_telegram(chat_id, f"📄 Output:\n{output.strip()}\n\n🔚 Exit Status: {status}")
            sendtobrain.reflect(output)
            await stream_reply_loop(conversation.chat_id, conversation)
            return None
        elif prompt.lower() == "n":
            agent_state.pending_exec = None
            await output_core.send_output("shell", "❌ Command cancelled.")
            return "✅ Command cancelled — waiting for next input."

    if len(prompt) == 1:
        await output_core.send_output("shell", "⚠️ Single-character responses are ignored unless approving a command.")
        return None

    return prompt

def register_input_handler(name, handler, editable=False):
    _input_handlers[name] = {
        "handler": handler,
        "editable": editable,
        "last_msg_id": None
    }
