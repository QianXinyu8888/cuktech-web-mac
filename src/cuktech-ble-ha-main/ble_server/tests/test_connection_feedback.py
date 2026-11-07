"""Connection failures remain observable through retries, refreshes and cancellation."""
import asyncio
import importlib.util
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from state import ChargerState
from ble_manager import BLEManager
from adapter_coordinator import AdapterCoordinator
from cuktech_ble.controller import AuthConnectionError


def test_feedback_classifier_is_available():
    assert importlib.util.find_spec('connection_feedback') is not None


@pytest.mark.parametrize('error,stage,expected', [
    (TimeoutError(), 'connecting', 'connection_timeout'),
    (ConnectionError('Charger not found'), 'scanning', 'device_not_found'),
    (ConnectionError('Bluetooth device is turned off'), 'scanning', 'bluetooth_off'),
    (ConnectionError('POWERED_OFF'), 'scanning', 'bluetooth_off'),
    (PermissionError('access denied'), 'scanning', 'permission_denied'),
    (ConnectionError('Bluetooth device is not authorized'), 'scanning', 'permission_denied'),
    (ConnectionError('org.bluez.Error.InProgress'), 'scanning', 'bluetooth_busy'),
    (ConnectionError('No Bluetooth adapters found'), 'scanning', 'adapter_unavailable'),
    (AuthConnectionError('Auth failed'), 'authenticating', 'authentication_failed'),
    (ConnectionError('link lost'), 'connected', 'connection_lost'),
    (RuntimeError('unknown private details'), 'connecting', 'connection_failed'),
])
def test_classification_does_not_invent_phone_occupancy(error, stage, expected):
    from connection_feedback import classify_connection_error
    assert classify_connection_error(error, stage) == expected


async def test_feedback_is_in_snapshot_and_independent_of_other_device():
    first, second = ChargerState(), ChargerState()
    assert 'connection' in await first.to_dict()
    error = {'code': 'device_not_found', 'stage': 'scanning', 'occurred_at': 1.0}
    await first.update_connection_feedback(phase='retry_wait', last_error=error)
    snapshot = await first.to_dict()
    assert snapshot['connection']['last_error']['code'] == 'device_not_found'
    assert (await second.to_dict())['connection']['last_error'] is None
    await first.update_connection_feedback(phase='scanning')
    assert (await first.to_dict())['connection']['last_error'] == error
    assert snapshot['connection']['phase'] == 'retry_wait'


def manager():
    config = MagicMock()
    config.server.reconnect_base_delay = 0.01
    config.server.reconnect_max_delay = 0.01
    config.server.command_timeout = 1
    return BLEManager('AA:BB:CC:DD:EE:01', '00' * 16, ChargerState(), config)


async def test_timeout_is_reported_before_cleanup_and_preserved_through_retry():
    mgr = manager()
    mgr.CONNECTION_TIMEOUT = 0.02
    # An async implementation (rather than a mock returning a coroutine).
    async def stuck():
        await asyncio.Event().wait()
    mgr._connect_locked = stuck
    mgr._force_disconnect_bluetooth = AsyncMock()
    errors = []
    async def cleanup():
        errors.append(mgr.state.connection['last_error'])
        mgr._stop_event.set()
    mgr._disconnect = cleanup
    await asyncio.wait_for(mgr.start(), 0.3)
    assert errors[0]['code'] == 'connection_timeout'
    assert errors[0]['stage'] == 'waiting'


async def test_success_clears_error_before_initial_settings_and_has_no_live_timeout():
    mgr = manager()
    assert hasattr(mgr, '_set_connection_feedback')
    await mgr._set_connection_feedback(phase='retry_wait', last_error={
        'code': 'connection_timeout', 'stage': 'connecting', 'occurred_at': 1})
    mgr.CONNECTION_TIMEOUT = 0.02
    async def establish():
        await mgr.state.set_connection(True, True)
        await mgr._set_connection_feedback(phase='connected', last_error=None)
    initialized = asyncio.Event()
    async def initialize():
        await asyncio.sleep(0.05)
        initialized.set()
    mgr._connect_locked = establish
    mgr._initialize_connection = initialize
    await mgr._connect()
    assert initialized.is_set()
    assert mgr.state.connection['last_error'] is None


async def test_retry_wakes_backoff_without_starting_second_loop_and_stop_clears_error():
    mgr = manager()
    assert hasattr(mgr, 'retry_connection')
    await mgr._set_connection_feedback(phase='retry_wait', last_error={
        'code': 'device_not_found', 'stage': 'scanning', 'occurred_at': 1})
    wait = asyncio.create_task(mgr._wait_to_retry(30))
    await asyncio.sleep(0)
    mgr.retry_connection()
    await asyncio.wait_for(wait, 0.2)
    assert mgr.state.connection['last_error']['code'] == 'device_not_found'
    await mgr.request_stop()
    assert mgr.state.connection['phase'] == 'disabled'
    assert mgr.state.connection['last_error'] is None


async def test_status_sse_has_feedback_and_real_booleans_but_mqtt_contract_is_unchanged():
    mgr = manager()
    emitter, mqtt = MagicMock(), MagicMock()
    mgr.set_sse_emitter(emitter)
    mgr.set_mqtt_publisher(mqtt)
    payload = {'connected': False}
    mgr._publish_status(payload)
    emitted = emitter.emit.call_args.args[1]
    assert emitted['authenticated'] is False
    assert emitted['connection']['phase'] == 'disabled'
    mqtt.assert_called_once_with(mgr.topics.status, payload, retain=False)
    assert 'connection' not in payload


async def test_cancelling_one_scan_waiter_does_not_cancel_other_devices_scan():
    coord = AdapterCoordinator(device_count_provider=lambda: 2)
    started, finish = asyncio.Event(), asyncio.Event()
    async def discover(timeout):
        started.set()
        await finish.wait()
        return {'aa:bb:cc:dd:ee:02': 'second-device'}
    coord.scan_cleanup = AsyncMock()
    coord._discover = discover
    first = asyncio.create_task(coord.find_device('AA:BB:CC:DD:EE:01', 1))
    await started.wait()
    second = asyncio.create_task(coord.find_device('AA:BB:CC:DD:EE:02', 1))
    await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    finish.set()
    assert await asyncio.wait_for(second, 0.2) == 'second-device'
    assert coord.scans == 1
    assert coord._pending == {}


async def test_scanner_power_off_error_reaches_manager_instead_of_becoming_not_found():
    coord = AdapterCoordinator()
    coord.scan_cleanup = AsyncMock()
    coord._discover = AsyncMock(side_effect=ConnectionError('POWERED_OFF'))
    with pytest.raises(ConnectionError, match='POWERED_OFF'):
        await coord.find_device('AA:BB:CC:DD:EE:01', 1)
    assert coord._pending == {}


@pytest.mark.parametrize('message', ['Write not permitted', 'unsupported opcode', 'Read not permitted'])
def test_peripheral_errors_are_not_misreported_as_mac_permissions(message):
    from connection_feedback import classify_connection_error
    assert classify_connection_error(ConnectionError(message), 'authenticating') == 'connection_failed'


async def test_orphan_scan_cleanup_cannot_trap_a_new_waiter():
    coord = AdapterCoordinator()
    cleanup_started, release_cleanup = asyncio.Event(), asyncio.Event()
    calls = 0
    async def discover(timeout):
        nonlocal calls
        calls += 1
        if calls == 1:
            try:
                await asyncio.Event().wait()
            finally:
                cleanup_started.set()
                await release_cleanup.wait()
        return {'aa:bb:cc:dd:ee:02': 'new-device'}
    coord.scan_cleanup = AsyncMock()
    coord._discover = discover
    first = asyncio.create_task(coord.find_device('AA:BB:CC:DD:EE:01', 1))
    while calls == 0:
        await asyncio.sleep(0)
    first.cancel()
    await cleanup_started.wait()
    second = asyncio.create_task(coord.find_device('AA:BB:CC:DD:EE:02', 1))
    await asyncio.sleep(0)
    release_cleanup.set()
    with pytest.raises(asyncio.CancelledError):
        await first
    assert await asyncio.wait_for(second, 0.2) == 'new-device'
    assert calls == 2


async def test_auth_rejection_does_not_wait_for_transport_cleanup():
    mgr = manager()
    ctrl = MagicMock()
    ctrl.connect = AsyncMock()
    ctrl.read_device_info = AsyncMock()
    ctrl.authenticate = AsyncMock(return_value=False)
    ctrl.stop_all_notifications = AsyncMock()
    async def stuck_disconnect():
        await asyncio.Event().wait()
    ctrl.client.disconnect = stuck_disconnect
    mgr._controller_factory = lambda mac, token: ctrl
    mgr._scan_for_device = AsyncMock(return_value=SimpleNamespace(address='uuid'))
    # Keep only setup sleeps instantaneous, without replacing the timeout machinery.
    import ble_manager as bm
    original_sleep = asyncio.sleep
    async def fast_sleep(delay):
        await original_sleep(0)
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(bm.asyncio, 'sleep', fast_sleep)
        with pytest.raises(AuthConnectionError):
            await asyncio.wait_for(mgr._connect_locked(), 0.1)


async def test_disconnect_releases_local_ownership_before_transport_and_never_clears_new_link():
    mgr = manager()
    mgr.adapter = AdapterCoordinator()
    mgr.adapter.note_connected(mgr.mac)
    await mgr.state.set_connection(True, True)
    cleanup_started, release = asyncio.Event(), asyncio.Event()
    old = MagicMock()
    old.client.is_connected = True
    async def cleanup():
        cleanup_started.set()
        await release.wait()
    old.stop_all_notifications = cleanup
    old.client.disconnect = AsyncMock()
    mgr.ctrl = old
    task = asyncio.create_task(mgr._cleanup_connection())
    await cleanup_started.wait()
    assert mgr.ctrl is None
    assert mgr.mac.lower() not in mgr.adapter.live_connections
    assert mgr.state.authenticated is False
    new = MagicMock()
    mgr.ctrl = new
    await mgr.state.set_connection(True, True)
    release.set()
    await asyncio.wait_for(task, 0.2)
    assert mgr.ctrl is new
    assert mgr.state.authenticated is True


async def test_deadline_feedback_is_not_delayed_by_slow_cancellation():
    mgr = manager()
    mgr.CONNECTION_TIMEOUT = 0.02
    async def establish():
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0.12)
    mgr._connect_locked = establish
    mgr._force_disconnect_bluetooth = AsyncMock()
    task = asyncio.create_task(mgr.start())
    await asyncio.sleep(0.05)
    try:
        assert mgr.state.connection['last_error']['code'] == 'connection_timeout'
    finally:
        await mgr.request_stop()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


async def test_status_change_wakes_an_idle_sse_reader_immediately():
    from ha_server import SSEEmitter
    emitter, queue = SSEEmitter(), asyncio.Queue()
    emitter.add_client(queue)
    assert hasattr(emitter, 'next_message')
    waiting = asyncio.create_task(emitter.next_message(queue, timeout=5))
    await asyncio.sleep(0)
    emitter.emit('status', {'connected': False, 'connection': {'phase': 'retry_wait'}})
    assert await asyncio.wait_for(waiting, 0.2) is None
    assert 'retry_wait' in emitter.flush_status(queue)
    emitter.remove_client(queue)


async def test_retry_endpoint_wakes_existing_device_task_and_snapshot_matches_sse():
    import json
    from golden_harness import golden_env, mock_request
    async with golden_env() as env:
        rt = env.server.registry.primary
        await rt.manager._set_connection_feedback(phase='retry_wait', last_error={
            'code': 'connection_timeout', 'stage': 'connecting', 'occurred_at': 1})
        task = rt.supervisor.task
        request = mock_request('POST', '/api/enable')
        request.json = AsyncMock(return_value={'enabled': True, 'retry': True})
        response = await env.server.handle_enable(request)
        assert response.status == 200
        assert rt.supervisor.task is task
        assert rt.manager._retry_event.is_set()
        body = json.loads((await env.server.handle_status(mock_request())).body)
        assert body['connection']['last_error']['code'] == 'connection_timeout'


async def test_invalidated_status_cannot_be_repopulated_by_old_serialization(monkeypatch):
    import ha_server
    import json
    from golden_harness import golden_env, mock_request
    async with golden_env() as env:
        captured, release = asyncio.Event(), asyncio.Event()
        async def slow_thread(fn):
            captured.set()
            await release.wait()
            return fn()
        monkeypatch.setattr(ha_server.asyncio, 'to_thread', slow_thread)
        old = asyncio.create_task(env.server.handle_status(mock_request()))
        await asyncio.sleep(0)
        await env.server.ble._set_connection_feedback(phase='scanning')
        release.set()
        await old
        fresh = json.loads((await env.server.handle_status(mock_request())).body)
        assert fresh['connection']['phase'] == 'scanning'


async def test_late_transport_exception_cannot_replace_deadline_error():
    mgr = manager()
    mgr.CONNECTION_TIMEOUT = 0.02
    async def establish():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await asyncio.sleep(0.03)
            raise ConnectionError('link teardown failed')
    mgr._connect_locked = establish
    mgr._force_disconnect_bluetooth = AsyncMock()
    observed = []
    async def disconnected():
        observed.append(mgr.state.connection['last_error'])
        mgr._stop_event.set()
    mgr._disconnect = disconnected
    await asyncio.wait_for(mgr.start(), 0.3)
    assert observed[0]['code'] == 'connection_timeout'
    assert observed[0]['stage'] == 'waiting'


def test_newer_pending_status_cannot_be_followed_by_an_old_queued_status():
    import json
    from ha_server import SSEEmitter
    emitter, queue = SSEEmitter(), asyncio.Queue()
    emitter.add_client(queue)
    emitter.emit('status', {'connection': {'phase': 'connecting'}})
    emitter.emit('port_update', {'port_id': 1})
    emitter.emit('status', {'connection': {'phase': 'retry_wait'}})
    latest = json.loads(emitter.flush_status(queue))
    assert latest['connection']['phase'] == 'retry_wait'
    while not queue.empty():
        assert json.loads(queue.get_nowait())['type'] != 'status'
    emitter.remove_client(queue)


async def test_automatic_rebuild_preserves_failure_and_does_not_cancel_itself():
    from golden_harness import golden_env
    async with golden_env(devices=[{'id': 'desk', 'mac': 'AA:BB:CC:DD:EE:02', 'token': '11' * 16}]) as env:
        rt = env.server.registry.get('desk')
        await rt.manager._set_connection_feedback(phase='retry_wait', last_error={
            'code': 'authentication_failed', 'stage': 'authenticating', 'occurred_at': 1})
        rebuilt = asyncio.Event()
        async def resources(runtime):
            assert runtime.state.connection['last_error']['code'] == 'authentication_failed'
            await env.server._rebuild_device_resources(runtime)
            rebuilt.set()
        await rt.supervisor.schedule_rebuild(resources)
        await asyncio.wait_for(rebuilt.wait(), 0.3)
        assert rt.supervisor.is_running
        assert rt.state.connection['last_error']['code'] == 'authentication_failed'
