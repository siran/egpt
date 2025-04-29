import asyncio
import subprocess
import re
import tempfile
from pathlib import Path
import traceback
import router
import sendtobrain
import output_core
import input_core
import cdp_instance
from telegram_runner import Conversation
from bs4 import BeautifulSoup
from load_config import get_config

cdp = cdp_instance.cdp

_input_handlers = {}

async def stream_reply_loop(conversation: Conversation, **kwargs):
    await output_core.send_output("shell", f"🔁 Streaming for conversation.chat_id = {conversation.chat_id}")
    await cdp_instance.switch_tab(conversation_id=conversation.tab_url)

    if conversation.streaming_input:
        await output_core.send_output("shell", "⚠️ Already streaming input, skipping.")
        return False

    # conversation.streaming_input = True

    js = '''
        (() => {
            const elements = document.querySelectorAll("[data-message-id]")
            const last_div = elements[elements.length - 1];

            return {
                id: last_div.getAttribute("data-message-id") || "",
                role: last_div.closest('[data-message-author-role]')?.getAttribute('data-message-author-role') || "no-role",
                html: (last_div.querySelector("div.markdown") || {}).innerHTML || "",
                continue_streaming: document.querySelector('button[aria-label~="streaming"]') || false
            };
        })();
    '''

    poll_interval = 0.2
    retries = 0
    max_retries = 5
    last_telegram_msg_id = conversation.last_telegram_msg_id

    try:
        while True:
            result = await cdp.evaluate(js)
            if not isinstance(result, dict):
                await output_core.send_output("shell", "⚠️ Invalid CDP result, retrying...")
                await asyncio.sleep(1)
                continue

            message = result.get("result", {}).get("result", {}).get("value", {})
            print(message)
            print(f'message.get("id", None) == {message.get("id", None)}')
            if not message.get("id", None):
                print("id is None")
                retries += 1
                if retries >= max_retries:
                    await output_core.send_output("shell", "❌ Too many retries, aborting.")
                    break
                await asyncio.sleep(1)
                continue

            m = message
            msg_id = m.get("id")
            txt = m.get("html", "")
            role = m.get("role", "")
            continue_streaming = bool(m.get("continue_streaming", ""))

            print(m)
            print(message)

            if not msg_id:
                continue

            if role != "assistant":
                continue

            cleaned = clean_html_for_telegram(txt.strip())
            last_txt = cleaned

            await output_core.send_output("shell", f"📨 Updating Telegram: {last_txt}")

            last_telegram_msg_id = await output_core.send_output(
                "telegram",
                last_txt,
                conversation=conversation,
                is_final=False,
                msg_id=last_telegram_msg_id
            )

            if not continue_streaming:
                await output_core.send_output(
                    "telegram",
                    last_txt,
                    conversation=conversation,
                    is_final=True,
                    msg_id=last_telegram_msg_id
                )
                result = await input_core.interpret_input(last_txt, conversation, is_shell=False)
                if result:
                    last_telegram_msg_id = await output_core.send_output("telegram", result, conversation=conversation)

                await output_core.send_output("shell", "✅ Final assistant message delivered.")

                break

            await asyncio.sleep(poll_interval)

    except asyncio.CancelledError:
        await output_core.send_output("shell", "🚫 Polling cancelled.")
        raise
    except Exception as e:
        traceback.print_exc()
        await output_core.send_output("shell", f"❌ Exception during polling: {e}")
    finally:
        conversation.streaming_input = False

def is_authorized_to_approve_command_exec(user_id: str) -> bool:
    config = get_config()
    architect_id = str(config.get("architect_tg_id", ""))
    architect_ids = config.get("architects_tg_ids", [])

    if user_id == architect_id:
        return True
    if user_id in architect_ids:
        return True
    return False

async def interpret_input(prompt, conversation, is_shell=True):
    prompt = prompt.strip()

    split = re.split(r'^---$', prompt, flags=re.MULTILINE)
    body = split[-1]
    body = body.replace("<<EOF", "<<'EOF'")

    if prompt == "@paste": # for shell multiline input, can be improved
        await output_core.send_output("shell", "📂 Paste mode enabled — save to temp file and press Enter.\n-------- begin paste --------")
        try:
            temp_file = Path(tempfile.gettempdir()) / f"paste_{conversation.chat_id}.txt"
            await output_core.send_output("shell", f"Write input to {temp_file} and save.")
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, lambda: input("Press Enter when done: "))
            pasted = await loop.run_in_executor(None, lambda: temp_file.read_text(encoding="utf-8"))
            conversation.pending_output = ("text", pasted, 0)
            await output_core.send_output("shell", "-------- end paste --------")
            await sendtobrain.reflect(pasted)
            await stream_reply_loop(conversation.chat_id)
            return "✅ Pasted and sent."
        except KeyboardInterrupt:
            return "❌ Paste cancelled."
        finally:
            temp_file.unlink(missing_ok=True)


    match = re.search(r"@exec:\s*(cat\s+<<'EOF'\s+>.*?\nEOF)", body, re.DOTALL)
    if match:
        script_block = match.group(1).strip()
        conversation.pending_exec = script_block
        return f"⚙️ Detected patch block:\n\n{script_block}\n\n💡 Reply 'y' to approve execution, or 'n' to cancel."

    match2 = re.search(r"(?:^|\n)@exec:\s*(.+)", body)
    if match2:
        command = match2.group(1).strip()
        conversation.pending_exec = command
        return f"⚙️ Proposed Command:\n\n{command}\n\n💡 Reply 'y' to approve execution, or 'n' to cancel."

    if prompt.lower() in {"y", "n"} and conversation.pending_exec:
        user_id = str(conversation.telegram_user_id)
        if not is_authorized_to_approve_command_exec(user_id):
            await output_core.send_output("shell", f"❌ User {user_id} not authorized to approve commands.")
            return "✅ Approval ignored — waiting for Architect(s)."
        if prompt.lower() == "y":
            cmd = conversation.pending_exec
            try:
                loop = asyncio.get_event_loop()
                result = await loop.run_in_executor(None, lambda: subprocess.run(
                        cmd, shell=True, capture_output=True, text=True
                    ))
                output = result.stdout.strip() + "\n" + result.stderr.strip()
                status = result.returncode
            except Exception as e:
                output = str(e)
                status = -1
            msg = f"Command:\n{cmd}\n📄 Output:\n{output}\n\n🔚 Exit Status: {status}"
            await output_core.send_output("shell", msg)
            conversation.pending_exec = None
            chat_id = conversation.chat_id
            if chat_id:
                await output_core.send_telegram(chat_id, msg)
            await sendtobrain.reflect(output)
            await stream_reply_loop(conversation, poll_last_n_messages=1)
            return None
        elif prompt.lower() == "n":
            conversation.pending_exec = None
            await output_core.send_output("shell", "❌ Command cancelled.")
            return "✅ Command cancelled — waiting for next input."

    if len(prompt) == 1:
        await output_core.send_output("shell", "⚠️ Single-character responses are ignored unless approving a command.")
        return None

    return None

def register_input_handler(name, handler, editable=False):
    _input_handlers[name] = {
        "handler": handler,
        "editable": editable,
        "last_msg_id": None
    }

def clean_html_for_telegram(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    allowed_tags = {"b", "i", "u", "s", "code", "pre"}
    for tag in soup.find_all(True):
        if tag.name not in allowed_tags:
            tag.unwrap()
        else:
            tag.attrs = {}
    cleaned_html = str(soup)
    cleaned_html = re.sub(r'\w+CopyEdit', '', cleaned_html)
    return cleaned_html.strip()
