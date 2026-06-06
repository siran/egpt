#!/usr/bin/env bash
# lockdown.sh — restrict ~/.egpt to owner-only on macOS / Linux.
#
# Audit on Windows showed sensitive files (wa-auth/ session keys, bus.key,
# cdp-token, conversations transcripts) were readable by BUILTIN\Administrators
# via inherited ACL. The Unix equivalent risk is: world- or group-readable
# files in $HOME — usually $HOME isn't world-readable on modern distros, but
# explicit ownership permissions are still worth setting so a user-misconfig
# doesn't accidentally leak the bridge state.
#
# What this does:
#   * chown $USER:$USER on the whole tree (defensive — should already be
#     correct, but matches the takeown step in the Windows lockdown).
#   * chmod 700 every directory under ~/.egpt
#   * chmod 600 every file
#
# After:
#   ~/.egpt/                drwx------  $USER
#   ~/.egpt/wa-auth/        drwx------  $USER
#   ~/.egpt/bus.key         -rw-------  $USER
#   ...etc.
#
# Idempotent — safe to re-run.

set -euo pipefail

root="$HOME/.egpt"
if [[ ! -d "$root" ]]; then
  echo "$root does not exist; nothing to lock down."
  exit 0
fi

echo "Lockdown target: $root"
echo "Operator:        $USER"
echo

echo "chown -R $USER:$USER ..."
# Use $USER's own group if it exists; otherwise fall back to a numeric gid.
group="$(id -gn "$USER" 2>/dev/null || id -g "$USER")"
chown -R "$USER:$group" "$root"

echo "chmod 700 on all directories..."
find "$root" -type d -exec chmod 700 {} +

echo "chmod 600 on all files..."
find "$root" -type f -exec chmod 600 {} +

echo
echo "Verifying — sensitive paths:"
for p in "$root" "$root/wa-auth" "$root/bus.key" "$root/cdp-token" "$root/conversations" "$root/state" "$root/logs"; do
  if [[ -e "$p" ]]; then
    perms="$(ls -ld "$p" | awk '{print $1, $3}')"
    echo "  $p  →  $perms"
  fi
done

echo
echo "Done. Other users on this machine can no longer read ~/.egpt."
