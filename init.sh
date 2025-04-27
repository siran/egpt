set -e

if [ "$EUID" -ne 0 ]; then
  echo "❌ Please run as root"
  exit 1
fi

python3 init_script.py

git status

git diff
