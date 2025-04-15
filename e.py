#!/usr/bin/env python3
"""
e.py — Embodied GPT Daemon (CDP Watcher — Restored Reflex Loop)
"""

while True:
    try:
        import importlib
        import main
        importlib.reload(main)
        main.fetch_n_messages = 1
        main.input_loop()
    except BaseException as e:
        import sys
        import traceback
        print(f"Error: {e}", file=sys.stderr)
        traceback.print_exc()
        input('\n\n\nPress Enter to respawn...\n\n')
        print('\n\n\n--- Respawning ---\n\n\n')
