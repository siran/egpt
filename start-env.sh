if [ "${1}" = "chrome" ]; then
    # explorer.exe config.xlaunch
    google-chrome-stable \
        --remote-debugging-port=9222 \
        --remote-allow-origins=* \
        --user-data-dir="~/.config/google-chrome" \
        --disable-background-timer-throttling \
        --disable-renderer-backgrounding \
        --disable-backgrounding-occluded-windows
elif [ "${1}" = "tg" ]; then
    python3 telegram_runner.py
elif [ "${1}" = "e" ]; then
    python3 e.py
else
    echo "subcommand not understood"
    exit 1
fi
