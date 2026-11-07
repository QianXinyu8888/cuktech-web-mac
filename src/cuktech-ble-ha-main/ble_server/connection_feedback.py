"""Stable connection diagnostics; raw platform exceptions stay in service logs."""
from copy import deepcopy


def initial_connection_feedback():
    return {
        'phase': 'disabled', 'attempt_id': 0, 'attempt_started_at': None,
        'last_error': None, 'retry_at': None,
    }


def copy_connection_feedback(value):
    return deepcopy(value)


def classify_connection_error(error, stage):
    if isinstance(error, TimeoutError):
        return 'connection_timeout'
    reason = getattr(getattr(error, 'reason', None), 'name', '')
    if reason.startswith('DENIED_BY_'):
        return 'permission_denied'
    if reason == 'POWERED_OFF':
        return 'bluetooth_off'
    if reason in ('NO_BLUETOOTH', 'NO_BLE_CENTRAL_ROLE', 'UNKNOWN'):
        return 'adapter_unavailable'
    # Wrapped scanning errors preserve their cause; inspect it before a generic wrapper.
    if error.__cause__ is not None:
        return classify_connection_error(error.__cause__, stage)
    message = str(error).lower()
    if isinstance(error, PermissionError) or any(word in message for word in (
            'not authorized', 'unauthorized', 'not authorised', 'permission denied',
            'bluetooth access is denied', 'bluetooth access is restricted', 'cbmanagerstateunauthorized')):
        return 'permission_denied'
    if any(word in message for word in (
            'powered_off', 'powered off', 'turned off', 'no powered bluetooth',
            'cbmanagerstatepoweredoff')):
        return 'bluetooth_off'
    if any(word in message for word in (
            'no bluetooth adapters', 'no bluetooth adapter', 'bluetooth is not supported',
            'bluetooth is unsupported', 'cbmanagerstateunsupported')):
        return 'adapter_unavailable'
    if any(word in message for word in (
            'org.bluez.error.inprogress', 'operation already in progress',
            'resource busy', 'device or resource busy')):
        return 'bluetooth_busy'
    if 'charger not found' in message:
        return 'device_not_found'
    if type(error).__name__ == 'AuthConnectionError':
        return 'authentication_failed'
    if stage == 'connected':
        return 'connection_lost'
    return 'connection_failed'
