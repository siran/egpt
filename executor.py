# executor.py — Run approved shell commands in controlled env

import subprocess
import re
import datetime
import os

LOG_DIR = "logs"

def log(text, filename=None):
    os.makedirs("logs", exist_ok=True)
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    fname = filename or f"{LOG_DIR}/{timestamp}.log"
    with open(fname, "a", encoding="utf-8", errors="replace") as f:
        f.write(text.strip() + "\n")
        f.flush()
        os.fsync(f.fileno())

def say(text, prefix=""):
    message = f"{prefix}: {text}"
    print(message, flush=True)
    log(message)

def extract_commands(text):
    """
    Extracts all shell commands from GPT output.

    Supports:
    - ```bash``` blocks (multi-line)
    - ```generic``` blocks
    - inline `commands`
    - DO/run/exec patterns
    """
    commands = []

    # Match all ```bash\n...\n``` blocks
    bash_blocks = re.findall(r"```bash\n(.*?)```", text, re.DOTALL)
    for block in bash_blocks:
        lines = block.strip().splitlines()
        commands.extend([line.strip() for line in lines if line.strip()])

    # Match generic triple-backtick blocks (non-bash)
    other_blocks = re.findall(r"```(?!bash)(.*?)```", text, re.DOTALL)
    for block in other_blocks:
        lines = block.strip().splitlines()
        commands.extend([line.strip() for line in lines if line.strip()])

    # Match inline `code` blocks
    inline = re.findall(r"`([^`]+)`", text)
    commands.extend(inline)

    # Match "run/exec/do <command>"
    commands += re.findall(r"\b(?:do|run|exec(?:ute)?|try)\s+([a-zA-Z0-9_\-\.\/ ]+)", text, re.IGNORECASE)

    return [cmd.strip() for cmd in commands if cmd.strip()]


def execute_command(command):
    say(f"\n🔧 Executing: {command}\n")
    try:
        result = subprocess.run(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd="sandbox",
            text=True,
            timeout=60,
        )
        output = result.stdout + result.stderr
        say(output)
        log(f"\n🔧 Output from: {command}\n{output.strip()}")
        return output
    except Exception as e:
        error_msg = f"❌ Error: {str(e)}"
        say(error_msg)
        return error_msg
