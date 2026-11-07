"""米家**账号切换**的服务端契约（`/api/xiaomi/logout`、`replace_session`、`account`）。

为什么值得单独锁：每次扫码本来就是一次全新登录，但旧会话如果不显式销毁，就会
一直攥着上一个账号的 cookie/serviceToken，直到 TTL 到期；反复点「重新获取二维码」
还会累积一批挂着后台长轮询、却永远没人来查结果的僵尸会话。页面也拿不到任何
账号标识，用户无从判断"我现在挂的是哪个账号"。这些用例全部用替身客户端，不触网。
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

import ha_server  # noqa: E402
import xiaomi_cloud  # noqa: E402
from golden_harness import mock_request  # noqa: E402


def _json_request(body, path="/api/xiaomi/logout"):
    req = mock_request("POST", path)

    async def _json():
        return body

    req.json = _json
    return req


def _body(resp):
    return json.loads(resp.body)


class StubCloudError(Exception):
    pass


class StubDevice:
    did = "did-desk"
    mac = "aa:bb:cc:dd:ee:02"
    token = "11" * 16
    name = "书桌"
    model = "njcuk01"


class StubClient:
    """不触网的二维码客户端替身：记录 close() 是否被调用。"""

    def __init__(self, server="cn"):
        self._server = server
        self.closed = False
        self.login_started = False

    def start_qr_login(self):
        self.login_started = True
        return {"qr_image": "data:image/png;base64,AAAA",
                "login_url": "https://example.invalid/qr", "timeout": 300}

    def complete_qr_login(self):
        return True

    def get_devices(self):
        return []

    def account_info(self):
        return {"label": "****5678", "server": self._server}

    def close(self):
        self.closed = True


@pytest.fixture
def server(monkeypatch):
    s = ha_server.Server.__new__(ha_server.Server)
    s._xiaomi_sessions = {}
    monkeypatch.setattr(ha_server, "_load_xiaomi_cloud",
                        lambda: (StubClient, StubCloudError))
    return s


def _seed(server, sid, client, *, account=None):
    entry = {"client": client, "timer": None, "devices": []}
    if account is not None:
        entry["account"] = account
    server._xiaomi_sessions[sid] = entry


class TestAccountMasking:
    @pytest.mark.parametrize("raw, expected", [
        ("13800138000", "*******8000"),
        ("a@b.com", "a***@b.com"),
        ("1234", "****"),
        ("ab", "**"),
        ("", ""),
    ])
    def test_mask_keeps_only_tail(self, raw, expected):
        assert xiaomi_cloud.QrCodeXiaomiCloudClient._mask_account(raw) == expected

    def test_account_info_before_login_has_no_label(self):
        client = xiaomi_cloud.QrCodeXiaomiCloudClient("de")
        try:
            assert client.account_info() == {"label": "", "server": "de"}
            assert client.is_logged_in is False
        finally:
            client.close()

    def test_close_is_safe_to_call_twice(self):
        client = xiaomi_cloud.QrCodeXiaomiCloudClient("cn")
        client.close()
        client.close()  # 定时器与 logout 可能同时收尾，不能抛异常


class TestClosedCloudClient:
    def test_close_clears_cached_account_credentials(self):
        client = xiaomi_cloud.QrCodeXiaomiCloudClient("cn")
        client._service_token = "test-secret"
        client._user_id = "test-user"
        client._ssecurity = "test-security"
        client._session.cookies.set("serviceToken", "test-cookie")
        client.close()
        assert not client.is_logged_in
        assert client.account_info()["label"] == ""
        assert not client._session.cookies
        assert not client._ssecurity

    def test_response_arriving_after_close_cannot_restore_login(self, monkeypatch):
        client = xiaomi_cloud.QrCodeXiaomiCloudClient("cn")
        client._long_polling_url = "https://example.invalid/lp"
        client._timeout = 10
        class Response:
            status_code = 200
            text = '{"userId":"old-user","ssecurity":"old-security","location":"https://example.invalid/sts"}'
        def get(*args, **kwargs):
            client.close()
            return Response()
        monkeypatch.setattr(client._session, "get", get)
        client._background_poll()
        assert not client._ssecurity
        assert client.account_info()["label"] == ""


class TestXiaomiLogout:
    async def test_logout_destroys_session_and_closes_client(self, server):
        client = StubClient()
        _seed(server, "sess1", client, account={"label": "****5678"})
        resp = await server.handle_xiaomi_logout(_json_request({"session_id": "sess1"}))

        assert resp.status == 200 and _body(resp)["ok"] is True
        assert "sess1" not in server._xiaomi_sessions
        assert client.closed, "旧账号的 HTTP 会话必须真的关掉"

    async def test_logout_is_idempotent(self, server):
        """刷新页面 / 会话已过期时前端仍会调一次，不该报 400 卡住切换流程。"""
        first = await server.handle_xiaomi_logout(_json_request({"session_id": "gone"}))
        second = await server.handle_xiaomi_logout(_json_request({"session_id": "gone"}))
        assert first.status == 200 and second.status == 200

    async def test_logout_requires_session_id(self, server):
        resp = await server.handle_xiaomi_logout(_json_request({}))
        assert resp.status == 400

    async def test_cleanup_on_expiry_also_closes_client(self, server):
        client = StubClient()
        _seed(server, "sess1", client)
        server._cleanup_xiaomi_session("sess1")
        assert client.closed, "TTL 到期同样要释放 requests.Session"


class TestXiaomiLoginReplacement:
    async def test_replaces_old_session_and_reaps_unscanned_zombies(self, server):
        old, zombie, keep = StubClient(), StubClient(), StubClient()
        _seed(server, "old", old, account={"label": "****1111"})
        _seed(server, "zombie", zombie)     # 等扫码却没人来查结果
        _seed(server, "keep", keep, account={"label": "****2222"})

        resp = await server.handle_xiaomi_login(_json_request(
            {"server": "cn", "replace_session": "old"}, "/api/xiaomi/login"))
        assert resp.status == 200 and _body(resp)["ok"] is True

        assert "old" not in server._xiaomi_sessions
        assert "zombie" not in server._xiaomi_sessions
        assert old.closed and zombie.closed
        assert "keep" in server._xiaomi_sessions, "别的已登录会话不能被误杀"
        assert not keep.closed
        # keep + 本次新建的会话
        assert len(server._xiaomi_sessions) == 2
        for sid in list(server._xiaomi_sessions):
            server._cleanup_xiaomi_session(sid, "test teardown")

    async def test_start_failure_keeps_existing_login(self, server, monkeypatch):
        """新二维码没拿到就失败时，不能把用户正在用的登录态弄丢。"""
        old = StubClient()
        _seed(server, "old", old, account={"label": "****1111"})

        def _boom(self):
            raise StubCloudError("cloud down")

        monkeypatch.setattr(StubClient, "start_qr_login", _boom)
        resp = await server.handle_xiaomi_login(_json_request(
            {"server": "cn", "replace_session": "old"}, "/api/xiaomi/login"))

        assert resp.status == 400
        assert "old" in server._xiaomi_sessions
        assert not old.closed

    async def test_login_response_still_carries_qr_contract(self, server):
        resp = await server.handle_xiaomi_login(_json_request(
            {"server": "cn"}, "/api/xiaomi/login"))
        doc = _body(resp)
        assert doc["ok"] is True and doc["timeout"] == 300
        assert doc["session_id"] and doc["qr_image"] and doc["login_url"]
        for sid in list(server._xiaomi_sessions):
            server._cleanup_xiaomi_session(sid, "test teardown")


class TestXiaomiAccountResponse:
    async def test_qr_complete_returns_masked_account_and_records_it(self, server):
        client = StubClient("de")
        _seed(server, "sess1", client)
        resp = await server.handle_xiaomi_qr_complete(_json_request(
            {"session_id": "sess1"}, "/api/xiaomi/qr/complete"))

        assert resp.status == 200
        doc = _body(resp)
        assert doc["account"] == {"label": "****5678", "server": "de"}
        assert "userId" not in doc["account"] and "token" not in doc["account"]
        assert server._xiaomi_sessions["sess1"]["account"] == doc["account"], \
            "服务端要靠它区分已登录会话与等扫码的僵尸会话"
        server._cleanup_xiaomi_session("sess1", "test teardown")

    async def test_cached_device_list_still_returns_account(self, server):
        """第二次轮询走缓存分支，账号信息不能因此丢失。"""
        client = StubClient()
        _seed(server, "sess1", client, account={"label": "****5678"})
        server._xiaomi_sessions["sess1"]["devices"] = [StubDevice()]
        resp = await server.handle_xiaomi_qr_complete(_json_request(
            {"session_id": "sess1"}, "/api/xiaomi/qr/complete"))
        assert _body(resp)["account"]["label"] == "****5678"
        server._cleanup_xiaomi_session("sess1", "test teardown")


class TestAccountSwitchRaces:
    async def test_logout_during_device_fetch_never_returns_old_credentials(self, server):
        import asyncio
        import threading
        started, release = threading.Event(), threading.Event()
        client = StubClient()
        def get_devices():
            started.set()
            release.wait(3)
            return [StubDevice()]
        client.get_devices = get_devices
        _seed(server, "old", client)
        pending = asyncio.create_task(server.handle_xiaomi_qr_complete(
            _json_request({"session_id": "old"})))
        try:
            assert await asyncio.to_thread(started.wait, 2)
            await server.handle_xiaomi_logout(_json_request({"session_id": "old"}))
        finally:
            release.set()
        resp = await pending
        assert resp.status == 400
        assert "devices" not in _body(resp)

    async def test_failed_qr_start_closes_new_client(self, server, monkeypatch):
        created = []
        class FailingClient(StubClient):
            def __init__(self, region):
                super().__init__(region)
                created.append(self)
            def start_qr_login(self):
                raise StubCloudError("offline")
        monkeypatch.setattr(ha_server, "_load_xiaomi_cloud",
                            lambda: (FailingClient, StubCloudError))
        resp = await server.handle_xiaomi_login(_json_request({"server":"cn"}))
        assert resp.status == 400
        assert created[0].closed
