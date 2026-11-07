#!/usr/bin/env python3
"""Check tracked + unignored source files without printing sensitive values.

Heuristic guard, not a substitute for reviewing staged changes and images.
Includes tracked ignored files: adding .gitignore alone cannot hide a leak.
"""
from pathlib import Path
import gzip
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DENIED_PARTS = {'runtime', '.venv', 'venv', '__pycache__', '.pytest_cache', 'exports', 'backups'}
DENIED_SUFFIXES = {'.db', '.sqlite', '.sqlite3', '.log', '.pid', '.pcap', '.pcapng', '.btsnoop', '.pem', '.key', '.p12', '.pfx', '.zip'}
PATTERNS = {
    'private key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'GitHub credential': re.compile(rb'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})'),
    'cloud credential': re.compile(rb'(?:AKIA|ASIA)[A-Z0-9]{16}'),
    'personal absolute path': re.compile(rb'(?:/Users/|C:\\Users\\)[A-Za-z0-9_.-]+[/\\]'),
}


def check(path, data):
    """Return labels only, never credential contents."""
    p = Path(path)
    issues = []
    if (set(p.parts) & DENIED_PARTS or any(x.endswith('.app') for x in p.parts)
            or p.suffix in DENIED_SUFFIXES or p.name.startswith('.env') and p.name != '.env.example'
            or p.name in {'config.yaml', 'config.yaml.bak', 'sdkconfig', 'sdkconfig.old'}
            or re.search(r'\.(?:db|sqlite3?)-(?:wal|shm|journal)$', p.name)):
        issues.append('private/runtime artifact')
    if p.suffix == '.gz':
        try:
            data = gzip.decompress(data)
        except (OSError, EOFError):
            issues.append('invalid gzip')
    for label, pattern in PATTERNS.items():
        if pattern.search(data):
            issues.append(label)
    return issues


def main():
    try:
        names = subprocess.check_output(
            ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT)
    except subprocess.CalledProcessError:
        print('Run from a Git checkout; initialize Git before checking publication.', file=sys.stderr)
        return 2
    failures = 0
    paths = sorted(set(n.decode('utf-8') for n in names.split(b'\0') if n))
    for name in paths:
        path = ROOT / name
        labels = []
        # Review both index and working tree: a cleaned working copy must not
        # conceal a credential that is still staged for the next commit.
        staged = subprocess.run(['git', 'show', ':' + name], cwd=ROOT,
                                capture_output=True)
        if staged.returncode == 0:
            labels.extend(check(name, staged.stdout))
        if path.is_symlink():
            labels.append('symlink requires manual review')
        elif path.exists():
            labels.extend(check(name, path.read_bytes()))
        labels = sorted(set(labels))
        if labels:
            failures += 1
            print(f'{name}: {", ".join(labels)}')
    print(f'Publication guard: {len(paths)} files checked, {failures} flagged; no secret values printed.')
    return int(bool(failures))


if __name__ == '__main__':
    raise SystemExit(main())
