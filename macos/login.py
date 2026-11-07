"""Login startup works with or without CUKTECH Station.app in source installs."""
import os
from pathlib import Path
import plistlib
import subprocess
import sys

LABEL = "org.cuktech.web"
BASE = Path(__file__).resolve().parents[1]
PLIST = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
DOMAIN = f"gui/{os.getuid()}"


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "install"
    if action not in {"install", "remove"}:
        raise SystemExit("用法：login.py install|remove")
    if PLIST.exists():
        subprocess.run(["launchctl", "bootout", DOMAIN, str(PLIST)], capture_output=True)
    if action == "remove":
        PLIST.unlink(missing_ok=True)
        print("已取消登录自启，当前运行的服务不受影响。")
        return
    (BASE / "runtime").mkdir(mode=0o700, exist_ok=True)
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    PLIST.write_bytes(plistlib.dumps({
        "Label": LABEL,
        "ProgramArguments": [str(BASE / ".venv/bin/python"), str(BASE / "macos/launcher.py"), "run", "--no-open"],
        "RunAtLoad": True,
        "StandardOutPath": str(BASE / "runtime/login.log"),
        "StandardErrorPath": str(BASE / "runtime/login.log"),
        "LimitLoadToSessionType": "Aqua",
    }))
    subprocess.run(["launchctl", "bootstrap", DOMAIN, str(PLIST)], check=True)
    print("已启用登录自启。登录 Mac 后会在后台启动助手；请保持整个文件夹的位置不变。")


if __name__ == "__main__":
    main()
