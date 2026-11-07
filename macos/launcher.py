"""macOS foreground supervisor. Own only this folder's process; never kill by port."""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import threading
import time
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener
import webbrowser

import yaml


class Launcher:
    def __init__(self, base: Path):
        self.base = base.resolve()
        self.runtime = self.base / "runtime"
        self.config_path = self.runtime / "config.yaml"
        self.pid_path = self.runtime / "server.pid"
        self.lock_path = self.runtime / "server.lock"
        self.server = self.base / "src/cuktech-ble-ha-main/ble_server/ha_server.py"

    def prepare(self):
        self.runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not self.config_path.exists():
            # Exclusive creation prevents an installer from overwriting a user's settings.
            try:
                with self.config_path.open("x", encoding="utf-8") as out:
                    out.write((self.base / "macos/config.example.yaml").read_text(encoding="utf-8"))
            except FileExistsError:
                pass
        self.config_path.chmod(0o600)

    @property
    def port(self):
        config = yaml.safe_load(self.config_path.read_text(encoding="utf-8")) or {}
        port = int(config.get("server", {}).get("port", 8199))
        if not 1 <= port <= 65535:
            raise ValueError("服务端口必须在 1–65535 之间")
        return port

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}/"

    def running(self):
        if not self.pid_path.exists() or not self.lock_path.exists():
            return False
        # A PID file alone is never proof: PIDs are reused after a crash or reboot.
        with self.lock_path.open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                pass
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)
                return False
        try:
            pid = int(self.pid_path.read_text(encoding="ascii"))
            os.kill(pid, 0)
            return pid > 1
        except (ValueError, OSError):
            return False

    def stop(self):
        if not self.running():
            print("服务当前没有运行。")
            return 0
        pid = int(self.pid_path.read_text(encoding="ascii"))
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            return 0
        deadline = time.monotonic() + 15
        while self.running() and time.monotonic() < deadline:
            time.sleep(0.1)
        if self.running():
            print("停止超时，请在启动终端按 Control+C，并查看 runtime/service.log。")
            return 1
        print("服务已停止，蓝牙连接已释放。")
        return 0

    def _open_when_ready(self, stopping):
        opener = build_opener(ProxyHandler({}))
        for _ in range(120):
            if stopping.is_set():
                return
            try:
                with opener.open(self.url + "api/health", timeout=1) as response:
                    ready = json.load(response).get("ok") is True
                if ready:
                    report = os.environ.get("CUKTECH_STARTUP_REPORT")
                    if report: Path(report).write_text("ready", encoding="utf-8")
                    config = yaml.safe_load(self.config_path.read_text(encoding="utf-8")) or {}
                    first_run = not config.get("ble", {}).get("token")
                    webbrowser.open(self.url + ("config.html" if first_run else ""))
                    return
            except (OSError, URLError, ValueError):
                pass
            stopping.wait(0.5)
        print("网页尚未就绪，请查看 runtime/service.log。", flush=True)

    def run(self, open_browser=True):
        self.prepare()
        with self.lock_path.open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print("服务已在运行。")
                report = os.environ.get("CUKTECH_STARTUP_REPORT")
                if report: Path(report).write_text("ready", encoding="utf-8")
                if open_browser:
                    webbrowser.open(self.url)
                return 0
            # Do not start a competing instance or treat another app as this service.
            with socket.socket() as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    probe.bind(("127.0.0.1", self.port))
                except OSError:
                    print(f"端口 {self.port} 已被占用。请关闭占用程序，或修改 runtime/config.yaml 中的 server.port。")
                    return 1
            self.pid_path.write_text(str(os.getpid()), encoding="ascii")
            self.pid_path.chmod(0o600)
            # This distribution is configured only through its own YAML.
            # Old shell overrides must not silently select another device or cloud account.
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(("CUKTECH_", "MQTT_", "BEMFA_"))}
            env.update({
                "CUKTECH_CONFIG_PATH": str(self.config_path),
                "CUKTECH_LOG_FILE": str(self.runtime / "server.log"),
                "CUKTECH_HISTORY_DB_PATH": str(self.runtime / "port_history.db"),
                "PYTHONUNBUFFERED": "1",
            })
            stopping = threading.Event()
            child = None

            def shutdown(signum, frame):
                stopping.set()
                if child is not None and child.poll() is None:
                    child.terminate()

            old_handlers = {sig: signal.signal(sig, shutdown)
                            for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
            print(f"酷态站\n控制页：{self.url}\n配置页：{self.url}config.html\n"
                  "请保持本终端运行；停止请按 Control+C 或双击「停止服务.command」。\n"
                  "首次连接蓝牙时，请允许终端/Python 的蓝牙访问。", flush=True)
            if open_browser:
                threading.Thread(target=self._open_when_ready, args=(stopping,), daemon=True).start()
            try:
                with (self.runtime / "service.log").open("ab") as output:
                    while not stopping.is_set():
                        child = subprocess.Popen([sys.executable, str(self.server)],
                                                 cwd=self.server.parent, env=env,
                                                 stdout=output, stderr=subprocess.STDOUT)
                        while child.poll() is None:
                            if stopping.wait(0.2):
                                child.terminate()
                                try:
                                    child.wait(timeout=10)
                                except subprocess.TimeoutExpired:
                                    child.kill()
                                    child.wait()
                                break
                        if child.returncode == 3 and not stopping.is_set():
                            stopping.wait(2)
                            continue
                        if child.returncode and not stopping.is_set():
                            print("服务启动失败，请查看 runtime/service.log。", flush=True)
                            return 1
                        return 0
                return 0
            finally:
                stopping.set()
                if child is not None and child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
                self.pid_path.unlink(missing_ok=True)
                for sig, previous in old_handlers.items():
                    signal.signal(sig, previous)


def main():
    parser = argparse.ArgumentParser(description="酷态站 macOS 服务管理")
    parser.add_argument("action", choices=["run", "stop", "status", "open", "prepare"], nargs="?", default="run")
    parser.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    args = parser.parse_args()
    launcher = Launcher(Path(__file__).resolve().parents[1])
    launcher.prepare()
    if args.action == "run":
        return launcher.run(not args.no_open)
    if args.action == "stop":
        return launcher.stop()
    if args.action == "status":
        print(("运行中" if launcher.running() else "未运行") + " · " + launcher.url)
    elif args.action == "open":
        webbrowser.open(launcher.url)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, yaml.YAMLError) as error:
        print(f"无法运行：{error}", file=sys.stderr)
        raise SystemExit(1)
