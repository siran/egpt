import yaml
import pathlib

from dataclasses import dataclass

@dataclass
class AgentState:
    pending_exec = None
    pending_output = None
    telegram_chat_id = None
    last_msg_id = None




agent_state = AgentState()

_config = None

def get_config():
    global _config
    if _config is None:
        base = pathlib.Path(__file__).resolve().parent
        with open(base / "config.yaml", "r") as f:
            _config = yaml.safe_load(f)
    return _config
