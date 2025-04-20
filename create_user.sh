
bash
Copy
Edit
#!/bin/bash
# Usage: sudo ./create_user.sh <username> <chatgpt_conversation_id> [<name_identifier>]

set -e

if [ "$EUID" -ne 0 ]; then
  echo "❌ Please run as root"
  exit 1
fi

USERNAME="$1"
CONVID="$2"
NAMEID="$3"

if [ -z "$USERNAME" ] || [ -z "$CONVID" ]; then
  echo "Usage: $0 <username> <chatgpt_conversation_id> [<name_identifier>]"
  exit 1
fi

# Determine home directory (may include nameid suffix)
if [ -n "$NAMEID" ]; then
  HOME_DIR="/home/${USERNAME}_${NAMEID}"
else
  HOME_DIR="/home/${USERNAME}"
fi

# Create system user (does not affect home dir suffix)
if id "$USERNAME" &>/dev/null; then
  echo "✅ User $USERNAME already exists"
else
  echo "➕ Creating user: $USERNAME"
  adduser --disabled-password --gecos "" "$USERNAME"
fi

# Create home dir and conversation ID mapping
mkdir -p "$HOME_DIR"
CONVFILE="$HOME_DIR/conversationids.txt"
echo "$USERNAME:$CONVID" > "$CONVFILE"
chown "$USERNAME:$USERNAME" "$CONVFILE"

echo "✅ User $USERNAME initialized in: $HOME_DIR"
