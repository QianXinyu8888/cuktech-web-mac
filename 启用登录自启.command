#!/bin/bash
BASE="$(cd "$(dirname "$0")" && pwd)"
if [ ! -x "$BASE/.venv/bin/python" ]; then
  echo "Please run the environment installer first."
  exit 1
fi
"$BASE/.venv/bin/python" "$BASE/macos/login.py" install
RC=$?
printf "\nPress Return to close this window..."
read -r _
exit "$RC"
