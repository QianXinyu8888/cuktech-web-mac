(function (global) {
    'use strict';
    function en() { return (global.I18N?.getLocale?.() || '').startsWith('en'); }
    function text(zh, english) { return en() ? english : zh; }
    function status(p) {
        if (p && p.enabledKnown === true && p.enabled === false) return text('端口已关闭', 'Port off');
        if (!p || p.valid === false) return text('暂无数据', 'No data');
        if (p.enabledKnown !== false && p.enabled === false) return text('端口已关闭', 'Port off');
        return Number(p.power ?? p.w ?? 0) > 0 ? text('正在供电', 'Supplying power') : text('空闲', 'Idle');
    }
    function protocol(p) { return p && p.valid !== false && !(p.enabledKnown !== false && p.enabled === false) && Number(p.power ?? p.w ?? 0) > 0 && p.protocol && p.protocol !== 'idle' ? p.protocol : ''; }
    function automation(entry, fresh, armed, permanent) {
        if (!armed) return '';
        if (fresh === false) return text('状态未更新：请检查网关连接。', 'Status unavailable: check the gateway connection.');
        if (entry?.error === 'limit_restart_unavailable') return text('限额已暂停：网关重启后请重新设置。', 'Limit paused after gateway restart; set it again.');
        if (entry?.error === 'sample_unavailable') return text('自动化暂停：暂无有效读数。', 'Automation paused: readings unavailable.');
        if (entry?.error === 'port_state_unknown') return text('等待确认端口状态，自动关闭暂不可用。', 'Waiting for port state; automatic shutdown unavailable.');
        if (entry?.error) return text('自动化异常，请检查设备状态。', 'Automation error; check the device.');
        if (permanent) return text('长期供电模式已启用', 'Continuous supply mode enabled');
        if (entry?.pending) return text('正在执行自动关闭…', 'Automatic shutdown in progress…');
        if (entry?.fired) return text('已触发自动关闭。', 'Automatic shutdown triggered.');
        return text('自动化运行中', 'Automation active');
    }
    function confirmOff(port) {
        var message = text('关闭 '+port.toUpperCase()+' 将中断该端口的供电。', 'Turning off '+port.toUpperCase()+' will interrupt power to this port.');
        var dialog = document.createElement('dialog');
        if (typeof dialog.showModal !== 'function') return Promise.resolve(global.confirm(message));
        dialog.className='port-confirm-dialog';
        var title=document.createElement('h2'),desc=document.createElement('p'),actions=document.createElement('div');
        var cancel=document.createElement('button'),ok=document.createElement('button');
        title.textContent=text('确认关闭端口？','Turn off this port?');desc.textContent=message;
        cancel.textContent=text('取消','Cancel');ok.textContent=text('关闭端口','Turn off');
        cancel.type=ok.type='button';actions.className='port-confirm-actions';actions.append(cancel,ok);dialog.append(title,desc,actions);document.body.append(dialog);
        return new Promise(function(resolve){var done=false;function finish(value){if(done)return;done=true;dialog.close();dialog.remove();resolve(value);}cancel.onclick=function(){finish(false);};ok.onclick=function(){finish(true);};dialog.oncancel=function(e){e.preventDefault();finish(false);};dialog.showModal();cancel.focus();});
    }
    global.PortUI={status:status,protocol:protocol,automation:automation,confirmOff:confirmOff,text:text};
})(window);
