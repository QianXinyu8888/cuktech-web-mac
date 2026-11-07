#!/bin/bash
set -euo pipefail
BASE="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
PY="$BASE/.venv/bin/python"
SERVICE="$BASE/src/cuktech-ble-ha-main/ble_server"
ACTION="${1:-run}"

install_environment() {
    if [ "$(uname -s)" != "Darwin" ]; then
        echo "此安装入口适用于 macOS。"
        return 1
    fi
    if [ ! -x "$PY" ]; then
        if command -v uv >/dev/null 2>&1; then
            uv venv --python 3.11 "$BASE/.venv"
        else
            FOUND=""
            for CANDIDATE in python3.11 python3.12 python3.13 python3.14 python3; do
                if command -v "$CANDIDATE" >/dev/null 2>&1 && "$CANDIDATE" -c 'import sys; assert sys.version_info >= (3, 10)' >/dev/null 2>&1; then
                    FOUND="$(command -v "$CANDIDATE")"
                    break
                fi
            done
            if [ -z "$FOUND" ]; then
                echo "需要 Python 3.10 或更新版本（推荐 3.11）。"
                echo "请从 https://www.python.org/downloads/macos/ 安装，然后重新双击「安装环境.command」。"
                return 1
            fi
            "$FOUND" -m venv "$BASE/.venv"
        fi
    fi
    if command -v uv >/dev/null 2>&1; then
        uv pip install --python "$PY" -e "$SERVICE"
    else
        "$PY" -m pip install --upgrade pip
        "$PY" -m pip install -e "$SERVICE"
    fi
    "$PY" "$BASE/macos/launcher.py" prepare
    echo "安装完成。请双击「启动助手.command」。"
}

if [ "$ACTION" = "install" ]; then
    install_environment
    exit 0
fi
if [ ! -x "$PY" ] || ! "$PY" -c 'import aiohttp, bleak, yaml, Cryptodome' >/dev/null 2>&1; then
    if [ "$ACTION" != "run" ]; then
        echo "请先双击「安装环境.command」。"
        exit 1
    fi
    install_environment
fi
exec "$PY" "$BASE/macos/launcher.py" "$ACTION" "${@:2}"
