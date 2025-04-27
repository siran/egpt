#!/usr/bin/env python3
import os

SOURCE_DIR = "."  # or set to your project root if needed
EXT = ".py"

def list_python_files(base_dir):
    py_files = [
        'state/e_identity.md',
        'ethics.md',
        'status-250426.md',
        'requirements.txt',
        'inspect_source.py',
        'e.py',
        'create_user.sh',
        'telegram_runner.py',
        'main.py',
        'cdp_instance.py',
        'chromebridge_cdp.py',
        'executor.py',
        'input_core.py',
        'init_script.py',
        'load_config.py',
        'memory.py',
        'output_core.py',
        'patcher.py',
        'router.py',
        'sendtobrain.py',
        'telegram_bridge.py',
        'start-env.sh',
    ]

    return py_files

def print_file_with_header(filepath):
    print(f"\n\n{'=' * 80}")
    print(f"📄 {filepath}")
    print(f"{'=' * 80}")
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            print(f.read())
    except Exception as e:
        print(f"⚠️ Failed to read {filepath}: {e}")

def main():
    py_files = list_python_files(SOURCE_DIR)
    for path in py_files:
        print_file_with_header(path)


if __name__ == "__main__":
    main()
