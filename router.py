import input_core
import output_core
import sendtobrain
import cdp_instance

from telegram_runner import Conversation

async def route_message(text, source="shell", conversation: Conversation = None):
    text = text.strip()

    if len(text) > 1 and conversation:
        conversation.pending_output = ("text", text, 0)

        # 🧠 Before reflecting, record last seen ChatGPT UI message ID
        js = '''
        (() => {
          const msgs = Array.from(document.querySelectorAll("[data-message-id]"));
          if (msgs.length === 0) return null;
          const last = msgs[msgs.length - 1];
          return last.getAttribute("data-message-id") || null;
        })();
        '''
        result = await cdp_instance.cdp.evaluate(js)
        last_ui_msg_id = result.get("result", {}).get("result", {}).get("value", None)
        if last_ui_msg_id:
            conversation.last_ui_msg_id = last_ui_msg_id
            print(f"📍 Pre-reflect last_ui_msg_id = {last_ui_msg_id}")

        if source == "telegram_user":
            new_msg_id = await output_core.send_output(
                "telegram",
                "⏳ Sending to brain...",
                conversation=conversation
            )
            if new_msg_id:
                conversation.last_telegram_msg_id = new_msg_id
                await output_core.send_output("shell", f"✅ Registered last_telegram_msg_id: {new_msg_id}")
            else:
                await output_core.send_output("shell", "⚠️ Could not register Telegram waiting message, continuing.")

            success = await output_core.send_output("brain", text, conversation=conversation)

            if success:
                await input_core.stream_reply_loop(conversation)
            else:
                await output_core.send_output("shell", "⚠️ Failed to send text to brain.")

    return None
