import time
import requests
import websocket
import json

class ChromeCDP:
    def __init__(self):
        self.ws = None
        self.msg_id = 0

    def connect(self, url="ws://localhost:9222/devtools/page/1"):
        try:
            self.ws = websocket.create_connection(url)
            return True
        except Exception as e:
            print("⚠️ CDP connection failed:", e)
            return False

    def send(self, method, params=None):
        self.msg_id += 1
        message = {
            "id": self.msg_id,
            "method": method,
            "params": params or {}
        }
        self.ws.send(json.dumps(message))
        return self.msg_id

    def recv(self):
        return json.loads(self.ws.recv())

    def evaluate(self, expression):
        self.send("Runtime.evaluate", {
            "expression": expression,
            "awaitPromise": True,
            "returnByValue": True
        })
        while True:
            response = self.recv()
            if response.get("id") == self.msg_id:
                return response

    def click(self, selector):
        js = f'''
        (() => {{
            const el = document.querySelector("{selector}");
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const evt = new MouseEvent('click', {{
                view: window,
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y
            }});
            el.dispatchEvent(evt);
            return true;
        }})();
        '''
        return self.evaluate(js)

    def type_text(self, text):
        for c in text:
            if c == "\n":
                self.send("Input.dispatchKeyEvent", {
                    "type": "keyDown",
                    "key": "Enter",
                    "code": "Enter",
                    "windowsVirtualKeyCode": 13,
                    "nativeVirtualKeyCode": 13,
                    "modifiers": 8  # Shift
                })
                self.send("Input.dispatchKeyEvent", {
                    "type": "keyUp",
                    "key": "Enter",
                    "code": "Enter",
                    "windowsVirtualKeyCode": 13,
                    "nativeVirtualKeyCode": 13,
                    "modifiers": 8
                })
            else:
                self.send("Input.dispatchKeyEvent", {
                    "type": "char",
                    "text": c,
                    "unmodifiedText": c,
                    "key": c
                })
            time.sleep(0.01)

    def press_enter(self):
        self.send("Input.dispatchKeyEvent", {
            "type": "keyDown",
            "key": "Enter",
            "code": "Enter",
            "windowsVirtualKeyCode": 13,
            "nativeVirtualKeyCode": 13
        })
        self.send("Input.dispatchKeyEvent", {
            "type": "keyUp",
            "key": "Enter",
            "code": "Enter",
            "windowsVirtualKeyCode": 13,
            "nativeVirtualKeyCode": 13
        })

    def focus_chat(self):
        return self.click("textarea[data-id='root']") or self.click("textarea")

    def type_and_send(self, text):
        self.focus_chat()
        time.sleep(0.3)
        self.type_text(text)
        time.sleep(0.3)
        self.press_enter()

    def wait_for_reply_end(self, timeout=90):
        print("⏳ Waiting for reply to finish", end="", flush=True)
        js = '''
        (() => {
            const btn = document.querySelector('form')?.querySelectorAll('button')[6];
            if (!btn) return "none";
            return btn.getAttribute("aria-label") || "none";
        })();
        '''
        recent = []
        start = time.time()
        try:
            while time.time() - start < timeout:
                result = self.evaluate(js)
                label = result.get("result", {}).get("result", {}).get("value", "")
                recent.append(label)
                if len(recent) > 3:
                    recent = recent[-3:]
                    if recent[0] == recent[1] == recent[2]:
                        print(" ✅")
                        return True
                print(".", end="", flush=True)
                time.sleep(2)
        except KeyboardInterrupt:
            print(" 🛑 [cancelled by user]")
            return False
        print(" ⏱️ timeout")
        return False

    def create_and_navigate(self, url):
        try:
            info = requests.get("http://localhost:9222/json/version").json()
            browser_ws_url = info["webSocketDebuggerUrl"]
            print(f"🚀 Attempting to open new tab with URL {url}")
            ws = websocket.create_connection(browser_ws_url)
            self.msg_id += 1
            ws.send(json.dumps({
                "id": self.msg_id,
                "method": "Target.createTarget",
                "params": {
                    "url": url
                }
            }))
            response = json.loads(ws.recv())
            target_id = response["result"]["targetId"]
            ws.close()
            print(f"🌱 Created new tab: {target_id}")
            return True
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"❌ Failed to create new tab: {e}")
            return False
