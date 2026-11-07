"""Exercise the Mac service lifecycle without accessing Bluetooth or real accounts."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class MacLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cuktech mac test ")
        self.base = Path(self.temp.name)
        (self.base / "macos").mkdir()
        (self.base / "macos/config.example.yaml").write_text(
            'ble:\n  mac: ""\n  token: ""\n  ble_key: ""\n'
            'mqtt:\n  enabled: false\nbemfa:\n  enabled: false\n'
            'server:\n  host: 127.0.0.1\n  port: 8199\n', encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def launcher(self):
        spec = importlib.util.find_spec("macos.launcher")
        self.assertIsNotNone(spec, "The macOS launcher has not been implemented")
        from macos.launcher import Launcher
        return Launcher(self.base)

    def test_first_run_uses_blank_private_configuration(self):
        launcher = self.launcher()
        launcher.prepare()
        import yaml
        config = yaml.safe_load(launcher.config_path.read_text())
        self.assertEqual(config["ble"]["token"], "")
        self.assertFalse(config["mqtt"]["enabled"])
        self.assertFalse(config["bemfa"]["enabled"])
        self.assertEqual(launcher.config_path.stat().st_mode & 0o777, 0o600)

    def test_prepare_preserves_user_settings(self):
        launcher = self.launcher()
        launcher.prepare()
        launcher.config_path.write_text("server:\n  port: 18234\n", encoding="utf-8")
        launcher.prepare()
        self.assertEqual(launcher.url, "http://127.0.0.1:18234/")

    def test_stop_refuses_an_unrelated_process(self):
        launcher = self.launcher()
        launcher.prepare()
        launcher.pid_path.write_text(str(os.getpid()), encoding="ascii")
        self.assertFalse(launcher.running())
        self.assertEqual(launcher.stop(), 0)
        os.kill(os.getpid(), 0)

    def test_port_conflict_does_not_start_or_stop_other_service(self):
        launcher = self.launcher()
        launcher.prepare()
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            sock.listen()
            port = sock.getsockname()[1]
            launcher.config_path.write_text(f"server:\n  port: {port}\n", encoding="utf-8")
            self.assertEqual(launcher.run(open_browser=False), 1)
            self.assertEqual(sock.getsockname()[1], port)

    def test_start_duplicate_restart_and_stop(self):
        launcher = self.launcher()
        launcher.prepare()
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        launcher.config_path.write_text(f"server:\n  port: {port}\n", encoding="utf-8")
        server = self.base / "src/cuktech-ble-ha-main/ble_server/ha_server.py"
        server.parent.mkdir(parents=True)
        # First child requests a restart; second stays alive until stopped.
        server.write_text(
            "import os, pathlib, time, json\n"
            "p=pathlib.Path(os.environ['CUKTECH_CONFIG_PATH']).parent/'restarted'\n"
            "if not p.exists():\n p.touch()\n raise SystemExit(3)\n"
            "p.with_name('child.pid').write_text(str(os.getpid()))\n"
            "p.with_name('env.json').write_text(json.dumps({k:v for k,v in os.environ.items() if k.startswith(('CUKTECH_', 'MQTT_', 'BEMFA_'))}))\n"
            "while True: time.sleep(0.1)\n", encoding="utf-8")
        command = [sys.executable, "-c",
                   "from macos.launcher import Launcher; from pathlib import Path; "
                   "import sys; sys.exit(Launcher(Path(sys.argv[1])).run(False))", str(self.base)]
        polluted_env = dict(os.environ, CUKTECH_DEVICE_TOKEN="old-test-credential",
                            MQTT_ENABLED="1", BEMFA_UID="old-test-key", CUKTECH_SERVER_PORT="9")
        with subprocess.Popen(command, cwd=ROOT, env=polluted_env,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as proc:
            try:
                deadline = time.monotonic() + 12
                child_pid_path = launcher.runtime / "child.pid"
                while not child_pid_path.exists() and time.monotonic() < deadline:
                    time.sleep(0.1)
                self.assertTrue(child_pid_path.exists(), "Child did not restart")
                self.assertTrue(launcher.running())
                child_env = json.loads((launcher.runtime / "env.json").read_text())
                for key in ("CUKTECH_DEVICE_TOKEN", "MQTT_ENABLED", "BEMFA_UID", "CUKTECH_SERVER_PORT"):
                    self.assertTrue(key not in child_env, f"Inherited override was not removed: {key}")
                self.assertEqual(child_env["CUKTECH_CONFIG_PATH"], str(launcher.config_path))
                self.assertEqual(launcher.run(open_browser=False), 0)
                child_pid = int(child_pid_path.read_text())
                self.assertEqual(launcher.stop(), 0)
                proc.wait(timeout=10)
                self.assertFalse(launcher.running())
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
            finally:
                if proc.poll() is None:
                    proc.send_signal(signal.SIGTERM)
                    proc.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
