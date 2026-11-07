"""Ensure publish checks catch files even when their contents are compressed."""
import gzip
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('publication', Path(__file__).resolve().parents[1] / 'scripts/check_publication.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_private_artifacts_and_compressed_credentials():
    assert module.check('runtime/config.yaml', b'')
    assert module.check('capture.pcap', b'')
    assert module.check('state.db-wal', b'')
    credential = b'gh' + b'p_' + b'X' * 36
    assert 'GitHub credential' in module.check('bundle.js.gz', gzip.compress(credential))


def test_blank_examples_are_publishable():
    assert module.check('macos/config.example.yaml', b'token: ""\nble_key: ""\n') == []
