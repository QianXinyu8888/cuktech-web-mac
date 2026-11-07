#!/bin/bash
BASE="$(cd "$(dirname "$0")" && pwd)"
/bin/bash "$BASE/macos/manage.sh" run
RC=$?
printf "\nPress Return to close this window..."
read -r _
exit "$RC"
