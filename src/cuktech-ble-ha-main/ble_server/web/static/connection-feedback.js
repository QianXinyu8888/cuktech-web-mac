/* Shared, per-device connection feedback. Server diagnostics remain authoritative. */
(function (global) {
    'use strict';
    var active = ['waiting', 'scanning', 'connecting', 'authenticating'];
    function t(key) { return global.I18N.t(key); }
    function describe(bucket) {
        bucket = bucket || {};
        var c = bucket.connection;
        var phase = c ? c.phase : (bucket.connected && bucket.authenticated ? 'connected' : 'disabled');
        var working = active.indexOf(phase) >= 0;
        var error = c && c.last_error;
        var text = [];
        if (phase !== 'connected' && phase !== 'disabled') {
            if (error) {
                var codes = ['bluetooth_off','permission_denied','adapter_unavailable','bluetooth_busy','device_not_found','connection_timeout','authentication_failed','connection_lost','connection_failed'];
                text.push(t('connectionFeedback.' + (codes.indexOf(error.code) >= 0 ? error.code : 'connection_failed')));
            }
            text.push(t('connectionFeedback.' + (working && error ? 'retrying' : phase)));
        }
        if (bucket.communicationError) text.push(t('connectionFeedback.serviceUnavailable'));
        return {text:text.join(' '), action:phase === 'connected' || working ? 'stop' : phase === 'retry_wait' ? 'retry' : 'connect', working:working, phase:phase};
    }
    function render(container, connection, communicationError) {
        if (!container) return;
        var text = describe({connection:connection,communicationError:communicationError}).text;
        container.setAttribute('aria-live','polite');
        container.setAttribute('role','status');
        if (container.textContent !== text) container.textContent = text;
        container.hidden = !text;
    }
    function refresh() {
        if (!global.document) return;
        var b = global.DeviceStore.get(global.DeviceStore.current());
        var d = describe(b);
        render(global.document.getElementById('connectionFeedback'), b.connection, b.communicationError);
        var btn = global.document.getElementById('bleToggle') || global.document.getElementById('connectBtn');
        if (!btn) return;
        btn.disabled = !!b.connectionRequest;
        btn.dataset.connectionAction = d.action;
        btn.textContent = t(d.action === 'retry' ? 'connectionFeedback.retry' : d.action === 'stop' ? (d.working || d.phase === 'retry_wait' ? 'connectionFeedback.stop' : 'common.disconnect') : 'common.connect');
        var stop = global.document.getElementById('connectionStop');
        if (stop) { stop.hidden = d.phase !== 'retry_wait'; stop.disabled = !!b.connectionRequest; stop.textContent = t('connectionFeedback.stop'); }
    }
    async function exchange(fetcher) {
        var controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
        var timer;
        try {
            return await Promise.race([
                (async function () {
                    var res = await fetcher(controller ? controller.signal : undefined);
                    var data = await res.json();
                    if (!res.ok || !data || data.ok === false || data.error) throw new Error('request rejected');
                    return data;
                })(),
                new Promise(function (_, reject) {
                    timer = global.setTimeout(function () {
                        if (controller) controller.abort();
                        reject(new Error('service timeout'));
                    }, 10000);
                })
            ]);
        } finally { global.clearTimeout(timer); }
    }
    function communicationFailed(id, revision) {
        var store = global.DeviceStore, b = store.get(id);
        if ((b.feedbackRevision || 0) !== revision) return false;
        b.communicationError = true;
        if (store.current() === id) refresh();
        return true;
    }
    async function request(action) {
        var store = global.DeviceStore, id = store.current(), b = store.get(id);
        if (b.connectionRequest) return;
        action = action || describe(b).action;
        b.connectionRequest = true;
        refresh();
        var revision = b.feedbackRevision || 0;
        try {
            // api captures the current device synchronously, before the first await.
            await exchange(function (signal) {
                return store.api('/api/enable', {method:'POST', signal:signal, headers:{'Content-Type':'application/json'}, body:JSON.stringify(action === 'stop' ? {enabled:false} : action === 'retry' ? {enabled:true,retry:true} : {enabled:true})});
            });
            b.communicationError = false;
            // A snapshot started before a newer SSE must never roll the device back.
            revision = b.feedbackRevision || 0;
            var url = new URL('/api/status', global.location.origin); url.searchParams.set('device',id);
            if (!store.isPreviewId(id)) {
                var snapshot = await exchange(function (signal) { return global.fetch(url.toString(), {signal:signal}); });
                if ((b.feedbackRevision || 0) === revision) store.dispatch(Object.assign({}, snapshot, {type:'status',device:id}));
            }
        } catch (e) { communicationFailed(id, revision); }
        finally { b.connectionRequest = false; if (store.current() === id) refresh(); }
    }
    global.ConnectionFeedback = {describe:describe,render:render,refresh:refresh,request:request,communicationFailed:communicationFailed};
    if (global.I18N && global.I18N.onChange) global.I18N.onChange(refresh);
})(typeof window !== 'undefined' ? window : this);
