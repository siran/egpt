import asyncio
import sys
import html
import cdp_instance
import output_core

cdp = cdp_instance.cdp

async def press_enter():
    js_click = '''
    (() => {
        const btn = document.querySelector('button#composer-submit-button');
        if (!btn) return false;
        btn.click();
        console.log("🚀 Submit button clicked.");
        return true;
    })();
    '''
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, cdp.evaluate, js_click)
    return result.get("result", {}).get("result", {}).get("value", False)

async def reflect(msg, source="shell"):
    await output_core.send_output("shell", "📤 Injecting content...")
    try:
        lines = html.escape(msg).splitlines()
        wrapped = "".join(f"<p>{line}</p>" for line in lines)
        wrapped_escaped = wrapped.replace("`", "\\`")

        js = f"""
        (() => {{
            const ta = document.querySelector('#prompt-textarea');
            if (!ta) {{
                console.log("❌ Textarea not found.");
                return false;
            }}
            ta.focus();
            ta.innerHTML = `{wrapped_escaped}`;
            ta.dispatchEvent(new InputEvent('input', {{ bubbles: true }}));
            ta.dispatchEvent(new Event('change', {{ bubbles: true }}));
            console.log("✅ innerHTML injected with <p> blocks.");
            return true;
        }})();
        """

        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, cdp.evaluate, js)
        injected = result.get("result", {}).get("result", {}).get("value", False)
        if not injected:
            await output_core.send_output("shell", "❌ Text injection failed.")
            return False

        await asyncio.sleep(0.1)
        if await press_enter():
            await output_core.send_output("shell", "✅ Message submitted.")
        else:
            await output_core.send_output("shell", "❌ Failed to click submit button.")
            return False
        return True
    except Exception as e:
        await output_core.send_output("shell", f"❌ Failed to inject message: {e}")
        return False

if __name__ == "__main__":
    if len(sys.argv) < 2:
        asyncio.run(output_core.send_output("shell", "❌ No message provided. Must pass as CLI argument."))
        sys.exit(1)

    message = sys.argv[1]
    if message.strip():
        asyncio.run(reflect(message.strip()))
    else:
        asyncio.run(output_core.send_output("shell", "❌ Message was empty. Aborting."))
