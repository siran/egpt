import input_core
import output_core
import sendtobrain
import cdp_instance

from telegram_runner import Conversation

async def route_message(text, source="shell", conversation:Conversation=None):
    text = text.strip()

    if len(text) > 1 and conversation:
        conversation.pending_output = ("text", text, 0)

        # 🧠 Before reflecting, record last message ID
        js = '''
        (() => {
          const msgs = Array.from(document.querySelectorAll("[data-message-id]"));
          if (msgs.length === 0) return null;
          const last = msgs[msgs.length - 1];
          return last.getAttribute("data-message-id") || null;
        })();
        '''
        result = await cdp_instance.cdp.evaluate(js)
        last_seen_msg_id = result.get("result", {}).get("result", {}).get("value", None)
        if last_seen_msg_id:
            conversation.last_seen_msg_id = last_seen_msg_id
            print(f"📍 Pre-reflect last_seen_msg_id = {last_seen_msg_id}")

        if source == "telegram_user":
            # 1. Inject into brain
            success = await output_core.send_output("brain", text, conversation=conversation)

            if success:
                # 2. Notify Telegram of pending response
                msg_id = await output_core.send_output(
                    "telegram",
                    "⏳ Waiting for brain to reply...",
                    chat_id=conversation.chat_id,
                    conversation=conversation  # ✅ full object passed
                )
                conversation.last_msg_id = msg_id

                # 3. Stream response
                await input_core.stream_reply_loop(conversation)

    return None
