"""Local-only provisioning bridge. Never print or persist imported credentials."""
from __future__ import annotations

import argparse
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import secrets
import webbrowser

import yaml


class SetupError(Exception):
    pass


class SetupService:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.csrf = secrets.token_urlsafe(32)

    def _read(self, name, yaml_file=False):
        try:
            text = (self.root / 'runtime' / name).read_text(encoding='utf-8')
            result = yaml.safe_load(text) if yaml_file else json.loads(text)
            if not isinstance(result, dict):
                raise ValueError()
            return result
        except (OSError, ValueError, yaml.YAMLError):
            raise SetupError('本项目本地配置缺失或格式错误，请先完成米家导入和云端配置。') from None

    def _device(self):
        config = self._read('config.yaml', True)
        ble = config.get('ble', {})
        if not isinstance(ble, dict):
            raise SetupError('本项目主设备配置格式错误。')
        mac, token, key = (ble.get(k, '') for k in ('mac', 'token', 'ble_key'))
        if not (isinstance(mac, str) and re.fullmatch(r'(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}', mac)
                and isinstance(token, str) and re.fullmatch(r'[0-9a-fA-F]{24}', token)
                and isinstance(key, str) and re.fullmatch(r'[0-9a-fA-F]{32}', key)):
            raise SetupError('尚无完整主设备凭据。请先在本项目 Mac 配置页扫码导入并保存。')
        return config, {'device_mac': mac, 'device_token': token, 'device_ble_key': key}

    def state(self):
        try:
            config = self._read('config.yaml', True)
            port = config.get('server', {}).get('port', 18299)
            if type(port) is not int or not 1 <= port <= 65535:
                raise SetupError('本地 Mac 服务端口配置错误。')
            try:
                self._device()
                ready, message = True, '主设备已导入，可连接 ESP 配网热点。'
            except SetupError as exc:
                ready, message = False, str(exc)
            return {'ok': True, 'device_ready': ready, 'message': message,
                    'import_url': f'http://127.0.0.1:{port}/config.html'}
        except SetupError as exc:
            return {'ok': False, 'device_ready': False, 'message': str(exc)}

    def configure(self, body):
        if not isinstance(body, dict) or not {'ssid', 'password'} <= set(body) or set(body) - {'ssid', 'password', 'cloud_token'}:
            raise SetupError('请仅填写 Wi-Fi SSID 和密码。')
        ssid, password = body['ssid'], body['password']
        if not isinstance(ssid, str) or not 1 <= len(ssid.encode('utf-8')) <= 32 or '\x00' in ssid:
            raise SetupError('SSID 必须为 1–32 字节。')
        if not isinstance(password, str) or not 8 <= len(password.encode('utf-8')) <= 63 or '\x00' in password or '****' in password:
            raise SetupError('Wi-Fi 密码必须为 8–63 字节，且不能含设备掩码标记。')
        _, payload = self._device()
        deployment = self._read('deployment.json')
        hostname = deployment.get('hostname')
        token = body.get('cloud_token') or self._read('cloud-secrets.json').get('device_token')
        if not isinstance(hostname, str) or not re.fullmatch(r'(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?', hostname) or '..' in hostname:
            raise SetupError('本项目云端域名配置无效。')
        if not isinstance(token, str) or not re.fullmatch(r'[a-zA-Z0-9._~+/=-]{1,256}', token):
            raise SetupError('本项目设备云端 Token 配置无效。')
        if len(f'wss://{hostname}/api/device'.encode('utf-8')) >= 256:
            raise SetupError('云端地址超过设备支持长度。')
        payload.update(wifi_ssid=ssid, wifi_pass=password, cloud_enabled=True,
                       cloud_url=f'wss://{hostname}/api/device', cloud_token=token)
        self._post_esp(payload)
        return {'ok': True, 'message': 'ESP32 已确认保存配置，正在重启；连接云端与 BLE 尚待验证。'}

    def _post_esp(self, payload):
        connection = None
        try:
            # Direct HTTP connection bypasses all proxies and never follows redirects.
            connection = http.client.HTTPConnection('192.168.4.1', 80, timeout=8)
            connection.request('POST', '/api/config', body=json.dumps(payload).encode('utf-8'),
                               headers={'Content-Type': 'application/json', 'Connection': 'close'})
            response = connection.getresponse()
            raw = response.read(8193)
            if response.status != 200 or len(raw) > 8192 or json.loads(raw).get('ok') is not True:
                raise SetupError('ESP32 未确认保存，请检查配网热点后重试。')
        except SetupError:
            raise
        except (OSError, http.client.HTTPException, ValueError, AttributeError):
            raise SetupError('ESP32 不可达、响应无效或超时。请手动连接 ESP 配网热点后重试。') from None
        finally:
            if connection is not None:
                connection.close()


PAGE = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>酷态站 ESP32 首次配网</title>
<style>body{font:16px system-ui;max-width:660px;margin:48px auto;padding:0 24px;line-height:1.7}input,button,a{font:inherit}input{display:block;width:95%;padding:10px;margin:8px 0 20px}button{padding:10px 18px}#result{white-space:pre-wrap}</style>
<h1>ESP32 首次配网</h1><p>设备凭据只在此 Mac 与 ESP32 之间传送。本助手仅监听本机。</p>
<ol><li>先启动本项目 Mac 版，在<a id="import" target="_blank" rel="noopener">配置页扫码导入米家主设备并保存</a>。<button id="refresh">重新检查导入</button></li><li>手动将 Mac Wi-Fi 连接到 ESP32 配网热点，保留此页面。</li><li>填写 ESP32 要连接的 <strong>2.4GHz Wi-Fi</strong>，点击发送。保存后 ESP32 会重启。</li></ol>
<form id="setup"><label>Wi-Fi SSID<input id="ssid" maxlength="32" required autocomplete="off"></label><label>Wi-Fi 密码<input id="password" type="password" required autocomplete="off" minlength="8" maxlength="63"></label><label>新网关一次性云端凭据（默认设备可留空）<input id="cloud-token" type="password" autocomplete="off" maxlength="256"></label><button id="send">发送到 ESP32</button></form><p id="result" role="status"></p>
<script>const csrf=__CSRF__;const result=document.querySelector('#result'),send=document.querySelector('#send');async function state(){try{const s=await(await fetch('/api/state',{cache:'no-store'})).json();result.textContent=s.message;send.disabled=!s.device_ready;const a=document.querySelector('#import');if(s.import_url)a.href=s.import_url;}catch{result.textContent='本地助手已停止，请重新运行。';send.disabled=true;}}document.querySelector('#refresh').onclick=state;document.querySelector('#setup').onsubmit=async e=>{e.preventDefault();send.disabled=true;result.textContent='等待 ESP32 确认保存…';try{const r=await fetch('/api/configure',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({ssid:document.querySelector('#ssid').value,password:document.querySelector('#password').value,cloud_token:document.querySelector('#cloud-token').value})});const s=await r.json();result.textContent=s.message||s.error;document.querySelector('#password').value='';document.querySelector('#cloud-token').value='';}catch{result.textContent='发送失败，尚未确认保存。检查配网热点后重试。';}finally{send.disabled=false;}};state();</script></html>'''


def make_server(service, port=18300):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_):
            pass

        def respond(self, status, body, content_type='application/json; charset=utf-8'):
            data = body.encode('utf-8') if isinstance(body, str) else json.dumps(body, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            for key, value in {'Content-Type': content_type, 'Content-Length': str(len(data)),
                               'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
                               'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY'}.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(data)

        def allowed(self, mutation=False):
            origin = f'http://127.0.0.1:{self.server.server_port}'
            if self.headers.get('Host') != origin[7:]:
                self.respond(403, {'ok': False, 'error': 'Host rejected'})
                return False
            if mutation and (self.headers.get('Origin') != origin or not hmac.compare_digest(self.headers.get('X-CSRF-Token', ''), service.csrf)):
                self.respond(403, {'ok': False, 'error': 'Origin or CSRF rejected'})
                return False
            return True

        def do_GET(self):
            if not self.allowed():
                return
            if self.path == '/':
                return self.respond(200, PAGE.replace('__CSRF__', json.dumps(service.csrf)), 'text/html; charset=utf-8')
            if self.path == '/api/state':
                return self.respond(200, service.state())
            self.respond(404, {'ok': False, 'error': 'Not found'})

        def do_POST(self):
            if not self.allowed(True):
                return
            if self.path != '/api/configure':
                return self.respond(404, {'ok': False, 'error': 'Not found'})
            try:
                length = int(self.headers.get('Content-Length', '-1'))
                if not 0 < length <= 2048 or self.headers.get('Transfer-Encoding') or self.headers.get_content_type() != 'application/json':
                    return self.respond(400, {'ok': False, 'error': 'Invalid body'})
                body = json.loads(self.rfile.read(length))
                self.respond(200, service.configure(body))
            except (ValueError, UnicodeError):
                self.respond(400, {'ok': False, 'error': 'Invalid JSON'})
            except SetupError as exc:
                self.respond(400, {'ok': False, 'error': str(exc)})

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser(description='酷态站 ESP32 本机首次配网助手')
    parser.add_argument('--port', type=int, default=18300)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('端口必须为 1–65535')
    service = SetupService(Path(__file__).resolve().parents[1])
    try:
        server = make_server(service, args.port)
    except OSError:
        print('本机助手端口不可用，请换一个 --port。')
        return 1
    url = f'http://127.0.0.1:{server.server_port}/'
    print('ESP32 配网助手：' + url + '\n完成后按 Control+C 关闭。')
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
