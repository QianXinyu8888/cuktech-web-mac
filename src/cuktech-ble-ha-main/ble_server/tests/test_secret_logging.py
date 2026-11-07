"""Credential operations must never include secrets in diagnostic logs."""
import logging
from unittest.mock import AsyncMock
import pytest
from xiaomi_cloud import QrCodeXiaomiCloudClient
from src.cuktech_ble import controller


def test_beaconkey_response_is_not_logged(monkeypatch, caplog):
    client = QrCodeXiaomiCloudClient()
    secret = 'synthetic-private-beacon-key'
    monkeypatch.setattr(client, '_api_call', lambda *a, **kw: {
        'code': 0, 'result': {'beaconkey': secret},
    })
    try:
        with caplog.at_level(logging.DEBUG):
            assert client.get_beaconkey('synthetic-device') == secret
        assert secret not in caplog.text
    finally:
        client._session.close()


@pytest.mark.asyncio
async def test_authentication_does_not_log_derived_keys(monkeypatch, caplog):
    token = bytes.fromhex('ab' * 12)
    ctrl = controller.CuktechBLEController(mac='AA:BB:CC:DD:EE:FF', token=token)
    ctrl.client = AsyncMock()
    ctrl.wait_notify = AsyncMock(side_effect=[
        bytes.fromhex('0000040006f2'),
        bytes.fromhex('00000400') + b'\xf2' * 20,
        bytes.fromhex('00000101'),
        bytes.fromhex('00000100'),
    ])
    ctrl._recv_auth_response = AsyncMock(side_effect=[b'\x57' * 16, b'\x00' * 32])
    monkeypatch.setattr(controller.asyncio, 'sleep', AsyncMock())
    monkeypatch.setattr(controller.secrets, 'token_bytes', lambda n: b'\x63' * n)
    with caplog.at_level(logging.DEBUG):
        # A wrong synthetic device HMAC stops just after genuine HKDF derivation.
        assert await ctrl.authenticate() is False
    assert ctrl._session_keys
    for key in ctrl._session_keys.values():
        assert key.hex() not in caplog.text
    assert token.hex() not in caplog.text
