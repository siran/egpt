import asyncio
import subprocess
import re
import tempfile
from pathlib import Path
import traceback
import router
import sendtobrain
import output_core
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

    conversation.streaming_input = True

    poll_last_n_messages = kwargs.get("poll_last_n_messages", None)

    js = '''
        (() => {
            return Array.from(document.querySelectorAll("[data-message-id]")).map(el => {
                const id = el.getAttribute("data-message-id") || "";
                const role = el.closest('[data-message-author-role]')?.getAttribute('data-message-author-role') || "no-role";
                const contentDiv = el.querySelector("div.markdown");
                const html = contentDiv ? contentDiv.innerHTML : "";
                return { id, role, html };
            });
        })();
    '''

    seen = {}
    last_txt = None
    last_telegram_msg_id = conversation.last_telegram_msg_id
    last_ui_msg_id = conversation.last_ui_msg_id
    last_update_time = asyncio.get_event_loop().time()
    timeout = 10
    poll_interval = 0.5
    retries = 0
    max_retries = 6

    try:
        while True:
            result = await cdp.evaluate(js)
            if not isinstance(result, dict):
                await output_core.send_output("shell", "⚠️ Invalid CDP result, retrying...")
                await asyncio.sleep(1)
                continue

            messages = result.get("result", {}).get("result", {}).get("value", [])
            if not isinstance(messages, list):
                retries += 1
                if retries >= max_retries:
                    await output_core.send_output("shell", "❌ Too many retries, aborting.")
                    break
                await asyncio.sleep(1)
                continue

            new_content = False
            old_message = True

            if poll_last_n_messages:
                messages = messages[-poll_last_n_messages:]
            for m in messages:
                msg_id = m.get("id")
                txt = m.get("html", "")
                role = m.get("role", "")

                if not msg_id:
                    continue

                if last_ui_msg_id and old_message:
                    if msg_id == last_ui_msg_id:
                        old_message = False
                    continue

                if role != "assistant":
                    continue

                cleaned = clean_html_for_telegram(txt.strip())
                if not cleaned or seen.get(msg_id) == cleaned:
                    continue

                seen[msg_id] = cleaned
                last_txt = cleaned

                await output_core.send_output("shell", f"📨 Updating Telegram: {last_txt}")

                new_msg_id = await output_core.send_output(
                    "telegram",
                    last_txt,
                    conversation=conversation,
                    is_final=False,
                    msg_id=last_telegram_msg_id
                )

                if new_msg_id:
                    last_telegram_msg_id = new_msg_id
                    conversation.last_telegram_msg_id = new_msg_id

                last_update_time = asyncio.get_event_loop().time()
                new_content = True

            if not new_content and asyncio.get_event_loop().time() - last_update_time > timeout:
                await output_core.send_output("shell", "🛑 Timeout reached, finalizing stream.")
                if last_txt and last_telegram_msg_id:
                    await output_core.send_output(
                        "telegram",
                        last_txt.strip(),
                        conversation=conversation,
                        is_final=True,
                        msg_id=last_telegram_msg_id
                    )
                    await output_core.send_output("shell", "✅ Final assistant message delivered.")
                else:
                    await output_core.send_output("shell", "⚠️ Nothing to finalize.")
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
        user_id = str(conversation.user_id)
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
            await output_core.send_output("shell", f"\n📄 Output:\n====\n{output}\n====\n🔚 Exit Status: {status}")
            conversation.pending_exec = None
            chat_id = conversation.chat_id
            if chat_id:
                await output_core.send_telegram(chat_id, f"📄 Output:\n{output.strip()}\n\n🔚 Exit Status: {status}")
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
