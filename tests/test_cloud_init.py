import json
import stat
import tempfile
import unittest
from pathlib import Path

from macos.cloud_init import InitError, initialize


class CloudInitTests(unittest.TestCase):
    def test_creates_private_independent_credentials_and_preserves_them(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            initialize(root, 'charge.example.com')
            runtime = root / 'runtime'
            deployment = json.loads((runtime / 'deployment.json').read_text())
            credentials = json.loads((runtime / 'cloud-secrets.json').read_text())
            bulk = json.loads((runtime / 'cloudflare-secrets.json').read_text())
            self.assertEqual(deployment['hostname'], 'charge.example.com')
            self.assertEqual(bulk['DEVICE_TOKEN'], credentials['device_token'])
            self.assertEqual(bulk['VIEWER_PASSWORD'], credentials['viewer_password'])
            self.assertEqual(bulk['SESSION_SECRET'], credentials['session_secret'])
            self.assertEqual(len(set(credentials.values())), 3)
            for path in runtime.iterdir():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            before = {p.name: p.read_bytes() for p in runtime.iterdir()}
            with self.assertRaises(InitError):
                initialize(root, 'another.example.com')
            self.assertEqual(before, {p.name: p.read_bytes() for p in runtime.iterdir()})

    def test_rejects_invalid_hostname_without_writing(self):
        for hostname in ('', 'https://example.com', 'example.com/path', 'localhost', '-x.example', 'x..example'):
            with self.subTest(hostname=hostname), tempfile.TemporaryDirectory() as folder:
                with self.assertRaises(InitError):
                    initialize(Path(folder), hostname)
                self.assertFalse((Path(folder) / 'runtime').exists())
