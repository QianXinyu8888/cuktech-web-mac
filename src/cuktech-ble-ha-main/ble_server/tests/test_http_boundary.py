"""Exercise the browser boundary using real HTTP requests and synthetic secrets."""
from types import SimpleNamespace
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import pytest
import ha_server
from config import ServerConfig, config_from_mapping


@pytest.mark.asyncio
async def test_browser_boundary(monkeypatch):
    server = SimpleNamespace(config=SimpleNamespace(server=ServerConfig()))
    monkeypatch.setattr(ha_server, 'get_server', lambda: server)
    mutations = []

    async def change(request):
        mutations.append(await request.json())
        return web.json_response({'ok': True})

    async def secret(request):
        return web.json_response({'token': 'synthetic-test-secret'})

    app = web.Application(middlewares=[ha_server.cors_middleware])
    app.router.add_post('/api/port', change)
    app.router.add_get('/api/reveal-secret', secret)
    async with TestClient(TestServer(app)) as client:
        origin = str(client.make_url('/')).rstrip('/')
        for headers in [
            {'Origin': 'https://evil.example', 'Content-Type': 'text/plain'},
            {'Origin': 'null', 'Content-Type': 'text/plain'},
            {'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'text/plain'},
            {'Host': 'evil.example', 'Content-Type': 'text/plain'},
        ]:
            response = await client.post('/api/port', data='{"enabled":false}', headers=headers)
            assert response.status == 403
        assert mutations == []
        for headers in [
            {'Origin': 'https://evil.example'},
            {'Sec-Fetch-Site': 'cross-site'},
            {'Host': 'evil.example'},
            {'Host': 'evil.example', 'Origin': 'http://evil.example'},
        ]:
            response = await client.get('/api/reveal-secret', headers=headers)
            assert response.status == 403
            assert 'synthetic-test-secret' not in await response.text()
        for headers in [{}, {'Origin': origin, 'Sec-Fetch-Site': 'same-origin'}]:
            response = await client.post('/api/port', json={'enabled': True}, headers=headers)
            assert response.status == 200
        assert mutations == [{'enabled': True}, {'enabled': True}]
        response = await client.get('/api/reveal-secret')
        assert response.status == 200


def test_core_defaults_to_loopback():
    assert ServerConfig().host == '127.0.0.1'


def test_empty_config_defaults_to_loopback():
    assert config_from_mapping({}).server.host == "127.0.0.1"
