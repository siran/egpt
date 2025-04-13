# memory.py — memory persistence and recall

import json
import os

class Memory:
    def __init__(self, path="state/memory.json"):
        self.path = path
        self.data = self._load()

    def _load(self):
        if os.path.exists(self.path):
            with open(self.path, "r", encoding="utf-8") as f:
                return json.load(f)
        else:
            return []

    def save(self):
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self.data, f, indent=2)

    def append(self, message):
        self.data.append(message)

    def get(self):
        return self.data

    def reset(self):
        self.data = []
        self.save()

    def dump(self):
        print(json.dumps(self.data, indent=2))

    def load_reminiscence(self, path="state/e.origin.txt"):
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                print("📜 Recalling long-form memory from origin...")
                self.append({
                    "role": "system",
                    "content": f"(reminiscence)\n{f.read().strip()}"
                })

    def recall_recent(self, n=20):
        return self.data[-n:] if len(self.data) > n else self.data
