import json
import requests
import websocket
import time

class ChromeCDP:
    def __init__(self, port=9222):
        self.port = port
        self.ws = None
        self.tab_url = None
        self.msg_id = 0

    def connect(self):
        try:
            tabs = requests.get(f"http://localhost:{self.port}/json").json()
            for tab in tabs:
                if any(domain in tab.get("url", "") for domain in ["chat.openai.com", "chatgpt.com"]):
                    self.tab_url = tab["webSocketDebuggerUrl"]
                    break
            else:
                print("❌ No ChatGPT tab found.")
                return False

            self.ws = websocket.create_connection(self.tab_url)
            print("🧠 Connected to ChatGPT tab via CDP.")
            return True
        except Exception as e:
            print(f"❌ Failed to connect to CDP: {e}")
            return False

    def send(self, method, params=None):
        self.msg_id += 1
        message = {
            "id": self.msg_id,
            "method": method,
            "params": params or {}
        }
        self.ws.send(json.dumps(message))
        while True:
            response = self.ws.recv()
            if f'"id":{self.msg_id}' in response:
                return json.loads(response)

    def evaluate(self, js_code):
        return self.send("Runtime.evaluate", {
            "expression": js_code,
            "returnByValue": True
        })

    def chatgpt_send(self, message):
        self.evaluate(f"""
            (() => {{
                const box = document.querySelector("textarea");
                if (!box) console.log('there is no box');
                box.value = {json.dumps(message)};
                box.dispatchEvent(new Event("input", {{ bubbles: true }}));
                const button = document.querySelector('[data-testid="send-button"]');
                if (button) button.click();
            }})();
        """)
        print("💬 chatgpt_send: Typed and clicked send.")


    def close(self):
        if self.ws:
            self.ws.close()
            print("🔌 CDP connection closed.")
