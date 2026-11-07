"""Public-facing app metadata must be reusable by any contributor."""
from pathlib import Path
import plistlib
import unittest

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / 'src/cuktech-ble-ha-main/ble_server/web'


class PublicIdentityTests(unittest.TestCase):
    def test_app_has_a_neutral_public_name(self):
        info = plistlib.loads((ROOT / 'macos/Info.plist').read_bytes())
        self.assertEqual(info['CFBundleDisplayName'], '酷态站')
        self.assertEqual(info['CFBundleIdentifier'], 'org.cuktech.web.launcher')

    def test_pages_and_locales_use_the_public_name(self):
        for path in [WEB / 'index.html', WEB / 'phone.html', WEB / 'config.html',
                     WEB / 'static/locales/zh-CN.js']:
            with self.subTest(file=path.name):
                self.assertIn('酷态站', path.read_text())
        self.assertIn('CUKTECH Station', (WEB / 'static/locales/en.js').read_text())

    def test_launcher_and_instructions_agree_on_the_app_file(self):
        for path in [ROOT / 'macos/build_app.sh', ROOT / 'macos/login.py',
                     ROOT / 'README.md', ROOT / '快速使用说明.md']:
            with self.subTest(file=path.name):
                self.assertIn('CUKTECH Station.app', path.read_text())

    def test_local_secrets_and_distribution_outputs_are_ignored(self):
        rules = set((ROOT / '.gitignore').read_text().splitlines())
        self.assertTrue({'.env', '.env.*', 'dist/', '*.log.*', '*.tmp'} <= rules)

    def test_optional_linux_service_uses_a_public_install_location(self):
        service = ROOT / 'src/cuktech-ble-ha-main/ble_server/systemd/cuktech-ble-server.service'
        text = service.read_text()
        self.assertIn('User=cuktech', text)
        self.assertIn('WorkingDirectory=/opt/cuktech/ble_server', text)
        self.assertNotIn('/home/', text)
        rotation = service.with_suffix('.logrotate').read_text()
        self.assertIn('su cuktech cuktech', rotation)


if __name__ == '__main__':
    unittest.main()
