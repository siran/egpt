# patcher.py — conversational patch proposal and approval system

import os
import difflib
from executor import say

PENDING_PATCHES = {}

def propose_patch(filename, new_code):
    original = read_file(filename)
    PENDING_PATCHES[filename] = (original, new_code)
    say(f"📄 Proposed patch to: {filename}")
    show_patch(filename)

def update_patch(filename, new_code):
    if filename not in PENDING_PATCHES:
        say("⚠️ No existing patch to update.")
        return
    original, _ = PENDING_PATCHES[filename]
    PENDING_PATCHES[filename] = (original, new_code)
    say(f"📝 Patch to {filename} updated.")
    show_patch(filename)

def show_patch(filename):
    if filename not in PENDING_PATCHES:
        say("⚠️ No pending patch.")
        return
    original, new_code = PENDING_PATCHES[filename]
    diff = generate_diff(original, new_code)
    say(f"🔍 Patch diff for {filename}:{diff}")

def apply_patch_if_approved(filename):
    if filename not in PENDING_PATCHES:
        say("⚠️ No patch to apply.")
        return
    _, new_code = PENDING_PATCHES.pop(filename)
    tmp_path = f"{filename}.egpt.new"
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(new_code.strip() + "\n")
    say(f"💾 Patch saved to: {tmp_path}")
    confirm = input("Apply this patch? [y/N] ").strip().lower()
    if confirm == "y":
        os.replace(tmp_path, filename)
        say(f"✅ Patched {filename}")
    else:
        say("❌ Patch not applied.")

def read_file(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except:
        return ""

def generate_diff(original, new):
    old_lines = original.splitlines()
    new_lines = new.splitlines()
    diff = difflib.unified_diff(old_lines, new_lines, fromfile='original', tofile='proposed', lineterm='')
    return "\n".join(diff)
