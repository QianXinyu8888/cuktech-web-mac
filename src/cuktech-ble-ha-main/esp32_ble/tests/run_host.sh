#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${IDF_PATH:=$HOME/esp/esp-idf-cuktech}"
CJSON="$IDF_PATH/components/json/cJSON"
binary="$(mktemp /tmp/cuktech-cloud-test.XXXXXX)"
trap 'rm -f "$binary"' EXIT
cc -Wall -Wextra -Werror -Wno-deprecated-declarations -fsanitize=undefined -I main -I "$CJSON" \
    tests/test_cloud.c main/cloud_protocol.c main/cloud_history.c main/automation_engine.c main/miot_protocol.c -lm "$CJSON/cJSON.c" -o "$binary"
"$binary"

cc -Wall -Wextra -Werror -fsanitize=undefined -I main tests/test_automation.c main/automation_engine.c -lm -o "$binary"
"$binary"
cc -Wall -Wextra -Werror -fsanitize=undefined -I tests/stubs -I main tests/test_automation_store.c main/automation_store.c main/automation_engine.c -lm -o "$binary"
"$binary"
cc -Wall -Wextra -Werror -fsanitize=undefined -I main tests/test_http_guard.c main/http_guard.c -o "$binary"
"$binary"
