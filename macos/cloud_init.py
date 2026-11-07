"""Create per-installation cloud credentials without replacing an existing setup."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets


class InitError(Exception):
    pass


def initialize(root: Path, hostname: str) -> None:
    hostname = hostname.strip().lower()
    labels = hostname.split('.')
    if (len(hostname) > 253 or len(labels) < 2 or
            any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in labels)):
        raise InitError('请输入完整子域名，例如 charge.example.com，不要包含 https:// 或路径。')
    runtime = root / 'runtime'
    names = ('deployment.json', 'cloud-secrets.json', 'cloudflare-secrets.json', '网站登录密码.txt')
    if any((runtime / name).exists() for name in names):
        raise InitError('已有云端配置或密码文件，未作修改；请先备份并自行处理已有配置。')
    credentials = {'device_token': secrets.token_hex(24),
                   'viewer_password': secrets.token_urlsafe(24),
                   'session_secret': secrets.token_hex(32)}
    values = {
        names[0]: json.dumps({'hostname': hostname}, ensure_ascii=False) + '\n',
        names[1]: json.dumps(credentials, ensure_ascii=False) + '\n',
        names[2]: json.dumps({'DEVICE_TOKEN': credentials['device_token'],
                              'VIEWER_PASSWORD': credentials['viewer_password'],
                              'SESSION_SECRET': credentials['session_secret']}) + '\n',
        names[3]: '网站登录密码（请勿分享）：\n' + credentials['viewer_password'] + '\n',
    }
    runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
    created = []
    try:
        for name, value in values.items():
            path = runtime / name
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            created.append(path)
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                stream.write(value)
    except OSError as exc:
        for path in created:
            path.unlink(missing_ok=True)
        raise InitError('无法安全创建本地配置；已清理本次新建文件。') from exc


def main() -> int:
    parser = argparse.ArgumentParser(description='初始化本机独立的 ESP32 云端配置')
    parser.add_argument('hostname', help='自己的完整子域名，例如 charge.example.com')
    args = parser.parse_args()
    try:
        initialize(Path(__file__).resolve().parents[1], args.hostname)
    except InitError as exc:
        print(exc)
        return 1
    print('已创建本机配置及独立密钥；网站密码保存在 runtime/网站登录密码.txt。')
    print('请勿分享 runtime 文件夹，接下来按 cloud/README.md 部署。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
