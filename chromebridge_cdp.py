import time
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
                    "modifiers": 8  # Shift
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
