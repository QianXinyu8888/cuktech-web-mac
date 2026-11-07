"""Xiaomi Cloud API — lightweight wrapper for token/ble_key extraction.

Based on PiotrMachowski/Xiaomi-cloud-tokens-extractor (MIT License).
Only the password login + device listing + beaconkey methods are retained.
"""
import base64
import hashlib
import json
import logging
import os
import random
import string
import threading
import time
from typing import Optional

import requests
try:
    from Crypto.Cipher import ARC4
except ModuleNotFoundError:
    from Cryptodome.Cipher import ARC4

_LOGGER = logging.getLogger("xiaomi_cloud")

SERVERS = {"cn": "https://api.io.mi.com/app",
           "de": "https://de.api.io.mi.com/app",
           "us": "https://us.api.io.mi.com/app",
           "ru": "https://ru.api.io.mi.com/app",
           "tw": "https://tw.api.io.mi.com/app",
           "sg": "https://sg.api.io.mi.com/app",
           "in": "https://in.api.io.mi.com/app",
           "i2": "https://i2.api.io.mi.com/app"}


def _generate_agent():
    agent = "Android-7.1.1-1.0.0-ONEPLUS A3010-136-" + \
            "".join(random.choices(string.ascii_uppercase + string.digits, k=11))
    return agent + " MIIO/" + "".join(random.choices(string.ascii_uppercase + string.digits, k=6))


def _generate_device_id():
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=16))


def _generate_nonce(millis):
    nonce_bytes = os.urandom(8) + (int(millis / 60000)).to_bytes(4, byteorder="big")
    return base64.b64encode(nonce_bytes).decode()


def _signed_nonce(ssecurity, nonce):
    hash_obj = hashlib.sha256(base64.b64decode(ssecurity) + base64.b64decode(nonce))
    return base64.b64encode(hash_obj.digest()).decode()


def _encrypt_rc4(password, payload):
    """RC4-drop[1024] encrypt, matching original token_extractor."""
    r = ARC4.new(base64.b64decode(password))
    r.encrypt(bytes(1024))
    return base64.b64encode(r.encrypt(payload.encode())).decode()


def _decrypt_rc4(password, payload):
    """RC4-drop[1024] decrypt, matching original token_extractor."""
    r = ARC4.new(base64.b64decode(password))
    r.encrypt(bytes(1024))
    return r.encrypt(base64.b64decode(payload))


def _generate_enc_signature(url, method, signed_nonce, params):
    """Generate encrypted signature, matching original token_extractor."""
    signature_params = [str(method).upper(), url.split("com")[1].replace("/app/", "/")]
    for k, v in params.items():
        signature_params.append(f"{k}={v}")
    signature_params.append(signed_nonce)
    signature_string = "&".join(signature_params)
    return base64.b64encode(hashlib.sha1(signature_string.encode("utf-8")).digest()).decode()


def _generate_enc_params(url, method, signed_nonce, nonce, params, ssecurity):
    """Generate encrypted API params, matching original token_extractor."""
    params["rc4_hash__"] = _generate_enc_signature(url, method, signed_nonce, params)
    for k, v in params.items():
        params[k] = _encrypt_rc4(signed_nonce, v)
    params.update({
        "signature": _generate_enc_signature(url, method, signed_nonce, params),
        "ssecurity": ssecurity,
        "_nonce": nonce,
    })
    return params


class XiaomiCloudLoginError(Exception):
    pass


#: 云 HTTP 超时（连接, 读取）。**必须显式给**：`requests` 默认无限等，而调用方是
#: `run_in_executor` 里的阻塞线程——一旦云端卡住，线程和 `requests.Session` 就永久
#: 挂在那里（executor 没有取消路径），30s 的请求超时只把浏览器救了，服务端照样漏。
#: 批量导入把"一次悬死"放大成 N 次，所以这里是硬性要求而不是优化。
#: 读超时 15s 与 API 请求的 30s 上限留出一半余量，够一次云调用往返。
CLOUD_HTTP_TIMEOUT = (5, 15)


class XiaomiCloudDevice:
    """Represents a device from Xiaomi cloud."""
    def __init__(self, did, mac, token, name, model, extra=""):
        self.did = did
        self.mac = mac
        self.token = token
        self.name = name
        self.model = model
        self.extra = extra


class XiaomiCloudClient:
    """Xiaomi Cloud API client for password login (used by beaconkey endpoint)."""

    def __init__(self, username: str, password: str, server: str = "cn"):
        self._username = username
        self._password = password
        self._server = server
        self._agent = _generate_agent()
        self._device_id = _generate_device_id()
        self._session = requests.Session()
        self._ssecurity: Optional[str] = None
        self._service_token: Optional[str] = None
        self._user_id: Optional[str] = None
        self._notification_url: Optional[str] = None
        self._context: Optional[str] = None

    def login(self) -> bool:
        self._session.cookies.set("sdkVersion", "accountsdk-18.8.15", domain="mi.com")
        self._session.cookies.set("sdkVersion", "accountsdk-18.8.15", domain="xiaomi.com")
        self._session.cookies.set("deviceId", self._device_id, domain="mi.com")
        self._session.cookies.set("deviceId", self._device_id, domain="xiaomi.com")
        if not self._login_step_1():
            raise XiaomiCloudLoginError("用户名无效")
        if not self._login_step_2():
            raise XiaomiCloudLoginError("登录或密码错误")
        if not self._login_step_3():
            raise XiaomiCloudLoginError("无法获取 service token")
        return True

    def get_beaconkey(self, did: str, timeout: Optional[float] = None) -> Optional[str]:
        """取 BLE Key。`timeout` 语义与 `QrCodeXiaomiCloudClient.get_beaconkey` 一致。"""
        url = SERVERS.get(self._server, SERVERS["cn"])
        result = self._api_call(f"{url}/v2/device/blt_get_beaconkey", {
            "data": json.dumps({"did": did, "pdid": 1})
        }, timeout=timeout)
        if result and result.get("code") == 0:
            return result.get("result", {}).get("key")
        return None

    def _api_call(self, url, params, timeout=None):
        headers = {"Accept-Encoding": "identity", "User-Agent": self._agent,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
                    "MIOT-ENCRYPT-ALGORITHM": "ENCRYPT-RC4"}
        cookies = {"userId": str(self._user_id), "serviceToken": str(self._service_token),
                   "locale": "en_GB", "timezone": "GMT+08:00", "channel": "MI_APP_STORE"}
        millis = round(time.time() * 1000)
        nonce = _generate_nonce(millis)
        sn = _signed_nonce(self._ssecurity, nonce)
        fields = _generate_enc_params(url, "POST", sn, nonce, params, self._ssecurity)
        try:
            response = self._session.post(url, headers=headers, cookies=cookies, params=fields,
                                           timeout=timeout or CLOUD_HTTP_TIMEOUT)
            if response.status_code == 200:
                decoded = _decrypt_rc4(_signed_nonce(self._ssecurity, fields["_nonce"]), response.text)
                return json.loads(decoded)
        except Exception:
            pass
        return None

    def _login_step_1(self):
        url = "https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true"
        headers = {"User-Agent": self._agent, "Content-Type": "application/x-www-form-urlencoded"}
        response = self._session.get(url, headers=headers,
                                      cookies={"userId": self._username},
                                      timeout=CLOUD_HTTP_TIMEOUT)
        if response.status_code != 200:
            return False
        json_resp = self._to_json(response.text)
        if "_sign" in json_resp:
            self._sign = json_resp["_sign"]
            return True
        if "ssecurity" in json_resp:
            self._ssecurity = json_resp["ssecurity"]
            self._user_id = json_resp["userId"]
            self._location = json_resp.get("location")
            return True
        return False

    def _login_step_2(self):
        import hashlib as hl
        url = "https://account.xiaomi.com/pass/serviceLoginAuth2"
        headers = {"User-Agent": self._agent, "Content-Type": "application/x-www-form-urlencoded"}
        fields = {"sid": "xiaomiio",
                   "hash": hl.md5(self._password.encode()).hexdigest().upper(),
                   "callback": "https://sts.api.io.mi.com/sts",
                   "qs": "%3Fsid%3Dxiaomiio%26_json%3Dtrue",
                   "user": self._username,
                   "_sign": getattr(self, "_sign", ""),
                   "_json": "true"}
        response = self._session.post(url, headers=headers, params=fields,
                                       allow_redirects=False, timeout=CLOUD_HTTP_TIMEOUT)
        if response.status_code != 200:
            return False
        json_resp = self._to_json(response.text)
        if json_resp.get("captchaUrl"):
            raise XiaomiCloudLoginError("需要验证码，暂不支持")
        if json_resp.get("notificationUrl"):
            self._notification_url = json_resp["notificationUrl"]
            err = XiaomiCloudLoginError("需要二步验证")
            err.need_2fa = True
            raise err
        if "ssecurity" not in json_resp or len(str(json_resp["ssecurity"])) <= 4:
            return False
        self._ssecurity = json_resp["ssecurity"]
        self._user_id = json_resp.get("userId")
        self._location = json_resp.get("location")
        return True

    def _login_step_3(self):
        if not self._location:
            return True
        headers = {"User-Agent": self._agent, "Content-Type": "application/x-www-form-urlencoded"}
        response = self._session.get(self._location, headers=headers, timeout=CLOUD_HTTP_TIMEOUT)
        if response.status_code == 200:
            self._service_token = response.cookies.get("serviceToken")
            return self._service_token is not None
        return False

    @staticmethod
    def _to_json(text):
        try:
            return json.loads(text.replace("&&&START&&&", "").strip())
        except json.JSONDecodeError:
            return {}


class QrCodeXiaomiCloudClient:
    """Xiaomi Cloud API client for QR code login."""

    def __init__(self, server: str = "cn"):
        self._server = server
        self._agent = _generate_agent()
        self._device_id = _generate_device_id()
        self._session = requests.Session()
        self._ssecurity: Optional[str] = None
        self._service_token: Optional[str] = None
        self._user_id: Optional[str] = None
        # 扫码成功后由长轮询线程写入；先在这里初始化，切换账号 / 会话过期时读
        # account_info() 不会撞上 AttributeError。
        self._c_user_id: Optional[str] = None
        self._pass_token: Optional[str] = None
        self._qr_image_url: Optional[str] = None
        self._login_url: Optional[str] = None
        self._long_polling_url: Optional[str] = None
        self._location: Optional[str] = None
        self._timeout: int = 300
        #: 二维码有效期的 monotonic 截止时刻，由 start_qr_login 在拿到二维码时确定，
        #: 后台轮询与前端共用同一个窗口，避免"二维码还没过期、会话先被回收"。
        self._poll_deadline: Optional[float] = None
        self._poll_result = None
        self._poll_error = None
        self._poll_done = False
        # 前端每 3 秒查一次状态，location 是一次性 URL：必须防止两个 executor 线程
        # 同时进入 complete_qr_login 把同一个 URL 消费两次。
        self._complete_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._closed = False

    @staticmethod
    def _mask_account(value: str) -> str:
        """账号标识脱敏：只留末 4 位，邮箱保留域名。

        配置页可能被截图/共享，手机号、邮箱、米家数字 ID 都不该原样显示；
        但「这是哪个账号」必须看得出来，所以保留足以辨认的尾部。
        """
        raw = str(value or "").strip()
        if not raw:
            return ""
        if "@" in raw:
            name, _, domain = raw.partition("@")
            return f"{(name[:1] + '***') if name else '***'}@{domain}"
        if len(raw) <= 4:
            return "*" * len(raw)
        return "*" * (len(raw) - 4) + raw[-4:]

    def account_info(self) -> dict:
        """当前登录账号的可展示信息（不含任何 token / 原始 ID）。

        `label` 为空表示还没扫码成功；`server` 是这次登录选的米家区域。
        切换账号时前端靠它确认「现在挂的是哪个账号」，也靠它判断是否该清理。
        """
        raw = str(self._c_user_id or self._user_id or "").strip()
        return {
            "label": self._mask_account(raw),
            "server": self._server,
        }

    @property
    def is_logged_in(self) -> bool:
        """是否已拿到 serviceToken（用于区分"挂着二维码等扫"的僵尸会话）。"""
        return bool(self._service_token)

    def close(self) -> None:
        """释放底层 HTTP 会话：切换账号、会话过期时都必须调用。

        一个未关闭的 requests.Session 会一直攥着上一账号的 cookie/serviceToken，
        反复点「重新获取二维码」还会留下同样多条后台长轮询线程。
        """
        with self._state_lock:
            self._closed = True
            for key in ("_service_token", "_user_id", "_c_user_id", "_ssecurity",
                        "_pass_token", "_location", "_poll_result"):
                setattr(self, key, None)
            self._session.cookies.clear()
        try:
            self._session.close()
        except Exception:
            pass

    def start_qr_login(self) -> dict:
        """Step 1: Get QR code URL, download image, and start background long-poll."""
        url = "https://account.xiaomi.com/longPolling/loginUrl"
        data = {
            "_qrsize": "480",
            "qs": "%3Fsid%3Dxiaomiio%26_json%3Dtrue",
            "callback": "https://sts.api.io.mi.com/sts",
            "_hasLogo": "false",
            "sid": "xiaomiio",
            "serviceParam": "",
            "_locale": "en_GB",
            "_dc": str(int(time.time() * 1000))
        }
        # 所有云请求都必须带超时：调用方在 run_in_executor 的阻塞线程里，
        # 一次无超时的挂起会把线程和 Session 永久留在后台。
        response = self._session.get(url, params=data, timeout=CLOUD_HTTP_TIMEOUT)
        if response.status_code != 200:
            raise XiaomiCloudLoginError(f"获取二维码失败 (HTTP {response.status_code})")

        resp_data = self._to_json(response.text)
        if not (resp_data.get("qr") and resp_data.get("lp") and resp_data.get("loginUrl")):
            desc = resp_data.get("desc") or resp_data.get("description") or "服务器未返回 QR 数据"
            raise XiaomiCloudLoginError(f"获取二维码失败: {desc}")
        if resp_data.get("code") not in (None, 0, "0"):
            raise XiaomiCloudLoginError(f"获取二维码失败: {resp_data.get('desc') or resp_data['code']}")

        self._qr_image_url = resp_data["qr"]
        self._login_url = resp_data["loginUrl"]
        self._long_polling_url = resp_data["lp"]
        # timeout 是二维码有效期（秒）。异常值既不能把窗口压成 0，也不能让线程永久挂住。
        try:
            self._timeout = max(60, min(600, int(resp_data.get("timeout") or 300)))
        except (TypeError, ValueError):
            self._timeout = 300
        _LOGGER.info("QR login: timeout=%ss login_url=%s",
                     self._timeout, self._login_url[:120])

        # Download QR image
        qr_resp = self._session.get(self._qr_image_url, timeout=CLOUD_HTTP_TIMEOUT)
        qr_base64 = None
        if qr_resp.status_code == 200 and qr_resp.content:
            ct = qr_resp.headers.get("Content-Type", "image/png")
            qr_base64 = f"data:{ct};base64," + base64.b64encode(qr_resp.content).decode()

        # 有效期从"拿到二维码"这一刻算起，后台轮询与前端共用同一个截止时间。
        self._poll_deadline = time.monotonic() + self._timeout
        self._poll_result = None
        self._poll_error = None
        self._poll_done = False
        t = threading.Thread(target=self._background_poll, daemon=True)
        t.start()

        return {
            "qr_image": qr_base64,
            "login_url": self._login_url,
            "timeout": self._timeout,
        }

    def _set_poll_error(self, message: str) -> None:
        """先写错误再置 done：complete_qr_login 不会看到"done 了但没有错误"的中间态。"""
        self._poll_error = XiaomiCloudLoginError(message)
        self._poll_done = True

    @staticmethod
    def _is_expired_response(data: dict) -> bool:
        """200 但没有认证信息时，判断服务端是不是在明确告诉我们二维码失效。"""
        # 只认**明确**说二维码失效的措辞：单轮询超时（timeout / timed out）是
        # "继续等"的信号，误判成过期会把还有效的二维码白白作废。
        text = " ".join(str(data.get(k) or "") for k in
                        ("result", "desc", "description", "message", "msg", "error")).lower()
        return any(word in text for word in
                   ("expired", "expire", "过期", "失效", "已超时"))

    def _background_poll(self):
        """保持一条挂起的长轮询连接，等服务端把扫码结果推回来。

        小米 `lp` 端点会把请求一直 hold 到「用户在手机上确认登录」或「二维码到期」
        才返回；实测 40 秒内没有任何响应。旧实现用固定 `timeout=10` 每 10 秒就把
        这条连接掐断重开，服务端把登录结果推给挂起连接时我们早已离开，于是永远拿
        不到 ssecurity，只能在 5 分钟后报「二维码已过期」——每次扫码都必然失败。

        现在单次读超时覆盖整个剩余有效期（另留 15 秒给服务端返回过期帧），中途若被
        网络设备静默断开则立刻重挂一条连接继续等。
        """
        deadline = self._poll_deadline or (time.monotonic() + self._timeout)
        try:
            _LOGGER.info("Background long-poll started on: %s (deadline in %.0fs)",
                         self._long_polling_url[:80], max(0, deadline - time.monotonic()))
            while not self._closed:
                remaining = deadline - time.monotonic()
                if remaining <= 1:
                    _LOGGER.info("QR code expired without a scan result")
                    self._set_poll_error("二维码已过期，请重新获取")
                    return

                # 一次连接挂到窗口结束，不要再 10 秒一断。连接超时沿用 5s 兜底。
                read_timeout = min(remaining + 15, 330)
                try:
                    response = self._session.get(
                        self._long_polling_url,
                        timeout=(CLOUD_HTTP_TIMEOUT[0], read_timeout),
                    )
                except requests.exceptions.Timeout:
                    if time.monotonic() >= deadline:
                        _LOGGER.info("QR code expired (long-poll reached deadline)")
                        self._set_poll_error("二维码已过期，请重新获取")
                        return
                    # 中途静默断链（NAT / 代理空闲超时）：重挂继续等，不判过期。
                    _LOGGER.info("Long-poll connection dropped, re-arming (%.0fs left)",
                                 deadline - time.monotonic())
                    time.sleep(0.5)
                    continue
                except requests.exceptions.RequestException as e:
                    self._set_poll_error(f"网络错误: {e}")
                    return

                if response.status_code != 200:
                    if response.status_code in (408, 409, 425, 429, 500, 502, 503, 504):
                        _LOGGER.warning("Long-poll retryable HTTP %d", response.status_code)
                        time.sleep(1)
                        continue
                    self._set_poll_error(f"登录服务返回 HTTP {response.status_code}")
                    return

                if self._closed:
                    self._session.cookies.clear()
                    return
                data = self._to_json(response.text)
                # 只有带齐认证信息才算登录成功：等待中 / 已扫码待确认也可能返回 200。
                if data.get("ssecurity") and data.get("location"):
                    with self._state_lock:
                        if self._closed:
                            self._session.cookies.clear()
                            return
                        self._user_id = data.get("userId")
                        self._ssecurity = data["ssecurity"]
                        self._location = data["location"]
                        self._c_user_id = data.get("cUserId")
                        self._pass_token = data.get("passToken")
                        self._poll_done = True
                    _LOGGER.info("Background long-poll succeeded (scan confirmed)")
                    return

                if self._is_expired_response(data):
                    _LOGGER.info("Server reported QR code expired")
                    self._set_poll_error("二维码已过期，请重新获取")
                    return

                _LOGGER.info("Long-poll waiting: %s",
                             {k: data.get(k) for k in ("code", "result", "desc", "description")})
                time.sleep(0.5)   # 防止服务端快速回空响应时把 CPU / 云端打满
        except Exception as e:
            _LOGGER.error("Background long-poll exception: %s", e)
            self._set_poll_error(f"登录异常: {e}")

    def complete_qr_login(self) -> bool:
        """Step 2: Wait for background long-poll to complete, then get serviceToken."""
        with self._complete_lock:
            if self._closed:
                raise XiaomiCloudLoginError("会话已退出，请重新扫码")
            # Already have serviceToken from previous call
            if self._service_token:
                return True

            if not self._poll_done:
                raise XiaomiCloudLoginError("等待扫码中...")

            if self._poll_error:
                raise self._poll_error

            if not self._ssecurity or not self._location:
                raise XiaomiCloudLoginError("登录失败: 未获取到认证信息，请重新扫码")

            # Get serviceToken — location URL is one-time-use, only call once
            location = self._location
            self._location = None
            headers = {"User-Agent": self._agent,
                       "Content-Type": "application/x-www-form-urlencoded"}
            _LOGGER.info("Following location URL (one-time)")
            try:
                response = self._session.get(location, headers=headers,
                                             timeout=CLOUD_HTTP_TIMEOUT)
            except requests.exceptions.RequestException as e:
                raise XiaomiCloudLoginError(f"获取 service token 失败: {e}") from e
            _LOGGER.info("Location response: status=%d", response.status_code)
            with self._state_lock:
                if self._closed:
                    self._session.cookies.clear()
                    raise XiaomiCloudLoginError("会话已退出，请重新扫码")
                self._service_token = response.cookies.get("serviceToken")
                if not self._service_token:
                    self._service_token = self._session.cookies.get("serviceToken")
                if not self._service_token:
                    raise XiaomiCloudLoginError("无法获取 service token，请重新扫码")
                return True


    def get_devices(self) -> list:
        """Get all devices from Xiaomi cloud."""
        url = SERVERS.get(self._server, SERVERS["cn"])
        homes = self._api_call(f"{url}/v2/homeroom/gethome", {
            "data": '{"fg": true, "fetch_share": true, "fetch_share_dev": true, "limit": 300, "app_ver": 7}'
        })
        if not homes or homes.get("code") != 0:
            raise XiaomiCloudLoginError(f"获取设备列表失败: {homes}")

        _LOGGER.info("gethome result keys: %s", list(homes.get("result", {}).keys()) if homes.get("result") else "None")

        devices = []
        homelist = homes.get("result", {}).get("homelist", [])
        _LOGGER.info("Found %d homes", len(homelist))
        for home in homelist:
            home_id = home.get("id")
            owner_id = home.get("uid", self._user_id)
            home_data = self._api_call(f"{url}/v2/home/home_device_list", {
                "data": json.dumps({
                    "home_owner": owner_id,
                    "home_id": home_id,
                    "limit": 200,
                    "get_split_device": True,
                    "support_smart_home": True,
                })
            })
            if not home_data or home_data.get("code") != 0:
                _LOGGER.warning("home_device_list failed for home %s: %s", home_id, home_data)
                continue
            result = home_data.get("result", {})
            dev_list = result.get("device_info", result.get("list", []))
            _LOGGER.info("Home %s: found %d devices", home_id, len(dev_list))
            for dev in dev_list:
                token = dev.get("token", "")
                name = dev.get("name", "")
                model = dev.get("model", "")
                if token:
                    devices.append(XiaomiCloudDevice(
                        did=dev.get("did", ""),
                        mac=dev.get("mac", ""),
                        token=token,
                        name=name,
                        model=model,
                    ))
                else:
                    _LOGGER.debug("Skip device %s (no token)", name)
        _LOGGER.info("Total devices with valid token: %d", len(devices))
        return devices

    def get_beaconkey(self, did: str, timeout: Optional[float] = None) -> Optional[str]:
        """Get BLE beacon key for a device.

        `timeout`：本次调用的 HTTP 超时（秒）。批量导入时由调用方按**剩余预算**
        下发——只判"下一发之前还剩多少"挡不住已经飞出去的那一发，最后一条照样能
        跑满它自己的超时，于是总耗时 = 预算 + 一发最坏值，越过 30s 请求上限。
        """
        url = SERVERS.get(self._server, SERVERS["cn"])
        result = self._api_call(f"{url}/v2/device/blt_get_beaconkey", {
            "data": json.dumps({"did": did, "pdid": 1})
        }, timeout=timeout)
        _LOGGER.info("beaconkey request completed (code=%s)",
                     result.get("code") if isinstance(result, dict) else None)
        if result and result.get("code") == 0:
            key = result.get("result", {}).get("beaconkey", "")
            if key:
                return key
        return None

    def _api_call(self, url, params, timeout=None):
        headers = {
            "Accept-Encoding": "identity",
            "User-Agent": self._agent,
            "Content-Type": "application/x-www-form-urlencoded",
            "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
            "MIOT-ENCRYPT-ALGORITHM": "ENCRYPT-RC4",
        }
        cookies = {
            "userId": str(self._user_id),
            "yetAnotherServiceToken": str(self._service_token),
            "serviceToken": str(self._service_token),
            "locale": "en_GB",
            "timezone": "GMT+02:00",
            "is_daylight": "1",
            "dst_offset": "3600000",
            "channel": "MI_APP_STORE",
        }
        millis = round(time.time() * 1000)
        nonce = _generate_nonce(millis)
        sn = _signed_nonce(self._ssecurity, nonce)
        fields = _generate_enc_params(url, "POST", sn, nonce, params, self._ssecurity)
        try:
            response = self._session.post(url, headers=headers, cookies=cookies, params=fields,
                                           timeout=timeout or CLOUD_HTTP_TIMEOUT)
            if response.status_code == 200:
                decoded = _decrypt_rc4(_signed_nonce(self._ssecurity, fields["_nonce"]), response.text)
                return json.loads(decoded)
            _LOGGER.error("API %s returned %d: %s", url.split("/")[-1], response.status_code, response.text[:200])
        except Exception as e:
            _LOGGER.error("API call failed: %s", e)
        return None

    @staticmethod
    def _to_json(text):
        try:
            return json.loads(text.replace("&&&START&&&", "").strip())
        except json.JSONDecodeError:
            return {}
