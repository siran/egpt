import asyncio
import html
import time
from cdp_instance import cdp
import output_core

async def press_enter():
    js_click = '''
    (() => {
        const btn = document.querySelector('button#composer-submit-button');
        if (!btn) return false;
        btn.click();
        return true;
    })();
    '''
    result = await cdp.evaluate(js_click)
    return result.get("result", {}).get("result", {}).get("value", False)

async def reflect(msg, source="shell"):
    await output_core.send_output("shell", f"📤 Injecting content: {msg}")
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
            return true;
        }})();
        """

        result = await cdp.evaluate(js)
        injection_succeeded = result.get("result", {}).get("result", {}).get("value", None)

        if not injection_succeeded:
            await output_core.send_output("shell", "❌ Text injection failed.")
            return False

        await asyncio.sleep(0.3)

        if not await press_enter():
            await output_core.send_output("shell", "❌ Failed to click submit button.")
            return False

        return True

    except Exception as e:
        import traceback
        traceback.print_exc()
        await output_core.send_output("shell", f"❌ Exception during inject: {e}")
        return False
