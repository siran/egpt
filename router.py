import input_core
import output_core
import sendtobrain
import cdp_instance

from telegram_runner import conversations  # or conversation import depending on structure

async def route_message(text, source="shell", conversation=None):
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
        last_id = result.get("result", {}).get("result", {}).get("value", None)
        if last_id:
            conversation.last_seen_msg_id = last_id
            print(f"📍 Pre-reflect last_seen_msg_id = {last_id}")

        # ✅ Reflect if from user
        if source == "telegram_user":
            response = await output_core.send_output("brain", text, conversation=conversation)
            if response:
                await input_core.stream_reply_loop(conversation)

        # # Optional: show visual waiting in Telegram
        # if source == "telegram":
        #     msg_id = await output_core.send_output("telegram", "⏳ Waiting for brain to reply...", chat_id=conversation.chat_id)
        #     return msg_id

    return None
