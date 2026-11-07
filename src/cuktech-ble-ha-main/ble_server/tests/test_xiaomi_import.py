"""米家**多设备**导入（`/api/xiaomi/import`）与名称同步的服务端契约。

为什么值得单独锁：BLE Key 只能按 did 单取（`blt_get_beaconkey`），多台设备就是
多次云调用。如果这段逻辑写错，用户的感受是"导入了 3 台，只有 1 台能用"，
而配置页拿不到 BLE Key 的设备会保存成功却在启动时认证失败——最贵的那种错。

这些用例全部用替身客户端，不触网。
"""
import asyncio
import json
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

import ha_server  # noqa: E402
from golden_harness import mock_request  # noqa: E402


class FakeCloudError(Exception):
    pass


class FakeDevice:
    def __init__(self, did, mac, token, name="", model="njcuk01"):
        self.did = did
        self.mac = mac
        self.token = token
        self.name = name
        self.model = model


class FakeClient:
    """`get_beaconkey` 按 did 返回；`failing` 里的 did 抛异常（模拟单台云调用失败）。"""

    def __init__(self, keys=None, failing=()):
        self.keys = keys or {}
        self.failing = set(failing)
        self.calls = []
        self.timeouts = []

    def get_beaconkey(self, did, timeout=None):
        self.calls.append(did)
        self.timeouts.append(timeout)
        if did in self.failing:
            raise FakeCloudError("cloud boom")
        return self.keys.get(did)


def _json_request(body, path="/api/xiaomi/import"):
    req = mock_request("POST", path)

    async def _json():
        return body

    req.json = _json
    return req


@pytest.fixture
def server(monkeypatch):
    s = ha_server.Server.__new__(ha_server.Server)
    s._xiaomi_sessions = {}
    monkeypatch.setattr(ha_server, "_load_xiaomi_cloud",
                        lambda: (FakeClient, FakeCloudError))
    return s


def _seed(server, devices, client):
    """造一个"已扫码完成"的会话（等价于 qr/complete 之后的形状）。"""
    server._xiaomi_sessions["sess1"] = {"client": client, "timer": None,
                                        "devices": devices}


DESK = FakeDevice("did-desk", "aa:bb:cc:dd:ee:02", "11" * 16, "书桌充电器")
BED = FakeDevice("did-bed", "aa:bb:cc:dd:ee:03", "22" * 16, "Bedroom")


class TestXiaomiImport:
    async def test_imports_multiple_devices_in_one_call(self, server):
        client = FakeClient(keys={"did-desk": "key-desk", "did-bed": "key-bed"})
        _seed(server, [DESK, BED], client)

        resp = await server.handle_xiaomi_import(
            _json_request({"session_id": "sess1", "dids": ["did-desk", "did-bed"]}))
        assert resp.status == 200
        body = json.loads(resp.body)
        assert body["ok"] is True
        got = {d["did"]: d for d in body["devices"]}
        assert got["did-desk"] == {"did": "did-desk", "name": "书桌充电器",
                                  "mac": "aa:bb:cc:dd:ee:02", "token": "11" * 16,
                                  "model": "njcuk01", "ble_key": "key-desk"}
        assert got["did-bed"]["name"] == "Bedroom"
        assert got["did-bed"]["ble_key"] == "key-bed"
        assert client.calls == ["did-desk", "did-bed"]

    async def test_browser_can_defer_persistence_until_full_config_is_saved(self, server, monkeypatch):
        client = FakeClient(keys={"did-desk": "key-desk"})
        _seed(server, [DESK], client)
        attempts = []
        monkeypatch.setattr(server, "_auto_persist_primary", lambda results: attempts.append(results))
        resp = await server.handle_xiaomi_import(_json_request({
            "session_id": "sess1", "dids": ["did-desk"], "defer_save": True,
        }))
        assert resp.status == 200
        assert json.loads(resp.body)["devices"][0]["token"] == DESK.token
        assert attempts == [], "导入期间不能先写第一台并提前重启打断完整保存"
        server._cleanup_xiaomi_session("sess1", "test teardown")

    async def test_logout_during_import_does_not_persist_old_account_device(self, server, monkeypatch):
        import threading
        started, release = threading.Event(), threading.Event()
        client = FakeClient()
        def get_key(did, timeout=None):
            started.set()
            release.wait(3)
            return "key-desk"
        client.get_beaconkey = get_key
        _seed(server, [DESK], client)
        attempts = []
        monkeypatch.setattr(server, "_auto_persist_primary", lambda results: attempts.append(results))
        pending = asyncio.create_task(server.handle_xiaomi_import(_json_request({
            "session_id":"sess1", "dids":["did-desk"],
        })))
        try:
            assert await asyncio.to_thread(started.wait, 2)
            server._cleanup_xiaomi_session("sess1", "logout")
        finally:
            release.set()
        resp = await pending
        assert resp.status == 400
        assert attempts == []
        assert "devices" not in json.loads(resp.body)

    async def test_one_failure_does_not_sink_the_batch(self, server):
        client = FakeClient(keys={"did-desk": "key-desk"}, failing={"did-bed"})
        _seed(server, [DESK, BED], client)

        resp = await server.handle_xiaomi_import(
            _json_request({"session_id": "sess1", "dids": ["did-desk", "did-bed"]}))
        body = json.loads(resp.body)
        got = {d["did"]: d for d in body["devices"]}
        assert got["did-desk"]["ble_key"] == "key-desk"
        assert "cloud boom" in got["did-bed"]["error"]
        assert "token" not in got["did-bed"], "失败的那台不能带半份凭据回去"

    async def test_unknown_did_is_reported_not_guessed(self, server):
        client = FakeClient(keys={"did-desk": "key-desk"})
        _seed(server, [DESK], client)

        resp = await server.handle_xiaomi_import(
            _json_request({"session_id": "sess1", "dids": ["did-desk", "did-ghost"]}))
        got = {d["did"]: d for d in json.loads(resp.body)["devices"]}
        assert got["did-ghost"]["error"] == "device_not_in_list"
        assert "did-ghost" not in client.calls, "不知道的 did 不该去问云端"

    async def test_session_survives_for_a_second_round(self, server):
        """分两批导入都要能用：导入后会话仍在，且定时器被重挂（否则永久泄漏）。"""
        client = FakeClient(keys={"did-desk": "key-desk", "did-bed": "key-bed"})
        _seed(server, [DESK, BED], client)

        await server.handle_xiaomi_import(
            _json_request({"session_id": "sess1", "dids": ["did-desk"]}))
        entry = server._xiaomi_sessions.get("sess1")
        assert entry is not None, "导入一次就把会话删了 → 第二批要重新扫码"
        assert entry["timer"] is not None, "会话还在却没有超时定时器 = 泄漏"

        resp = await server.handle_xiaomi_import(
            _json_request({"session_id": "sess1", "dids": ["did-bed"]}))
        assert json.loads(resp.body)["devices"][0]["ble_key"] == "key-bed"
        entry["timer"].cancel()

    async def test_rejects_empty_selection_and_unknown_session(self, server):
        client = FakeClient()
        _seed(server, [DESK], client)
        for body in ({"session_id": "sess1", "dids": []},
                     {"session_id": "sess1"},
                     {"session_id": "sess1", "dids": ["  "]}):
            resp = await server.handle_xiaomi_import(_json_request(body))
            assert resp.status == 400, body
        resp = await server.handle_xiaomi_import(
            _json_request({"session_id": "nope", "dids": ["did-desk"]}))
        assert resp.status == 400
        assert "会话已过期" in json.loads(resp.body)["error"]

    async def test_beaconkey_endpoint_still_works_and_keeps_session(self, server):
        client = FakeClient(keys={"did-desk": "key-desk", "did-bed": "key-bed"})
        _seed(server, [DESK, BED], client)

        resp = await server.handle_xiaomi_beaconkey(
            _json_request({"session_id": "sess1", "did": "did-desk"},
                          path="/api/xiaomi/beaconkey"))
        assert json.loads(resp.body)["ble_key"] == "key-desk"
        assert "sess1" in server._xiaomi_sessions, "单台取 key 也不该销毁会话"
        entry = server._xiaomi_sessions["sess1"]
        if entry["timer"]:
            entry["timer"].cancel()


class TestXiaomiImportBudget:
    """P2-1：批量导入必须有整体预算，别让云端卡住变成 N 次悬死。

    `requests` 的超时已由 `xiaomi_cloud.CLOUD_HTTP_TIMEOUT` 兜住；这里再锁服务端的
    "整体截止时间"：超出预算的设备逐台返回 `timeout`，请求本身必须按时收尾
    （30s 中间件只会把浏览器救出去，线程不会）。
    """

    async def test_over_budget_devices_report_timeout(self, server, monkeypatch):
        client = FakeClient(keys={"did-desk": "k1", "did-bed": "k2"})
        _seed(server, [DESK, BED], client)
        monkeypatch.setattr(server, "XIAOMI_IMPORT_BUDGET", -1.0)   # 立即超预算

        resp = await server.handle_xiaomi_import(
            _json_request({"session_id": "sess1", "dids": ["did-desk", "did-bed"]}))
        assert resp.status == 200
        body = json.loads(resp.body)
        assert [d.get("error") for d in body["devices"]] == ["timeout", "timeout"]
        assert client.calls == [], "超预算就不该再去调云端"
        entry = server._xiaomi_sessions["sess1"]
        if entry["timer"]:
            entry["timer"].cancel()

    def test_cloud_client_sets_http_timeouts(self):
        """`requests` 默认无限等：`_api_call` 必须显式给 (连接, 读取) 超时。

        `importorskip`：米家是**可选**依赖（`requests` + `pycryptodomex`），最小安装
        环境里没有它们。宁可 skip 也不要 error——但 CI 会用 `pip install -e .` 装齐，
        所以这条断言在 PR 上仍然真的跑（与 test_ha_server 那条同款处理）。
        """
        import inspect
        pytest.importorskip("requests", reason="米家依赖（可选）：未安装则跳过源码断言")
        import xiaomi_cloud

        src = inspect.getsource(xiaomi_cloud)
        fixed = src.count("timeout=CLOUD_HTTP_TIMEOUT")          # 登录三步
        per_call = src.count("timeout=timeout or CLOUD_HTTP_TIMEOUT")   # 两个 _api_call
        assert fixed + per_call >= 5, \
            f"所有 requests 调用都要带超时（固定 {fixed} + 可覆盖 {per_call}）"
        assert xiaomi_cloud.CLOUD_HTTP_TIMEOUT == (5, 15)

    async def test_per_call_timeout_is_capped_by_remaining_budget(self, server, monkeypatch):
        """只判"下一发之前还剩多少"挡不住已经在飞的那一发：剩余预算必须**下发**成
        这一发的超时，否则总耗时 = 预算 + 一发最坏值（20+20=40s > 30s 请求上限）。"""
        client = FakeClient(keys={"did-desk": "k1", "did-bed": "k2"})
        _seed(server, [DESK, BED], client)
        monkeypatch.setattr(server, "XIAOMI_IMPORT_BUDGET", 5.0)

        resp = await server.handle_xiaomi_import(
            _json_request({"session_id": "sess1", "dids": ["did-desk", "did-bed"]}))
        assert resp.status == 200
        assert client.timeouts and all(t is not None for t in client.timeouts), client.timeouts
        assert all(0 < t <= 5.0 for t in client.timeouts), \
            f"每发的超时不得超过剩余预算：{client.timeouts}"
        entry = server._xiaomi_sessions["sess1"]
        if entry["timer"]:
            entry["timer"].cancel()


class TestXiaomiSessionLifecycle:
    async def test_expired_session_is_dropped_by_timer(self, server):
        client = FakeClient()
        _seed(server, [DESK], client)
        server._arm_xiaomi_timer("sess1", 0.01)
        await asyncio.sleep(0.05)
        assert "sess1" not in server._xiaomi_sessions, "过期会话必须被回收"

    async def test_arm_is_idempotent(self, server):
        """重复挂定时器不应留下多个（每次重挂先取消上一个）。"""
        client = FakeClient()
        _seed(server, [DESK], client)
        server._arm_xiaomi_timer("sess1", 60)
        first = server._xiaomi_sessions["sess1"]["timer"]
        server._arm_xiaomi_timer("sess1", 60)
        second = server._xiaomi_sessions["sess1"]["timer"]
        assert first is not second and first.cancelled()
        second.cancel()


class _FakeHttpResponse:
    """够用的 requests.Response 替身（长轮询响应带 &&&START&&& 前缀）。"""

    def __init__(self, payload=None, status=200, cookies=None):
        self.status_code = status
        self.text = "&&&START&&&" + json.dumps(payload or {})
        self.content = b""
        self.headers = {"Content-Type": "image/png"}
        self.cookies = cookies or {}


class TestQrCompletePolling:
    async def test_repeated_polls_reuse_device_list(self, server):
        """前端每 3 秒查一次：扫码成功后不该把云端设备清单反复拉取一遍。"""
        class FakeQrClient:
            def __init__(self):
                self.calls = 0

            def complete_qr_login(self):
                return True

            def get_devices(self):
                self.calls += 1
                return [DESK]

        client = FakeQrClient()
        server._xiaomi_sessions["sess2"] = {
            "client": client, "timer": None, "devices": [],
        }
        for _ in range(2):
            resp = await server.handle_xiaomi_qr_complete(
                _json_request({"session_id": "sess2"}))
            assert resp.status == 200
            assert json.loads(resp.body)["ok"] is True
        assert client.calls == 1, "第二次轮询应直接复用服务端缓存的清单"
        entry = server._xiaomi_sessions["sess2"]
        if entry.get("timer"):
            entry["timer"].cancel()


class TestQrCodeLongPoll:
    """扫码结果接收的契约（本地替身，不触网）。

    回归背景：小米 lp 端点会把连接 hold 到"用户确认登录"或"二维码到期"才返回，
    实测 40s 内无任何响应。旧实现固定 `timeout=10` 每 10 秒掐断重连，于是永远收不到
    ssecurity，5 分钟后必然弹「二维码已过期」。这组用例锁住修复后的行为。
    """

    @staticmethod
    def _client(deadline_in=3):
        import xiaomi_cloud
        client = xiaomi_cloud.QrCodeXiaomiCloudClient()
        client._long_polling_url = "https://example.invalid/lp"
        client._timeout = 3
        client._poll_deadline = time.monotonic() + deadline_in
        return client

    LOGIN_PAYLOAD = {"userId": "u1", "ssecurity": "sec", "location": "https://sts/x",
                     "cUserId": "c1", "passToken": "p1"}

    def test_scan_result_is_received_on_a_held_connection(self, monkeypatch):
        """单次读超时必须覆盖等待窗口：固定 10s 会在结果推回来之前断开。"""
        requests = pytest.importorskip("requests")
        import xiaomi_cloud
        client = self._client()
        seen = []

        def fake_get(url, timeout=None, **kwargs):
            seen.append(timeout)
            read = timeout[1] if isinstance(timeout, tuple) else timeout
            # 模拟服务端在 12s 后才推送扫码结果：短超时的客户端永远拿不到
            if not read or read < 12:
                raise requests.exceptions.ReadTimeout("disconnected before scan")
            return _FakeHttpResponse(self.LOGIN_PAYLOAD)

        monkeypatch.setattr(client._session, "get", fake_get)
        client._background_poll()
        assert seen and all(isinstance(t, tuple) and t[1] >= 12 for t in seen), seen
        assert client._poll_done is True and client._poll_error is None
        assert client._ssecurity == "sec" and client._location == self.LOGIN_PAYLOAD["location"]
        assert isinstance(client, xiaomi_cloud.QrCodeXiaomiCloudClient)

    def test_waiting_200_is_not_mistaken_for_success(self, monkeypatch):
        """等待中 / 已扫码待确认也可能返回 200，不能当成登录成功就地结束。"""
        pytest.importorskip("requests")
        client = self._client()
        queue = [_FakeHttpResponse({"code": 0, "result": "ok", "desc": "成功"}),
                 _FakeHttpResponse(self.LOGIN_PAYLOAD)]

        def fake_get(url, timeout=None, **kwargs):
            return queue.pop(0) if len(queue) > 1 else queue[0]

        monkeypatch.setattr(client._session, "get", fake_get)
        client._background_poll()
        assert client._poll_done is True and client._poll_error is None
        assert client._ssecurity == "sec"

    def test_server_reported_expiry_is_surfaced(self, monkeypatch):
        pytest.importorskip("requests")
        import xiaomi_cloud
        client = self._client()
        monkeypatch.setattr(
            client._session, "get",
            lambda url, timeout=None, **kw: _FakeHttpResponse(
                {"code": 70016, "desc": "QR code expired"}))
        client._background_poll()
        assert isinstance(client._poll_error, xiaomi_cloud.XiaomiCloudLoginError)
        assert "过期" in str(client._poll_error)

    def test_deadline_without_scan_reports_expired(self, monkeypatch):
        """没扫码且窗口已过：明确报过期，且不再发出任何请求。"""
        pytest.importorskip("requests")
        client = self._client(deadline_in=-1)

        def must_not_call(*args, **kwargs):
            raise AssertionError("窗口已过就不该再打云端")

        monkeypatch.setattr(client._session, "get", must_not_call)
        client._background_poll()
        assert "过期" in str(client._poll_error)

    def test_start_qr_login_exposes_timeout_and_sets_http_timeouts(self, monkeypatch):
        pytest.importorskip("requests")
        import xiaomi_cloud
        client = xiaomi_cloud.QrCodeXiaomiCloudClient()
        monkeypatch.setattr(client, "_background_poll", lambda: None)  # 别真的起轮询线程
        calls = []
        payload = {"qr": "https://example.invalid/qr",
                   "loginUrl": "https://example.invalid/login",
                   "lp": "https://example.invalid/lp",
                   "timeout": 300, "code": 0, "desc": "成功"}

        def fake_get(url, params=None, timeout=None, **kwargs):
            calls.append((url, timeout))
            return _FakeHttpResponse(payload if "loginUrl" in url else {})

        monkeypatch.setattr(client._session, "get", fake_get)
        result = client.start_qr_login()
        assert result["timeout"] == 300
        assert result["login_url"] == payload["loginUrl"]
        assert all(t is not None for _, t in calls), "二维码获取/下载也必须带 HTTP 超时"
        assert client._poll_deadline > time.monotonic()

    def test_complete_login_consumes_location_once_with_timeout(self, monkeypatch):
        pytest.importorskip("requests")
        client = self._client()
        client._poll_done = True
        client._ssecurity = "sec"
        client._location = "https://example.invalid/sts"
        calls = []

        class StsResponse:
            status_code = 200
            text = ""
            cookies = {"serviceToken": "tok"}

        def fake_get(url, timeout=None, **kwargs):
            calls.append((url, timeout))
            return StsResponse()

        monkeypatch.setattr(client._session, "get", fake_get)
        assert client.complete_qr_login() is True
        assert client._service_token == "tok"
        assert calls and calls[0][1] is not None
        assert client._location is None, "一次性 URL 不能被并发轮询重复消费"
