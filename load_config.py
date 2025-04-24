import yaml
import pathlib

_config = None

def get_config():
    global _config
    if _config is None:
        base = pathlib.Path(__file__).resolve().parent
        with open(base / "config.yaml", "r") as f:
            _config = yaml.safe_load(f)
    return _config
