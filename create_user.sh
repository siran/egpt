#!/bin/bash
# Usage: sudo ./create_user.sh <username> <chatgpt_conversation_id>

set -e

if [ "$EUID" -ne 0 ]; then
  echo "❌ Please run as root"
  exit 1
fi

USERNAME="$1"
CONVID="$2"

if [ -z "$USERNAME" ] || [ -z "$CONVID" ]; then
  echo "Usage: $0 <username> <chatgpt_conversation_id>"
  exit 1
fi

# Check if user exists
if id "$USERNAME" &>/dev/null; then
  echo "✅ User $USERNAME already exists"
else
  echo "➕ Creating user: $USERNAME"
  adduser --disabled-password --gecos "" "$USERNAME"
fi

# Create user's conversation ID record
CONVFILE="/home/$USERNAME/conversationids.txt"
mkdir -p "/home/$USERNAME"
echo "$USERNAME:$CONVID" > "$CONVFILE"
chown "$USERNAME:$USERNAME" "$CONVFILE"

echo "✅ User $USERNAME setup complete."
