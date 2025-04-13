if [ "${1}" = "chrome" ]; then
    google-chrome-stable --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir="~/.config/google-chrome"
elif [ "${1}" = "e" ]; then
    python3 e.py
else
    echo "subcommand not understood"
    exit 1
fi
