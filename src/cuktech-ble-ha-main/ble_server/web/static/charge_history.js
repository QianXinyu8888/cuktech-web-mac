// ── Charge History Module (shared between phone.html and index.html) ──
const API = window.location.origin;
let _sessionChart = null;

// 统一请求出口：多设备时按当前设备取数（device-store.js 负责拼 ?device=）。
// 缺了它（别的嵌入页没引 device-store）就退回裸 fetch —— 单设备语义不变。
function chApi(path, opts) {
    return (typeof DeviceStore !== 'undefined' && DeviceStore.api)
        ? DeviceStore.api(path, opts)
        : fetch(path, opts);
}

function chCurrentDevice() {
    return (typeof DeviceStore !== 'undefined' && DeviceStore.current)
        ? DeviceStore.current()
        : 'default';
}

// Format timestamp to local time string
function fmtTime(ts) {
    if (!ts) return '--';
    const d = new Date(ts * 1000);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const isToday = d >= today;
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    if (isToday) return `${h}:${m}`;
    const yesterday = new Date(today - 86400000);
    if (d >= yesterday) return I18N.t('charge.yesterdayTime', { time: `${h}:${m}` });
    return `${d.getMonth()+1}/${d.getDate()} ${h}:${m}`;
}

function fmtDuration(sec) {
    if (!sec) return '--';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h > 0 ? `${h}h${m}m` : `${m}min`;
}

// 会话行 / 详情里的文本都来自 DB 与设备上报，进 innerHTML 与属性前一律转义。
// （onclick 的函数名另有白名单校验，两者不是同一件事。）
function esc(v) {
    return String(v === undefined || v === null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── 设备识别展示 ──
// 后端只会给"推测"（按峰值功率/电压档/协议）或"用户标记过的签名"，两者视觉上
// 必须能区分：实线 chip = 你起过名字的设备，虚线 chip + "推测" = 算法猜的。
// 语言包缺 key 时 I18N.t 会原样返回 key，退回服务端给的 label 兜底。
function _devText(key, fallback) {
    var v = I18N.t(key);
    return (v && v.indexOf('charge.') !== 0) ? v : (fallback || '');
}

function deviceChipHtml(device) {
    if (!device) return '';
    var cls = _devText('charge.devClass.' + device.cls, device.cls_label || '');
    var brand = (device.brand && device.brand !== 'unknown')
        ? _devText('charge.devBrand.' + device.brand, device.brand_label || '')
        : '';
    var labeled = device.source === 'labeled' && device.name;
    var text = labeled
        ? device.name
        : ([cls, brand].filter(Boolean).join(' · ') || _devText('charge.devClass.unknown', '未知设备'));
    var src = labeled ? '' : '<span class="dev-src">' + esc(I18N.t('charge.guessedTag')) + '</span>';
    var title = labeled ? I18N.t('charge.deviceLabeled') : I18N.t('charge.deviceGuessed');
    return '<span class="dev-chip ' + (labeled ? 'is-labeled' : 'is-guess') + '" title="' + esc(title) + '">'
        + esc(text) + src + '</span>';
}

// 详情浮层里当前展示的设备（标记时要拿它的旧名字做输入框初值）
var _currentDevice = null;
var _currentProtocols = '';
// 详情浮层当前展示的整条会话（分享报告卡的数据源，openShareCard 消费）
var _lastDetail = null;

function renderDeviceStrip(device, protocolsStr) {
    _currentDevice = device || null;
    var chip = document.getElementById('sdDeviceChip');
    if (chip) {
        if (!device) {
            chip.className = 'dev-chip is-guess';
            chip.textContent = '--';
            chip.removeAttribute('title');
        } else {
            // 借用同一套 chip 结构，但写入的是**已有的**元素（不替换节点，
            // 否则下一次再取 sdDeviceChip 就取不到了）
            var tmp = document.createElement('span');
            tmp.innerHTML = deviceChipHtml(device);
            var fresh = tmp.firstChild;
            if (fresh) {
                chip.className = fresh.className;
                chip.innerHTML = fresh.innerHTML;
                chip.title = fresh.getAttribute('title') || '';
            }
        }
    }
    var protos = document.getElementById('sdProtocols');
    if (protos) {
        protos.textContent = protocolsStr
            ? I18N.t('charge.protocolLabel') + ': ' + protocolsStr
            : '';
    }
    // 命名框常驻（不再折叠）：打开一条会话就把"这台设备已标记的名字"直接
    // 回填进输入框，用户看到的 chip 和框里永远是同一个名字。
    var input = document.getElementById('sdLabelInput');
    if (input) {
        var labeledName = (device && device.source === 'labeled' && device.name) ? device.name : '';
        if (document.activeElement !== input) input.value = labeledName;
    }
}

// 手动改名收在"标记设备"折叠按钮后面（平时隐藏保持顶部简洁；
// 设备名主要来自"充满预测"里选型号时的自动联动）。
function toggleDeviceLabel() {
    var row = document.getElementById('sdLabelRow');
    var input = document.getElementById('sdLabelInput');
    if (!row) return;
    var show = row.style.display === 'none';
    row.style.display = show ? 'flex' : 'none';
    if (show && input) {
        var labeledName = (_currentDevice && _currentDevice.source === 'labeled'
            && _currentDevice.name) ? _currentDevice.name : '';
        input.value = labeledName;
        input.focus();
        input.onkeydown = function (e) {
            if (e.key === 'Enter') { e.preventDefault(); saveDeviceLabel(); }
        };
    }
}

async function saveDeviceLabel() {
    var input = document.getElementById('sdLabelInput');
    if (!input || _currentSessionId == null) return;
    var name = (input.value || '').trim();
    try {
        var res = await chApi(API + '/api/sessions/' + _currentSessionId + '/label', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name })
        });
        var data = await res.json();
        if (!data || !data.ok) throw new Error((data && data.error) || 'label failed');
        renderDeviceStrip(data.device, _currentProtocols);
        // 保存成功后把折叠行收回去（它平时就该是隐藏的）
        var row = document.getElementById('sdLabelRow');
        if (row) row.style.display = 'none';
        // 列表里同签名的会话立刻跟着改名（不清缓存看不出效果）
        if (typeof refreshChargeHistory === 'function') refreshChargeHistory(true);
    } catch (e) {
        console.error('save device label failed:', e);
    }
}

// Fetch energy stats（周期 + 端口/设备筛选）
async function fetchEnergyStats(period) {
    try {
        let url = `${API}/api/energy/stats?period=${period || 'today'}`;
        if (_chFilterPort) url += `&port=${_chFilterPort}`;
        // device_label：设备名筛选。不能叫 device=——那是多设备路由的保留参数。
        if (_chFilterDevice) url += `&device_label=${encodeURIComponent(_chFilterDevice)}`;
        const res = await chApi(url);
        return await res.json();
    } catch (e) { return { total_wh: 0, session_count: 0, avg_power_w: 0 }; }
}

// Fetch sessions list（端口 / 设备筛选随请求带上）
async function fetchSessions(port, period, limit, page) {
    try {
        let url = `${API}/api/sessions?period=${period || 'today'}&limit=${limit || 10}&page=${page || 1}`;
        const p = port || _chFilterPort;
        if (p) url += `&port=${p}`;
        if (_chFilterDevice) url += `&device_label=${encodeURIComponent(_chFilterDevice)}`;
        const res = await chApi(url);
        return await res.json();
    } catch (e) { return { sessions: [], total: 0, page: 1, pages: 1 }; }
}

let _dsTarget = 300;
let _currentSessionId = null;
// 长期供电（常供）会话的详情：
//   _dsPermanent 当前详情是不是常供会话（服务端返回为准）
// 常供曲线只在内存里保留 1 小时，且界面**不再提供窗口长度/左右滑动**——
// 永远取"服务端能给的整段"（缺省窗口=内存保留时长）并贴最新，
// 所以这里不再有窗口宽度/右端状态。
let _dsPermanent = false;
let _dsReqToken = 0; // 详情请求序号：丢弃乱序返回的旧响应

function setDownsample(target) {
    _dsTarget = parseInt(target) || 0;
    if (_currentSessionId) showSessionDetail(_currentSessionId);
}

// 常供会话的曲线只在内存里留 1 小时，且**没有窗口长度/滑动控件**：
// 永远取服务端能给的整段并贴最新（见 fetchSessionPoints）。所以这里只剩一件事要
// 说明——"这次会话没有采样曲线"（只存了统计）。那张图区高度就是弹窗里最大的
// 一块空白，没有曲线时应当把它整个收起来，只留这行说明。
function ensureNoCurveNote(show) {
    const detail = document.getElementById('sessionDetail');
    if (!detail) return null;
    let note = document.getElementById('sdNoCurveNote');
    if (!note) {
        note = document.createElement('div');
        note.id = 'sdNoCurveNote';
        note.className = 'sd-no-curve';
        // 插到"标题行所在的那个容器"里、紧跟标题之后（图表区之前）。
        // 不能按 #sessionDetail 的子节点算：桌面标题行在 .sd-sheet 内部，
        // 插到 detail 下会落到弹窗外边，文字永远看不见。
        const head = detail.querySelector('.sd-head') || detail.firstElementChild;
        const host = (head && head.parentNode) || detail;
        host.insertBefore(note, head ? head.nextSibling : host.firstChild);
    }
    if (note.dataset.key !== 'noCurve') {
        note.dataset.key = 'noCurve';
        note.textContent = I18N.t('charge.noCurve');
    }
    note.style.display = show ? '' : 'none';
    return note;
}

// 详情里"只对曲线有意义"的控件（精度下拉 / 导出 CSV）：没有采样点时必须收起。
//   · 常供会话的曲线只留在内存（不落库），导出端点读的是库 → 导出的是一张空表；
//     精度（下采样）也只作用在曲线上，没有曲线时它调不动任何东西。
//   · 没有任何采样点的会话（0Wh 已被清理）同理。
// 两页都靠标记类挂钩子（.sd-curve-only）：桌面是"精度"整块 + 导出按钮，
// 手机只有"精度"那一行（该页详情本来就没有导出按钮）。
function setCurveControlsVisible(visible) {
    document.querySelectorAll('.sd-curve-only').forEach(function (el) {
        if (el.style) el.style.display = visible ? '' : 'none';
    });
}

// 没有曲线时把图表区整个收起来（它的定高就是那块大空白）；有曲线时恢复。
// 桌面是 .sd-chart 容器、手机是内联定高的 canvas 父节点，都从 canvas 往上找。
function setSessionChartVisible(visible) {
    const chart = document.getElementById('sessionChart');
    if (!chart) return;
    const box = chart.parentNode;
    if (box && box.style) box.style.display = visible ? '' : 'none';
}

function showSessionDetailEmpty(permanent, stats, noCurve) {
    const detail = document.getElementById('sessionDetail');
    if (!detail) return;
    detail.style.display = 'block';
    const el = (id) => document.getElementById(id);
    const startTs = stats && stats.start_time ? stats.start_time : null;
    const endTs = stats && stats.end_time ? stats.end_time : null;
    if (el('sdTitle')) {
        if (permanent) {
            el('sdTitle').textContent =
                `${I18N.t('charge.permanentWindow')}${startTs ? ' · ' + fmtTime(startTs) : ''}`;
        } else if (startTs) {
            el('sdTitle').textContent = `${fmtTime(startTs)}${endTs ? ' → ' + fmtTime(endTs) : ''}`;
        } else {
            el('sdTitle').textContent = '--';
        }
    }
    if (el('sdDuration')) el('sdDuration').textContent = stats ? fmtDuration(stats.duration_sec) : '--';
    // 指标要么全填、要么全清：只填一半的话，上一个会话的 Wh/W/V/A 会挂在新标题下面
    const metricIds = ['sdEnergy', 'sdAvgP', 'sdPeakP', 'sdMinP', 'sdAvgV', 'sdAvgI'];
    if (stats) {
        if (el('sdEnergy')) el('sdEnergy').textContent = (stats.total_wh || 0).toFixed(1);
        if (el('sdAvgP')) el('sdAvgP').textContent = (stats.avg_power_w || 0).toFixed(1);
        if (el('sdPeakP')) el('sdPeakP').textContent = (stats.peak_power_w || 0).toFixed(1);
        if (el('sdMinP')) el('sdMinP').textContent = stats.min_power_w > 0 ? stats.min_power_w.toFixed(1) : '--';
        if (el('sdAvgV')) el('sdAvgV').textContent = (stats.avg_voltage || 0).toFixed(1);
        if (el('sdAvgI')) el('sdAvgI').textContent = (stats.avg_current || 0).toFixed(2);
        _currentProtocols = stats.protocols || '';
        renderDeviceStrip(stats.device || null, _currentProtocols);
        // 分享报告卡的数据源：详情浮层当前展示的这条会话（与界面同口径的统计值）
        _lastDetail = {
            sid: _currentSessionId,
            port: stats.port,
            start: stats.start_time,
            end: stats.end_time,
            duration: stats.duration_sec || 0,
            energy: stats.total_wh || 0,
            avgPower: stats.avg_power_w || 0,
            peak: stats.peak_power_w || 0,
            minP: stats.min_power_w > 0 ? stats.min_power_w : 0,
            avgV: stats.avg_voltage || 0,
            avgI: stats.avg_current || 0,
            protocols: stats.protocols || '',
            device: stats.device || null,
            points: [],
            permanent: !!permanent,
            // 电量口径（会话行上的快照，不是档案现值）
            isActive: !!stats.is_active,
            powerNow: stats.power_now || 0,
            startPct: _chPct(stats.start_pct),
            capWh: _chNum(stats.cap_wh) || 0,
            pctWh: _chNum(stats.pct_wh) || 0,
        };
        _refreshDetailPctChip();
        applySessionBattery(stats);
    } else {
        metricIds.forEach((id) => { if (el(id)) el(id).textContent = '--'; });
        _currentProtocols = '';
        renderDeviceStrip(null, '');
    }
    if (_sessionChart) { _sessionChart.destroy(); _sessionChart = null; }
    setSessionChartVisible(false);      // 没有曲线：收起定高的图表区（最大一块空白）
    ensureNoCurveNote(!!noCurve);
    setCurveControlsVisible(false);     // 没有曲线：精度下拉与导出按钮一并收起
}

// Fetch session detail points
async function fetchSessionPoints(sessionId) {
    try {
        const q = [];
        if (_dsTarget > 0) q.push(`downsample=${_dsTarget}`);
        // 常供会话不再传 window/to：服务端缺省就是"内存保留时长（1 小时）+ 贴最新"，
        // 界面也没有窗口控件可以改变它。
        const res = await chApi(`${API}/api/sessions/${sessionId}/points${q.length ? '?' + q.join('&') : ''}`);
        // fetch 不对 4xx/5xx reject：不检查 status 的话，服务端 400（例如 to 越界）
        // 的错误体会被当成正常响应解析，面板静默变空白且没有任何提示。
        // 返回 null 让调用方区分"加载失败"与"这次会话真的没有点"。
        if (!res.ok) return null;
        return await res.json();
    } catch (e) { return null; }
}

// Render stats summary
function renderStats(containerId, stats) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const s = `color:var(--text)`;
    const l = `color:var(--text-dim)`;
    el.innerHTML = `
        <div class="mini-stat"><div class="mini-stat-value" style="${s}">${stats.total_wh ? stats.total_wh.toFixed(1) : '0'}</div><div class="mini-stat-label" style="${l}">${I18N.t('charge.totalWh')}</div></div>
        <div class="mini-stat"><div class="mini-stat-value" style="${s}">${stats.session_count || 0}</div><div class="mini-stat-label" style="${l}">${I18N.t('charge.sessionCount')}</div></div>
        <div class="mini-stat"><div class="mini-stat-value" style="${s}">${stats.avg_power_w ? stats.avg_power_w.toFixed(1) : '0'}</div><div class="mini-stat-label" style="${l}">${I18N.t('charge.avgPower')}</div></div>
        <div class="mini-stat"><div class="mini-stat-value" style="${s}">${stats.peak_power_w ? stats.peak_power_w.toFixed(1) : '0'}</div><div class="mini-stat-label" style="${l}">${I18N.t('charge.peakPower')}</div></div>`;
}

// Render session list
function renderSessionList(containerId, sessions, onClick) {
    const el = document.getElementById(containerId);
    if (!el) return;
    // Filter out orphaned sessions: no end_time and not currently active,
    // or ended with 0Wh (data was lost before protocol column was added)
    const filtered = (sessions || []).filter(s => {
        if (s.is_active) return true;
        if (!s.end_time) return false;
        if (!s.total_wh || s.total_wh <= 0) return false;
        return true;
    });
    if (filtered.length === 0) {
        el.innerHTML = `<div class="session-empty" style="text-align:center;color:var(--text-dim);padding:16px;font-size:13px;">${I18N.t('charge.noRecords')}</div>`;
        return;
    }
    const portNames = {1:'C1', 2:'C2', 3:'C3', 4:'A'};
    // Use page-specific port colors: phone.html has PORT_COLORS, index.html has CSS vars
    let portColors;
    if (typeof PORT_COLORS !== 'undefined') {
        portColors = {1: PORT_COLORS.c1, 2: PORT_COLORS.c2, 3: PORT_COLORS.c3, 4: PORT_COLORS.a};
    } else {
        const cs = getComputedStyle(document.documentElement);
        portColors = {
            1: cs.getPropertyValue('--port-c1').trim() || '#03a9f4',
            2: cs.getPropertyValue('--port-c2').trim() || '#7c4dff',
            3: cs.getPropertyValue('--port-c3').trim() || '#389e3d',
            4: cs.getPropertyValue('--port-a').trim() || '#ffa42b',
        };
    }
    let html = filtered.map(s => {
        const proto = s.protocol || '';
        const protoHtml = proto ? `<span style="font-size:11px;color:var(--accent-ink);margin-left:6px;">${esc(proto)}</span>` : '';
        // 这次充的是什么：已标记显示真名，未标记显示"手机 · 苹果系（推测）"
        const devChip = deviceChipHtml(s.device);
        const isActive = s.is_active;
        // 电量口径：正在充电给"约多久充满"，充完给"从 % 到 %"。
        // 只在用户给这台设备填过容量（或本会话填过）时才有——协议读不到电量，
        // 没有分母就算不出百分比，宁可不显示也不编一个数出来。
        const pct = sessionPctSummary(s);
        const pctHtml = pct
            ? `<span class="sess-pct ${pct.cls || ''}" title="${esc(pct.title || '')}">${esc(pct.text)}</span>`
            : '';
        // 长期供电状态只在"充电量限额"卡里体现，记录行不加徽标（行本身仍可点开
        // 窗口详情：permanent 标记通过 data-* 传给详情浮层，不参与视觉渲染）。
        const isPerm = !!s.permanent;
        const wh = (s.total_wh && s.total_wh > 0) ? s.total_wh.toFixed(1) : '0';
        const activeDot = isActive ? `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dot-on,#34C759);margin-right:4px;animation:pulse 1.5s infinite;"></span>` : '';
        // 行原来是 div[onclick]，键盘/读屏用户打不开详情：补 role/tabindex/aria-label + 回车与空格
        const rowLabel = `${portNames[s.port] || s.port} ${fmtTime(s.start_time)} ${I18N.t('charge.energy', { wh })}`;
        // 只有可信的标识符才能拼进 onclick 字符串：那是"可执行代码"不是属性值，
        // 转义引号挡不住注入。非标识符（例如带参数的调用）一律退回默认处理函数。
        const open = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(onClick || '') ? onClick : 'showSessionDetail';
        // 批量模式：整行变成"勾选/取消"，checkbox 与行点击等效；不再打开详情。
        // 行删除按钮只在非批量且已结束的行上出现（活跃会话后端拒绝删除）。
        const delBtn = (!_chBatchMode && !isActive)
            ? `<button type="button" class="sess-del" onclick="event.stopPropagation();chDeleteOne(${s.id})"
                    title="${esc(I18N.t('charge.deleteRow'))}" aria-label="${esc(I18N.t('charge.deleteRow'))}"
                    style="flex-shrink:0;margin-left:6px;width:22px;height:22px;line-height:20px;border-radius:50%;
                           border:1px solid rgba(128,128,128,0.25);background:none;color:var(--text-dim);
                           font-size:13px;cursor:pointer;padding:0;opacity:0.55;"
                    onmouseover="this.style.opacity='1';this.style.color='#e81123';this.style.borderColor='rgba(232,17,35,0.5)'"
                    onmouseout="this.style.opacity='0.55';this.style.color='var(--text-dim)';this.style.borderColor='rgba(128,128,128,0.25)'">&times;</button>`
            : '';
        const checkHtml = _chBatchMode
            ? `<span class="ch-row-check" style="flex-shrink:0;display:inline-flex;align-items:center;margin-right:2px;">
                   <input type="checkbox" ${_chSelected.has(String(s.id)) ? 'checked' : ''}
                          onclick="event.stopPropagation();chToggleSelect(${s.id})"
                          aria-label="${esc(rowLabel)}">
               </span>`
            : '';
        const selStyle = _chSelected.has(String(s.id)) && _chBatchMode
            ? 'background:rgba(3,169,244,0.08);' : '';
        const rowClick = _chBatchMode
            ? `chToggleSelect(${s.id})`
            : `(${open})(this.dataset.id, this.dataset.permanent === '1')`;
        return `
        <div class="session-item" data-id="${s.id}" data-permanent="${isPerm ? 1 : 0}" onclick="${rowClick}"
             role="button" tabindex="0" aria-label="${esc(rowLabel)}"
             onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${rowClick};}"
             style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(128,128,128,0.1);cursor:pointer;border-radius:6px;${selStyle}">
            <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;flex-wrap:wrap;">
                ${checkHtml}
                ${activeDot}
                <div style="width:8px;height:8px;border-radius:50%;background:${portColors[s.port] || '#888'};flex-shrink:0;"></div>
                <span style="font-size:13px;color:var(--text);flex-shrink:0;">${esc(portNames[s.port] || s.port)}</span>
                <span style="font-size:12px;color:var(--text-dim);flex-shrink:0;">${fmtTime(s.start_time)}${!isActive && s.end_time ? ' ~ ' + fmtTime(s.end_time) : ''}</span>
                ${pctHtml}
                ${protoHtml}
                ${devChip}
            </div>
            <span style="display:flex;align-items:center;">
                <span style="font-size:13px;font-weight:600;color:${isActive ? 'var(--success,#34C759)' : 'var(--text)'};flex-shrink:0;margin-left:8px;">${I18N.t('charge.energy', { wh: wh })}</span>
                ${delBtn}
            </span>
        </div>`;
    }).join('');
    if (_chBatchMode) {
        // 批量操作栏：计数实时更新（chToggleSelect 直接改 #chBatchCount 文本）
        html += `<div style="display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:10px 0;font-size:12px;flex-wrap:wrap;">
            <span id="chBatchCount" style="color:var(--text-dim);">${I18N.t('charge.selectedCount', { n: _chSelected.size })}</span>
            <button type="button" id="chDeleteSelected" onclick="chDeleteSelected()" ${_chSelected.size ? '' : 'disabled'}
                style="padding:4px 12px;border-radius:6px;border:1px solid rgba(232,17,35,0.45);background:rgba(232,17,35,0.08);color:#e81123;font-size:12px;cursor:pointer;${_chSelected.size ? '' : 'opacity:0.45;cursor:not-allowed;'}">${I18N.t('charge.deleteSelected')}</button>
            <button type="button" onclick="chToggleBatch()"
                style="padding:4px 12px;border-radius:6px;border:1px solid var(--card-border);background:var(--card-bg);color:var(--text-dim);font-size:12px;cursor:pointer;">${I18N.t('charge.cancelBatch')}</button>
        </div>`;
    }
    el.innerHTML = html;
}

// Show session detail (chart + stats)
async function showSessionDetail(sessionId, permanent) {
    // 面板被关掉再打开同一条会话，用户眼里是"重新打开"，窗口要回到最新；
    // 只按 id 判新会让上次滑到的位置残留下来（closeSessionDetail 没清状态）。
    const detailEl = document.getElementById('sessionDetail');
    const reopened = !detailEl || detailEl.style.display === 'none';
    const isNew = reopened || String(sessionId) !== String(_currentSessionId);
    _currentSessionId = sessionId;
    if (isNew) {
        _dsPermanent = !!permanent;
    } else if (permanent !== undefined) {
        _dsPermanent = !!permanent;
    }
    // 详情里还有精度下拉等控件，点得比往返快时响应可能乱序回来：丢弃不是最后一次
    // 请求的响应，否则统计/曲线会被旧载荷覆盖。
    const reqToken = ++_dsReqToken;
    const data = await fetchSessionPoints(sessionId);
    if (reqToken !== _dsReqToken) return;
    if (!data) return;      // 请求失败：保留上一次的内容，别把面板清空
    // 服务端是常供与否的唯一权威（列表里的标记可能已过时），且必须能双向翻转：
    // 端口中途退出常供后，服务端走 DB 回落分支会给出 permanent=false。
    if ('permanent' in data) _dsPermanent = !!data.permanent;
    const stats = data.stats || null;
    const points = data.points || [];
    if (points.length === 0) {
        // 常供会话不落曲线点：会话结束后只剩统计（活跃但刚起步时也走这里）
        if (stats && (_dsPermanent || stats.start_time)) {
            showSessionDetailEmpty(_dsPermanent, stats, !!data.no_curve);
        }
        return;
    }

    setSessionChartVisible(true);       // 有曲线：恢复图表区并收起"没有曲线"说明
    ensureNoCurveNote(false);
    // 常供会话有曲线（内存窗口）但库里没有点：导出仍是空表，精度也只对库里的点
    // 有意义 → 一并收起
    setCurveControlsVisible(!_dsPermanent);

    const totalWh = points.reduce((sum, p, i) => {
        if (i === 0) return 0;
        const dt = (p.timestamp - points[i-1].timestamp) / 3600;
        return sum + ((points[i-1].power + p.power) / 2) * dt;
    }, 0);
    const spanSec = points[points.length-1].timestamp - points[0].timestamp;
    let peakPower = 0;
    for (let i = 0; i < points.length; i++) {
        if (points[i].power > peakPower) peakPower = points[i].power;
    }
    // 最低带载功率：只算 >0.5W 的点，会话头尾的 0W 不是"充得最低"。曲线可能被
    // 降采样过（默认 300 点），所以服务端统计能给就用它，那个是全量点算的。
    let minPower = 0;
    for (let i = 0; i < points.length; i++) {
        const p = points[i].power;
        if (p > 0.5 && (minPower === 0 || p < minPower)) minPower = p;
    }
    const avgVoltage = points.reduce((s, p) => s + p.voltage, 0) / points.length;
    const avgCurrent = points.reduce((s, p) => s + p.current, 0) / points.length;
    // 协议集合：服务端按整段会话按频次排好序；没有就按点现汇总
    const protocolsStr = (stats && stats.protocols)
        ? stats.protocols
        : Array.from(new Set(points.map(p => (p.protocol || '').trim())
            .filter(p => p && p.toLowerCase() !== 'idle'))).join(', ');

    // 统计口径：常供会话恒用服务端给的**整个会话**统计（窗口里只有最近一段，
    // 按窗口现算会偏小）；普通会话保持原样（活跃会话 DB 行还没写总量，用点现算）。
    const base = stats || null;
    const duration = base ? (base.duration_sec || 0) : spanSec;
    const energy = base ? (base.total_wh || 0) : totalWh;
    const avgPower = base ? (base.avg_power_w || 0)
        : (spanSec > 0 ? (totalWh / (spanSec / 3600)) : 0);
    const peak = base ? (base.peak_power_w || 0) : peakPower;
    const minP = (stats && stats.min_power_w > 0) ? stats.min_power_w : minPower;
    const avgV = base ? (base.avg_voltage || 0) : avgVoltage;
    const avgI = base ? (base.avg_current || 0) : avgCurrent;

    // Show detail panel
    const detail = document.getElementById('sessionDetail');
    if (detail) {
        detail.style.display = 'block';
        const el = (id) => document.getElementById(id);
        const title = _dsPermanent
            ? I18N.t('charge.permanentWindow')
            : `${fmtTime(points[0].timestamp)} → ${fmtTime(points[points.length-1].timestamp)}`;
        if (el('sdTitle')) el('sdTitle').textContent = title;
        if (el('sdDuration')) el('sdDuration').textContent = fmtDuration(duration);
        if (el('sdEnergy')) el('sdEnergy').textContent = energy.toFixed(1);
        if (el('sdAvgP')) el('sdAvgP').textContent = avgPower.toFixed(1);
        if (el('sdPeakP')) el('sdPeakP').textContent = peak.toFixed(1);
        if (el('sdMinP')) el('sdMinP').textContent = minP > 0 ? minP.toFixed(1) : '--';
        if (el('sdAvgV')) el('sdAvgV').textContent = avgV.toFixed(1);
        if (el('sdAvgI')) el('sdAvgI').textContent = avgI.toFixed(2);
        // 设备条：已标记 = 真名，未标记 = 推测类别/品牌家族（带"推测"标记）
        _currentProtocols = protocolsStr;
        renderDeviceStrip((stats && stats.device) || null, protocolsStr);
        // 分享报告卡的数据源：取与浮层显示一致的现算统计（活跃会话 DB 行还没写总量）
        _lastDetail = {
            sid: _currentSessionId,
            port: (stats && stats.port) || null,
            start: points[0].timestamp,
            end: points[points.length - 1].timestamp,
            duration: duration,
            energy: energy,
            avgPower: avgPower,
            peak: peak,
            minP: minP > 0 ? minP : 0,
            avgV: avgV,
            avgI: avgI,
            protocols: protocolsStr,
            device: (stats && stats.device) || _currentDevice || null,
            points: points,
            permanent: _dsPermanent,
            // 电量口径：起点/容量来自会话行，功率取"这一刻"（活跃会话）
            isActive: !!(stats && stats.is_active),
            powerNow: (stats && stats.power_now) || 0,
            startPct: _chPct(stats && stats.start_pct),
            capWh: _chNum(stats && stats.cap_wh) || 0,
            pctWh: _chNum(stats && stats.pct_wh) || 0,
        };
        _refreshDetailPctChip();
        applySessionBattery(stats);

        // Render chart
        renderSessionChart(points);
    }
}

function renderSessionChart(points) {
    const canvas = document.getElementById('sessionChart');
    if (!canvas) return;
    // X 轴刻度：把"索引 → 时间"的换算交给 ticks.callback，而不是预先把标签写进
    // labels 数组。原因：Chart.js 自己决定抽哪几个索引当刻度（autoSkip + maxTicksLimit），
    // 预先按索引打点只有恰好命中它的选择才显示——原来"每 60 点标一个"，300 点档下
    // 只剩 19:37 一个刻度，等于没有横轴。
    const labels = points.map(() => '');
    const tickLabel = (value) => {
        const p = points[value];
        return p ? fmtTime(p.timestamp) : '';
    };
    const powers = points.map(p => p.power);

    // Find protocol transitions for annotations
    const protoChanges = [];
    let lastProto = '';
    points.forEach((p, i) => {
        const proto = p.protocol || '';
        if (proto && proto !== lastProto) {
            protoChanges.push({ index: i, proto });
            lastProto = proto;
        }
    });

    if (_sessionChart) _sessionChart.destroy();
    _sessionChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                data: powers,
                borderColor: 'rgba(3,169,244,0.8)',
                backgroundColor: 'rgba(3,169,244,0.1)',
                borderWidth: 1.5,
                fill: true,
                tension: 0.3,
                pointRadius: 0,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(ctx) {
                            return I18N.t('charge.powerTooltip', { power: ctx.parsed.y.toFixed(1) });
                        },
                        afterLabel: function(ctx) {
                            const p = points[ctx.dataIndex];
                            return p && p.protocol ? I18N.t('charge.protocolTooltip', { protocol: p.protocol }) : '';
                        }
                    }
                }
            },
            scales: {
                x: { display: true, ticks: { maxTicksLimit: 6, font: { size: 10 }, color: 'rgba(128,128,128,0.5)', callback: tickLabel }, grid: { display: false } },
                y: { display: true, ticks: { font: { size: 10 }, color: 'rgba(128,128,128,0.5)' }, grid: { color: 'rgba(128,128,128,0.1)' } }
            },
            interaction: { intersect: false, mode: 'index' }
        },
        plugins: [{
            id: 'protocolLines',
            afterDraw(chart) {
                if (protoChanges.length === 0) return;
                const ctx = chart.ctx;
                const xScale = chart.scales.x;
                const yScale = chart.scales.y;
                protoChanges.forEach(c => {
                    if (c.index === 0) return;
                    const x = xScale.getPixelForValue(c.index);
                    // 主题判定要同时认两套信号：桌面页（index）用 html[data-appearance]，
                    // 手机页（phone.js）用 body.light。原来只看 body.light，桌面页恒为
                    // isDark=true，于是浅色主题下白线白字画在白底浮层上、协议标注整条看不见。
                    const isDark = document.documentElement.getAttribute('data-appearance') !== 'light'
                        && !document.body.classList.contains('light');
                    const lineColor = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)';
                    const textColor = isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)';
                    ctx.save();
                    ctx.strokeStyle = lineColor;
                    ctx.setLineDash([4, 4]);
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(x, chart.chartArea.top);
                    ctx.lineTo(x, chart.chartArea.bottom);
                    ctx.stroke();
                    ctx.fillStyle = textColor;
                    ctx.font = '10px sans-serif';
                    ctx.fillText(c.proto, x + 3, chart.chartArea.top + 12);
                    ctx.restore();
                });
            }
        }]
    });
}

// Pagination state
let _chPage = 1;
// 每页条数：默认 2（手机端）。桌面端在 startChargeHistoryAutoRefresh 的第 5 个参数里
// 传更大的值（index 页传 4：卡片高度要和右栏配平，行数多了就得压缩别的卡）。
//
// 注意这个数字是"列表里总共显示多少行"：正在充电的会话会插队排在最前面
// （is_active=true），行数不固定——活跃会话一多仍按固定条数取数，卡片就会变高。
// 所以实际请求条数 = _chPageSize - 活跃会话数，由 refreshChargeHistory() 每轮计算。
let _chPageSize = 2;
let _chActiveCount = 0;   // 上一次响应里的活跃会话数（0 = 还没拉过数据）
let _chSignature = '';    // 上一轮渲染的数据指纹：没变就不重写 DOM（否则 hover/焦点会被打断）
let _chStatsSig = '';     // 统计块同理

// ── 筛选（端口 / 设备）与批量删除状态 ──
let _chFilterPort = '';       // '' = 全部端口；'c1'/'c2'/'c3'/'a'
let _chFilterDevice = '';     // '' = 全部设备；否则是设备名
let _chBatchMode = false;     // 批量删除模式：点行变勾选
let _chSelected = new Set();  // 批量模式下选中的会话 id
let _chFiltersPeriod = '';    // 筛选项已经按哪个周期拉过（避免每轮轮询都拉）

const _chPortLabels = { 1: 'C1', 2: 'C2', 3: 'C3', 4: 'A' };

// 指纹前缀：周期 / 页码 / 每页条数 / 语言 / 筛选——任何一项变了都必须重画，
// 哪怕数据一模一样（切语言时中文数据指纹不变，但文案要换）。
function _chSignaturePrefix() {
    const loc = (typeof I18N !== 'undefined' && I18N.getLocale) ? I18N.getLocale() : '';
    return `${window._chPeriod}|${_chPage}|${_chPageSize}|${loc}|${_chFilterPort}|${_chFilterDevice}`;
}

function _chFetchLimit() {
    // 至少取 1 条：活跃会话为 0 时就是完整的 _chPageSize
    return Math.max(1, _chPageSize - _chActiveCount);
}

function closeSessionDetail() {
    const detail = document.getElementById('sessionDetail');
    if (detail) detail.style.display = 'none';
    // 折叠的命名行跟着收起：下次打开别的会话不带上一台的输入状态
    const row = document.getElementById('sdLabelRow');
    if (row) row.style.display = 'none';
    _currentDevice = null;
}

function chGoPage(page) {
    _chPage = page;
    refreshChargeHistory();
}

// ── 筛选（端口 / 设备）──
function chSetFilter(kind, value) {
    if (kind === 'port') _chFilterPort = value || '';
    else _chFilterDevice = value || '';
    _chPage = 1;
    _chSignature = '';
    _chStatsSig = '';
    refreshChargeHistory(true);
}

function _chPortParam(num) {    // 端口号 → API 参数：1 → 'c1'
    return { 1: 'c1', 2: 'c2', 3: 'c3', 4: 'a' }[num] || '';
}

// 拉取筛选下拉的可选项（周期变化 / 强制刷新时才拉，轮询不重拉）
function _chSyncFilterBar(force) {
    const period = window._chPeriod || 'today';
    if (!force && period === _chFiltersPeriod) return;
    _chFiltersPeriod = period;
    chApi(`${API}/api/session-filters?period=${encodeURIComponent(period)}`)
        .then(r => r.json())
        .then(d => {
            if (!d || !d.ok) return;
            const portSel = document.getElementById('chFilterPort');
            const devSel = document.getElementById('chFilterDevice');
            if (portSel) {
                const cur = _chFilterPort;
                portSel.innerHTML = `<option value="">${I18N.t('charge.filterAllPort')}</option>`;
                (d.ports || []).forEach(num => {
                    const p = _chPortParam(num);
                    if (!p) return;
                    const o = document.createElement('option');
                    o.value = p;
                    o.textContent = _chPortLabels[num] || num;
                    portSel.appendChild(o);
                });
                portSel.value = cur;
                _chFilterPort = portSel.value || '';
            }
            if (devSel) {
                const cur = _chFilterDevice;
                devSel.innerHTML = `<option value="">${I18N.t('charge.filterAllDevice')}</option>`;
                (d.devices || []).forEach(name => {
                    const o = document.createElement('option');
                    o.value = name;
                    o.textContent = name;
                    devSel.appendChild(o);
                });
                devSel.value = cur;
                _chFilterDevice = devSel.value || '';
            }
        })
        .catch(() => {});
}

// ── 删除（单条 / 批量 / 清空）──
// 都走 POST /api/sessions/delete 与 /api/sessions/clear；活跃会话后端会跳过
// （BLE 还在往里写采样点），所以按钮只出现在已结束的行上。
function chDeleteOne(id) {
    if (!confirm(I18N.t('charge.confirmDeleteOne'))) return;
    chApi(API + '/api/sessions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [parseInt(id, 10)] })
    }).then(r => r.json()).then(d => {
        if (!d || !d.ok) throw new Error((d && d.error) || 'delete failed');
        _chSignature = '';
        _chStatsSig = '';
        refreshChargeHistory(true);
    }).catch(e => {
        console.error('delete session failed:', e);
        alert(I18N.t('charge.deleteFail'));
    });
}

function chToggleBatch() {
    _chBatchMode = !_chBatchMode;
    _chSelected.clear();
    document.querySelectorAll('.ch-batch-toggle').forEach(b => {
        b.textContent = _chBatchMode
            ? I18N.t('charge.cancelBatch')
            : I18N.t('charge.batchDelete');
    });
    _chSignature = '';
    refreshChargeHistory(true);
}

function chToggleSelect(id) {
    const key = String(id);
    if (_chSelected.has(key)) _chSelected.delete(key);
    else _chSelected.add(key);
    // 只更新这一行的勾选与底部计数，不整卡重画（避免打断滚动位置）
    const item = document.querySelector(`.session-item[data-id="${key}"]`);
    if (item) {
        const cb = item.querySelector('.ch-row-check input');
        if (cb) cb.checked = _chSelected.has(key);
        item.classList.toggle('is-selected', _chSelected.has(key));
    }
    const cnt = document.getElementById('chBatchCount');
    if (cnt) cnt.textContent = I18N.t('charge.selectedCount', { n: _chSelected.size });
    const btn = document.getElementById('chDeleteSelected');
    if (btn) btn.disabled = _chSelected.size === 0;
}

function chDeleteSelected() {
    if (!_chSelected.size) return;
    if (!confirm(I18N.t('charge.confirmDeleteN', { n: _chSelected.size }))) return;
    chApi(API + '/api/sessions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(_chSelected).map(Number) })
    }).then(r => r.json()).then(d => {
        if (!d || !d.ok) throw new Error((d && d.error) || 'delete failed');
        _chSelected.clear();
        _chSignature = '';
        _chStatsSig = '';
        refreshChargeHistory(true);
    }).catch(e => {
        console.error('batch delete failed:', e);
        alert(I18N.t('charge.deleteFail'));
    });
}

function chClearAll() {
    if (!confirm(I18N.t('charge.confirmClear'))) return;
    chApi(API + '/api/sessions/clear', { method: 'POST' })
        .then(r => r.json()).then(d => {
            if (!d || !d.ok) throw new Error((d && d.error) || 'clear failed');
            _chSelected.clear();
            _chSignature = '';
            _chStatsSig = '';
            refreshChargeHistory(true);
        }).catch(e => {
            console.error('clear sessions failed:', e);
            alert(I18N.t('charge.deleteFail'));
        });
}

// Auto-refresh sessions
function startChargeHistoryAutoRefresh(containerId, statsId, period, interval, pageSize) {
    window._chContainerId = containerId;
    window._chStatsId = statsId;
    if (pageSize > 0) _chPageSize = pageSize;
    window._chPeriod = period;
    refreshChargeHistory();
    setInterval(refreshChargeHistory, interval || 30000);
    // SSE: refresh immediately on session completion
    // Listen for CustomEvent dispatched by main SSE handler (avoids second SSE connection)
    if (!window._chSseListening) {
        window._chSseListening = true;
        window.addEventListener('sse-session-end', (e) => {
            // 按设备过滤：列表是按 ?device= 取的，别的设备结束会话与它无关。
            // 不过滤就等于每台设备充完电都把当前设备的列表白刷一遍。
            const dev = (e && e.detail && e.detail.device) || 'default';
            if (dev !== chCurrentDevice()) return;
            refreshChargeHistory();
        });
    }
    // 切换设备 = 换一份历史：页码/详情/指纹/筛选全部作废，否则会把上一台的
    // "第 3 页"和数据指纹带过来，出现该刷新的不刷新、或翻到不存在的页。
    if (!window._chDeviceListening) {
        window._chDeviceListening = true;
        window.addEventListener('device-changed', () => {
            _chPage = 1;
            _chActiveCount = 0;
            _chSignature = '';
            _chStatsSig = '';
            _chFilterPort = '';
            _chFilterDevice = '';
            _chFiltersPeriod = '';
            _chSelected.clear();
            ['chFilterPort', 'chFilterDevice'].forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            _currentSessionId = null;
            closeSessionDetail();
            refreshChargeHistory(true);
        });
    }
}

function refreshChargeHistory(force) {
    const containerId = window._chContainerId;
    const statsId = window._chStatsId;
    const period = window._chPeriod;
    _chSyncFilterBar(force);
    // 实际请求条数 = 目标总行数 - 活跃会话数（活跃会话会插队排在最前面）
    const limit = _chFetchLimit();
    fetchEnergyStats(period).then(stats => {
        // 统计块同理：数字没变就不重画
        const sig = _chSignaturePrefix() + '|stats|' + JSON.stringify(stats);
        if (force || sig !== _chStatsSig) {
            _chStatsSig = sig;
            renderStats(statsId, stats);
        }
    });
    fetchSessions(null, period, limit, _chPage).then(data => {
        // 活跃会话数与上一轮不同（开始充电/充满/换口）：用修正后的条数再取一次，
        // 保证"列表总行数 = _chPageSize"恒成立，卡片高度因此不会跳
        const activeCount = (data.sessions || []).filter(x => x.is_active).length;
        if (activeCount !== _chActiveCount) {
            _chActiveCount = activeCount;
            refreshChargeHistory(force);
            return;
        }
        // 最后一页无数据时自动回退上一页
        if (data.sessions && data.sessions.length === 0 && data.page > 1) {
            _chPage = data.page - 1;
            fetchSessions(null, period, _chFetchLimit(), _chPage).then(data2 => {
                _chSignature = '';
                renderSessionList(containerId, data2.sessions);
                renderPagination(containerId, data2);
            });
            return;
        }
        // 行内容没变就不重建 DOM：轮询只负责"发现变化"，不负责"每轮重画"。
        // 否则每轮 innerHTML 都会打断 hover / 键盘焦点，活跃会话的呼吸点动画也会重启。
        const sig = _chSignaturePrefix() + '|' + JSON.stringify(data.sessions || []);
        if (!force && sig === _chSignature) return;
        _chSignature = sig;
        renderSessionList(containerId, data.sessions);
        renderPagination(containerId, data);
    });
}

function renderPagination(containerId, data) {
    const el = document.getElementById(containerId);
    if (!el || !data.pages || data.pages <= 1) return;
    const pag = document.createElement('div');
    pag.style.cssText = 'display:flex;justify-content:center;align-items:center;gap:8px;padding:10px 0;font-size:12px;';
    const btnStyle = 'padding:4px 10px;border-radius:6px;border:1px solid var(--card-border);background:var(--card-bg);color:var(--text-dim);font-size:11px;';
    const disStyle = btnStyle + 'opacity:0.4;cursor:not-allowed;';
    pag.innerHTML = `
        <button onclick="chGoPage(${Math.max(1, data.page - 1)})" ${data.page <= 1 ? 'disabled' : ''}
            style="${data.page <= 1 ? disStyle : btnStyle}">${I18N.t('charge.prevPage')}</button>
        <span style="color:var(--text-dim);">${data.page} / ${data.pages}</span>
        <button onclick="chGoPage(${Math.min(data.pages, data.page + 1)})" ${data.page >= data.pages - 1 ? 'disabled' : ''}
            style="${data.page >= data.pages - 1 ? disStyle : btnStyle}">${I18N.t('charge.nextPage')}</button>`;
    el.appendChild(pag);
}

// ── Locale change: refresh dynamic charge-history content ──
if (typeof I18N !== 'undefined' && typeof I18N.onChange === 'function') {
    I18N.onChange(function () {
        if (window._chContainerId) {
            refreshChargeHistory();
            if (_currentSessionId) showSessionDetail(_currentSessionId);
        }
    });
}

// ── 分享报告卡：把一次充电渲染成一张适合发微信/朋友圈的 PNG ──
// 纯前端 canvas 绘制（不依赖任何服务端图形库），内容与详情浮层同口径：
// CUKTECH 产品标识 + 风格化的充电器插画（当前端口高亮）+ 关键统计 + 功率曲线。
// 导出途径：保存图片 / 复制图片 / 系统分享（navigator.share，手机上可直发微信）。
// 多风格：6 套配色可实时切换（含彩色光斑款），选择存在 localStorage。

// 配色主题：所有画上去的颜色都从这里取，保证一套布局五种气质。
// 第 0 套是品牌默认：钛灰机身 + 脉冲蓝点缀（酷态科官方品牌色），
// 其余四套是给用户挑的"报告卡皮肤"。
var _SHARE_STYLES = [
    {
        id: 'titan', nameKey: 'charge.shareStyleTitan',
        bgTop: '#1D242E', bgMid: '#12171E', bgBot: '#171D25',
        glow: 'rgba(70,180,255,0.16)', accent: '#5AA9FF',
        main: '#F5F8FC', sub: '#98A5B5', faint: '#7C8896',
        cellFill: 'rgba(255,255,255,0.045)', cellStroke: 'rgba(255,255,255,0.075)',
        grid: 'rgba(255,255,255,0.065)',
        chipGuessFill: 'rgba(255,255,255,0.06)', chipGuessStroke: 'rgba(255,255,255,0.22)',
        chipGuessText: 'rgba(245,248,252,0.85)',
        chipLabFill: 'rgba(90,169,255,0.16)', chipLabStroke: 'rgba(90,169,255,0.6)',
        bodyTop: '#46525F', bodyBot: '#1A212A', bodyStroke: 'rgba(255,255,255,0.16)',
        portOff: '#0C1118', portOffStroke: 'rgba(255,255,255,0.2)',
        bodyLabel: 'rgba(255,255,255,0.62)',
        divider: 'rgba(255,255,255,0.09)',
        curveFill: 'rgba(90,169,255,0.30)', curveFill2: 'rgba(90,169,255,0)',
        peakDotStroke: '#12171E',
    },
    {
        id: 'night', nameKey: 'charge.shareStyleNight',
        bgTop: '#101A31', bgMid: '#0B1220', bgBot: '#0E1A2E',
        glow: 'rgba(53,224,210,0.13)', accent: '#35E0D2',
        main: '#FFFFFF', sub: '#8FA3C0', faint: '#7E92B5',
        cellFill: 'rgba(255,255,255,0.05)', cellStroke: 'rgba(255,255,255,0.07)',
        grid: 'rgba(255,255,255,0.07)',
        chipGuessFill: 'rgba(255,255,255,0.06)', chipGuessStroke: 'rgba(255,255,255,0.22)',
        chipGuessText: 'rgba(255,255,255,0.85)',
        chipLabFill: 'rgba(53,224,210,0.14)', chipLabStroke: 'rgba(53,224,210,0.55)',
        bodyTop: '#253863', bodyBot: '#0E1730', bodyStroke: 'rgba(255,255,255,0.12)',
        portOff: '#0A0F1C', portOffStroke: 'rgba(255,255,255,0.18)',
        bodyLabel: 'rgba(255,255,255,0.55)',
        divider: 'rgba(255,255,255,0.08)',
        curveFill: 'rgba(53,224,210,0.28)', curveFill2: 'rgba(53,224,210,0)',
        peakDotStroke: '#0B1220',
    },
    {
        id: 'light', nameKey: 'charge.shareStyleLight',
        bgTop: '#FFFFFF', bgMid: '#F4F8FC', bgBot: '#EDF3F9',
        glow: 'rgba(2,136,209,0.10)', accent: '#0288D1',
        main: '#16233A', sub: '#5B6B80', faint: '#8A97A8',
        cellFill: '#F3F7FB', cellStroke: '#E1EAF2',
        grid: 'rgba(22,35,58,0.08)',
        chipGuessFill: '#F1F5F9', chipGuessStroke: '#C6D3DE',
        chipGuessText: '#5B6B80',
        chipLabFill: 'rgba(2,136,209,0.10)', chipLabStroke: 'rgba(2,136,209,0.55)',
        bodyTop: '#E9EFF5', bodyBot: '#D7E2EC', bodyStroke: '#C4D2DE',
        portOff: '#FFFFFF', portOffStroke: '#B9C8D4',
        bodyLabel: '#5B6B80',
        divider: 'rgba(22,35,58,0.10)',
        curveFill: 'rgba(2,136,209,0.18)', curveFill2: 'rgba(2,136,209,0)',
        peakDotStroke: '#FFFFFF',
    },
    {
        id: 'orange', nameKey: 'charge.shareStyleOrange',
        bgTop: '#191210', bgMid: '#100B09', bgBot: '#171009',
        glow: 'rgba(255,159,28,0.12)', accent: '#FFA023',
        main: '#FFF6EA', sub: '#C4A98B', faint: '#A08B72',
        cellFill: 'rgba(255,255,255,0.05)', cellStroke: 'rgba(255,159,28,0.15)',
        grid: 'rgba(255,159,28,0.10)',
        chipGuessFill: 'rgba(255,255,255,0.06)', chipGuessStroke: 'rgba(255,159,28,0.35)',
        chipGuessText: 'rgba(255,246,234,0.85)',
        chipLabFill: 'rgba(255,159,28,0.16)', chipLabStroke: 'rgba(255,159,28,0.6)',
        bodyTop: '#2B2018', bodyBot: '#14100B', bodyStroke: 'rgba(255,159,28,0.25)',
        portOff: '#1B140D', portOffStroke: 'rgba(255,159,28,0.3)',
        bodyLabel: 'rgba(255,246,234,0.6)',
        divider: 'rgba(255,159,28,0.15)',
        curveFill: 'rgba(255,159,28,0.30)', curveFill2: 'rgba(255,159,28,0)',
        peakDotStroke: '#100B09',
    },
    {
        id: 'black', nameKey: 'charge.shareStyleBlack',
        bgTop: '#161616', bgMid: '#0D0D0E', bgBot: '#111113',
        glow: 'rgba(232,232,232,0.06)', accent: '#E8E8E8',
        main: '#FFFFFF', sub: '#9A9A9E', faint: '#7A7A80',
        cellFill: 'rgba(255,255,255,0.04)', cellStroke: 'rgba(255,255,255,0.08)',
        grid: 'rgba(255,255,255,0.06)',
        chipGuessFill: 'rgba(255,255,255,0.06)', chipGuessStroke: 'rgba(255,255,255,0.25)',
        chipGuessText: '#DDDDDD',
        chipLabFill: 'rgba(232,232,232,0.10)', chipLabStroke: 'rgba(232,232,232,0.5)',
        bodyTop: '#232326', bodyBot: '#121214', bodyStroke: 'rgba(255,255,255,0.12)',
        portOff: '#0C0C0E', portOffStroke: 'rgba(255,255,255,0.2)',
        bodyLabel: 'rgba(255,255,255,0.5)',
        divider: 'rgba(255,255,255,0.08)',
        curveFill: 'rgba(232,232,232,0.20)', curveFill2: 'rgba(232,232,232,0)',
        peakDotStroke: '#0D0D0E',
    },
    {
        // 彩色：紫→品红→玫瑰的纵向渐变打底，再叠三团彩色氛围光（cyan/珊瑚/薄荷），
        // 适合发朋友圈时想要"有颜色"的那种。光斑坐标是 W/H 的比例值。
        id: 'color', nameKey: 'charge.shareStyleColor',
        bgTop: '#1A0B4E', bgMid: '#6C1FA8', bgBot: '#C24A8A',
        glow: 'rgba(255,209,102,0.16)', accent: '#FFD166',
        main: '#FFFFFF', sub: 'rgba(255,255,255,0.78)', faint: 'rgba(255,255,255,0.58)',
        cellFill: 'rgba(255,255,255,0.10)', cellStroke: 'rgba(255,255,255,0.20)',
        grid: 'rgba(255,255,255,0.14)',
        chipGuessFill: 'rgba(255,255,255,0.10)', chipGuessStroke: 'rgba(255,255,255,0.35)',
        chipGuessText: 'rgba(255,255,255,0.92)',
        chipLabFill: 'rgba(255,209,102,0.20)', chipLabStroke: 'rgba(255,209,102,0.65)',
        bodyTop: '#2B2140', bodyBot: '#161022', bodyStroke: 'rgba(255,255,255,0.20)',
        portOff: '#120C1E', portOffStroke: 'rgba(255,255,255,0.24)',
        bodyLabel: 'rgba(255,255,255,0.62)',
        divider: 'rgba(255,255,255,0.16)',
        curveFill: 'rgba(255,209,102,0.35)', curveFill2: 'rgba(255,209,102,0)',
        peakDotStroke: '#6C1FA8',
        blobs: [
            { x: 0.18, y: 0.16, r: 300, c: 'rgba(0,229,255,0.28)' },
            { x: 0.86, y: 0.42, r: 340, c: 'rgba(255,107,107,0.24)' },
            { x: 0.30, y: 0.82, r: 360, c: 'rgba(64,255,178,0.20)' },
        ],
    },
];

function _shareStyleIdx() {
    try {
        // v2 键：第 0 套换成了品牌钛灰，老键里存的序号会指到别的皮肤上，
        // 换键比"猜用户原来选的是哪套"更干净。
        var v = parseInt(localStorage.getItem('cuk_share_style_v2'), 10);
        if (v >= 0 && v < _SHARE_STYLES.length) return v;
    } catch (e) { /* 隐私模式等拿不到 localStorage：用默认 */ }
    return 0;
}

function _shareSetStyleIdx(i) {
    try { localStorage.setItem('cuk_share_style_v2', String(i)); } catch (e) { }
}

function _shareDeviceText(device) {
    if (!device) return '';
    var cls = _devText('charge.devClass.' + device.cls, device.cls_label || '');
    var brand = (device.brand && device.brand !== 'unknown')
        ? _devText('charge.devBrand.' + device.brand, device.brand_label || '')
        : '';
    if (device.source === 'labeled' && device.name) return device.name;
    return [cls, brand].filter(Boolean).join(' · ')
        || _devText('charge.devClass.unknown', '未知设备');
}

function _shareIsLabeled(device) {
    return !!(device && device.source === 'labeled' && device.name);
}

function _rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// 分享报告复用控制台的设备素材，不再加载宣传海报。
var _shareProductImage = null;
(function () {
    // 素材路径从 charge_history.js 自己的 <script src> 推导：
    // 服务器页（/static/charge_history.js）和 file:// 本地测试都成立，
    // 写死 '/static/...' 在 file:// 下会指到盘符根目录去。
    function scriptDir() {
        try {
            var scripts = document.getElementsByTagName('script');
            for (var i = 0; i < scripts.length; i++) {
                var s = scripts[i].src || '';
                if (s.indexOf('charge_history.js') !== -1) {
                    return s.replace(/charge_history\.js.*$/, 'plugin_imgs/');
                }
            }
        } catch (e) { /* 走默认 */ }
        return '/static/plugin_imgs/';
    }
    var hero = new Image();
    hero.onload = function () { _shareProductImage = hero; };
    hero.src = scriptDir() + 'main_card_ad1204u_unconnected.png';
})();

function _drawCharger(ctx, cx, cy, st) {
    // 保持设备图片比例，在报告的产品区域内居中显示。
    const h = 430, w = Math.round(h * 1080 / 1500);
    const x = cx - w / 2, y = cy - h / 2;
    ctx.save();
    ctx.shadowColor = st.glow;
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 10;
    if (_shareProductImage) {
        _rr(ctx, x, y, w, h, 16);
        ctx.save();
        ctx.clip();
        const ratio = _shareProductImage.naturalWidth / _shareProductImage.naturalHeight;
        const imageW = Math.min(w, h * ratio);
        const imageH = imageW / ratio;
        ctx.drawImage(_shareProductImage, cx - imageW / 2, cy - imageH / 2, imageW, imageH);
        ctx.restore();
        ctx.strokeStyle = st.bodyStroke;
        ctx.lineWidth = 1.5;
        _rr(ctx, x, y, w, h, 16);
        ctx.stroke();
    } else {
        const grad = ctx.createLinearGradient(0, y, 0, y + h);
        grad.addColorStop(0, st.bodyTop);
        grad.addColorStop(1, st.bodyBot);
        _rr(ctx, x, y, w, h, 16);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.strokeStyle = st.bodyStroke;
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }
    ctx.restore();
}

// 充入百分比：>=10% 取整（电池百分比本来就不精确到小数），<10% 保留 1 位
// （小电流补电只充了 3.2%，取整成 3% 看不出差别）。
function _fmtPctShort(v) {
    if (!isFinite(v) || !(v > 0)) return '0';
    if (v >= 10) return String(Math.round(v));
    return String(Math.round(v * 10) / 10);
}

function _shareCardCanvas(st) {
    const d = _lastDetail || {};
    const scale = 2;
    const W = 680;
    const hasCurve = Array.isArray(d.points) && d.points.length > 1;
    const H = hasCurve ? 1215 : 975;
    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    // 背景：纵向渐变 + 顶部氛围光 + 彩色风格的三团光斑
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, st.bgTop);
    bg.addColorStop(0.5, st.bgMid);
    bg.addColorStop(1, st.bgBot);
    _rr(ctx, 0, 0, W, H, 0);
    ctx.fillStyle = bg;
    ctx.fill();
    const glow = ctx.createRadialGradient(W / 2, 120, 0, W / 2, 120, 420);
    glow.addColorStop(0, st.glow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, 420);
    (st.blobs || []).forEach(function (b) {
        const g = ctx.createRadialGradient(b.x * W, b.y * H, 0, b.x * W, b.y * H, b.r);
        g.addColorStop(0, b.c);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
    });

    // 报告标题与设备型号
    ctx.fillStyle = st.main;
    ctx.textBaseline = 'alphabetic';
    ctx.font = '700 34px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(I18N.t('apple.brand'), 48, 78);
    ctx.textAlign = 'right';
    ctx.fillStyle = st.main;
    ctx.font = '700 16px sans-serif';
    ctx.fillText(I18N.t('apple.productName'), W - 48, 76);
    ctx.fillStyle = st.sub;
    ctx.font = '500 12px sans-serif';
    ctx.fillText('AD1204U · 120W · 3C1A', W - 48, 98);

    // 官方海报居左（竖版产品图），右侧留足空隙再排文字（用户要求图字不要太近）
    _drawCharger(ctx, 203, 365, st);

    const rx = 396, rw = W - 48 - rx;
    ctx.textAlign = 'left';
    ctx.fillStyle = st.accent;
    ctx.font = '600 11px sans-serif';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '2.4px';
    ctx.fillText('CHARGE REPORT', rx, 172);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.fillStyle = st.main;
    ctx.font = '700 40px sans-serif';
    ctx.fillText(_devText('charge.shareReport', '充电报告'), rx, 220);

    // 峰值功率：标题正下方、全场最大的数字（用户要求突出峰值功率）
    const portNames = { 1: 'C1', 2: 'C2', 3: 'C3', 4: 'A' };
    const pName = portNames[d.port] || d.port || '';
    ctx.fillStyle = st.main;
    ctx.font = '700 56px sans-serif';
    ctx.fillText((d.peak || 0).toFixed(1) + ' W', rx, 296);
    ctx.fillStyle = st.accent;
    ctx.font = '600 14px sans-serif';
    ctx.fillText(_devText('charge.peakPowerUnit', '峰功率 W')
        + (pName ? ' · ' + pName : ''), rx, 322);

    // 关键信息四行：充电时长 / 充电时间 / 端口 / 协议——标签浅色、数值大字主色
    const ongoing = !d.end;
    const timeVal = `${fmtTime(d.start)}` +
        (ongoing ? ` → ${_devText('charge.shareOngoing', '充电中')}` : ` → ${fmtTime(d.end)}`);
    const infoRows = [
        [_devText('charge.durationLabel', '充电时长'),
            ongoing && !(d.duration > 0) ? _devText('charge.shareOngoing', '充电中')
                : fmtDuration(d.duration || 0)],
        [_devText('charge.timeLabel', '充电时间'), timeVal],
        [_devText('charge.portLabel', '端口'), pName || '—'],
        [_devText('charge.protocolLabel', '协议'),
            (d.protocols || '—').replace(/,\s*/g, ' · ')],
    ];
    let iy = 358;
    infoRows.forEach(function (row) {
        ctx.fillStyle = st.sub;
        ctx.font = '400 14px sans-serif';
        ctx.fillText(row[0], rx, iy);
        // 数值超宽自动缩字号，绝不叠到下一行
        let vFont = 17;
        ctx.font = '600 ' + vFont + 'px sans-serif';
        while (ctx.measureText(row[1]).width > rw - 84 && vFont > 12) {
            vFont -= 1;
            ctx.font = '600 ' + vFont + 'px sans-serif';
        }
        ctx.fillStyle = st.main;
        ctx.fillText(row[1], rx + 84, iy);
        iy += 30;
    });

    // 设备 chip：左对齐，超宽自动缩字号（英文猜测文案可能很长）
    const devText = _shareDeviceText(d.device)
        || _devText('charge.devClass.unknown', '未知设备');
    const labeled = _shareIsLabeled(d.device);
    const chipText = labeled ? devText : devText
        + (devText ? ' (' + _devText('charge.guessedTag', '推测') + ')' : '');
    let chipFont = 19;
    ctx.font = (labeled ? '700 ' : '500 ') + chipFont + 'px sans-serif';
    let cw = ctx.measureText(chipText).width + 44;
    while (cw > rw && chipFont > 13) {
        chipFont -= 1;
        ctx.font = (labeled ? '700 ' : '500 ') + chipFont + 'px sans-serif';
        cw = ctx.measureText(chipText).width + 44;
    }
    _rr(ctx, rx, iy + 6, Math.min(cw, rw), 42, 21);
    ctx.fillStyle = labeled ? st.chipLabFill : st.chipGuessFill;
    ctx.fill();
    ctx.strokeStyle = labeled ? st.chipLabStroke : st.chipGuessStroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = labeled ? st.accent : st.chipGuessText;
    ctx.textBaseline = 'middle';
    ctx.fillText(chipText, rx + 22, iy + 27);
    ctx.textBaseline = 'alphabetic';

    // 统计格 3×2
    // 电量口径：会话配了电池容量（选了机型或手填 Wh）就换算成"充入 %"，百分比比 Wh
    // 直观得多；没配容量时只能给 Wh，否则算出来的比例没有分母。
    const energyWh = _chNum(d.energy) || 0;
    const capWh = _chNum(d.capWh) || 0;
    // 只要配过容量就走百分比口径（哪怕只是 0 Wh 的会话，也应该是 0% 而不是 0Wh）
    const usePct = capWh > 0;
    const stats = [
        usePct
            ? [_fmtPctShort(energyWh / capWh * 100) + '%',
               _devText('charge.sharePctUnit', '充入电量') + ' · ' + energyWh.toFixed(1) + 'Wh']
            : [energyWh ? energyWh.toFixed(1) : '0', _devText('charge.energyUnit', '电量 Wh')],
        [(d.avgPower || 0).toFixed(1), _devText('charge.avgPowerUnit', '均功率 W')],
        [(d.peak || 0).toFixed(1), _devText('charge.peakPowerUnit', '峰功率 W')],
        [(d.minP || 0).toFixed(1), _devText('charge.minPowerUnit', '最低功率 W')],
        [(d.avgV || 0).toFixed(1), _devText('charge.avgVoltageUnit', '均电压 V')],
        [(d.avgI || 0).toFixed(2), _devText('charge.avgCurrentUnit', '均电流 A')],
    ];
    const gx = 48, gy = 612, gap = 12;
    const cw2 = (W - gx * 2 - gap * 2) / 3, ch2 = 88;
    stats.forEach((s, i) => {
        const cx = gx + (i % 3) * (cw2 + gap);
        const cy = gy + Math.floor(i / 3) * (ch2 + gap);
        _rr(ctx, cx, cy, cw2, ch2, 16);
        ctx.fillStyle = st.cellFill;
        ctx.fill();
        ctx.strokeStyle = st.cellStroke;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = st.main;
        ctx.font = '700 30px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(s[0], cx + cw2 / 2, cy + 44);
        ctx.fillStyle = st.sub;
        ctx.font = '400 13px sans-serif';
        ctx.fillText(s[1], cx + cw2 / 2, cy + 68);
    });

    let y = gy + ch2 * 2 + gap + 36; // 曲线区起点（无曲线时这里是协议行起点）

    if (hasCurve) {
        ctx.fillStyle = st.sub;
        ctx.font = '600 15px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(_devText('charge.shareCurve', '功率曲线'), gx, y);
        const chY = y + 18, chH = 170, chW = W - gx * 2;
        // 网格
        ctx.strokeStyle = st.grid;
        ctx.lineWidth = 1;
        for (let i = 0; i <= 3; i++) {
            const ly = chY + (chH / 3) * i;
            ctx.beginPath();
            ctx.moveTo(gx, ly);
            ctx.lineTo(gx + chW, ly);
            ctx.stroke();
        }
        // 曲线
        const pts = d.points;
        const maxP = Math.max(d.peak || 0,
            ...pts.map(p => p.power || 0), 0.001);
        const xy = (p, i) => {
            const t = pts.length > 1 ? i / (pts.length - 1) : 0;
            return [gx + t * chW,
                chY + chH - (Math.min(p.power || 0, maxP) / maxP) * chH];
        };
        const fill = ctx.createLinearGradient(0, chY, 0, chY + chH);
        fill.addColorStop(0, st.curveFill);
        fill.addColorStop(1, st.curveFill2);
        ctx.beginPath();
        pts.forEach((p, i) => {
            const [px, py] = xy(p, i);
            i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
        ctx.strokeStyle = st.accent;
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.lineTo(gx + chW, chY + chH);
        ctx.lineTo(gx, chY + chH);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        // 峰值点标注
        let pkIdx = 0;
        pts.forEach((p, i) => { if ((p.power || 0) > (pts[pkIdx].power || 0)) pkIdx = i; });
        const [pkx, pky] = xy(pts[pkIdx], pkIdx);
        ctx.beginPath();
        ctx.arc(pkx, pky, 5, 0, Math.PI * 2);
        ctx.fillStyle = st.accent;
        ctx.fill();
        ctx.strokeStyle = st.peakDotStroke;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = st.main;
        ctx.font = '700 14px sans-serif';
        ctx.textAlign = pkIdx > pts.length / 2 ? 'right' : 'left';
        // 峰值点贴着曲线区顶端时会撞上"功率曲线"标题，这时改标在点下方
        const labelAbove = pky - chY >= 26;
        ctx.fillText((pts[pkIdx].power || 0).toFixed(1) + ' W',
            pkx + (pkIdx > pts.length / 2 ? -10 : 10),
            pky + (labelAbove ? -10 : 26));
        // 时间轴
        ctx.fillStyle = st.faint;
        ctx.font = '400 13px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(fmtTime(pts[0].timestamp), gx, chY + chH + 22);
        ctx.textAlign = 'right';
        ctx.fillText(fmtTime(pts[pts.length - 1].timestamp), gx + chW, chY + chH + 22);
        ctx.textAlign = 'center';
        y = chY + chH + 50;  // 协议已并入顶部信息区，这里不再重复
    } else {
        y += 0;              // 协议已并入顶部信息区
    }

    y += 16;

    // 页脚
    ctx.strokeStyle = st.divider;
    ctx.beginPath();
    ctx.moveTo(gx, y);
    ctx.lineTo(W - gx, y);
    ctx.stroke();
    const now = new Date();
    const pad = (v) => String(v).padStart(2, '0');
    ctx.fillStyle = st.faint;
    ctx.font = '400 13px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
        + ` ${pad(now.getHours())}:${pad(now.getMinutes())}`, gx, y + 30);
    ctx.textAlign = 'right';
    ctx.fillText(_devText('charge.shareGenerated', 'CUKTECH 智能充电监控'), W - gx, y + 30);

    return canvas;
}

let _shareEls = null;
let _shareCanvas = null;
let _shareBlob = null;   // 打开浮层时预渲染好的 PNG（分享/复制都要求保住用户手势）

function _shareT(key, fallback) {
    var v = I18N.t(key);
    return (v && v.indexOf('charge.') !== 0) ? v : fallback;
}

// 复制/分享都需要"点击手势内"就绪的 Blob：预取好的直接用，没有就在手势内现取
// （ClipboardItem 的 Promise 形式可以合法地延迟到 Blob 就绪）。
function _shareBlobPromise() {
    if (_shareBlob) return Promise.resolve(_shareBlob);
    return new Promise(function (resolve) {
        if (_shareCanvas) _shareCanvas.toBlob(resolve, 'image/png');
        else resolve(null);
    });
}

// 把 PNG 写进系统剪贴板。三级保险，因为"复制成功但粘贴是空的"是最常见的坑：
//   1) 异步剪贴板 API（ClipboardItem 里放**已就绪的 Blob**，不放手势内有风险的 Promise）
//   2) 旧式 execCommand('copy')：把图片放进隐藏可编辑区、整段选中后复制。
//      360/搜狗这类壳浏览器经常在 1) 上"假成功"（Promise resolve 但剪贴板是空的），
//      这条路径走的是老 API，兼容性反而更好。
//   3) 两条都失败就返回 false，由调用方明说"右键图片 → 复制图片"，
//      绝不能再显示"已复制"骗用户。
function _legacyCopyImage(blob) {
    return new Promise(function (resolve) {
        var url = URL.createObjectURL(blob);
        var host = document.createElement('div');
        host.setAttribute('contenteditable', 'true');
        host.style.cssText = 'position:fixed;left:-99999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;';
        var img = document.createElement('img');
        img.src = url;
        host.appendChild(img);
        document.body.appendChild(host);
        var ok = false;
        try {
            var sel = window.getSelection();
            var range = document.createRange();
            range.selectNode(img);
            sel.removeAllRanges();
            sel.addRange(range);
            ok = document.execCommand('copy');
            sel.removeAllRanges();
        } catch (e) { ok = false; }
        setTimeout(function () {
            if (host.parentNode) host.parentNode.removeChild(host);
            URL.revokeObjectURL(url);
        }, 1500);
        resolve(!!ok);
    });
}

function _copyImageToClipboard(blob) {
    if (!blob) return Promise.resolve(false);
    if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        try {
            var item = new ClipboardItem({ 'image/png': blob });
            return navigator.clipboard.write([item]).then(
                function () { return true; },
                function () { return _legacyCopyImage(blob); });
        } catch (e) { /* 落到旧式路径 */ }
    }
    return _legacyCopyImage(blob);
}

function _ensureShareDialog() {
    if (_shareEls) return _shareEls;
    const ovl = document.createElement('div');
    ovl.className = 'share-ovl';
    ovl.style.display = 'none';
    const sheet = document.createElement('div');
    sheet.className = 'share-sheet';
    // 风格切换条：四种配色实时预览，选择记住在本地
    const styleRow = document.createElement('div');
    styleRow.className = 'share-styles';
    const styleBtns = _SHARE_STYLES.map(function (st, i) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'share-style-btn';
        b.textContent = _shareT(st.nameKey, st.id);
        b.onclick = function () {
            _shareSetStyleIdx(i);
            _renderSharePreview();
        };
        styleRow.appendChild(b);
        return b;
    });
    const img = document.createElement('img');
    img.className = 'share-img';
    img.alt = 'CUKTECH charge report';
    const actions = document.createElement('div');
    actions.className = 'share-actions';
    const hint = document.createElement('div');
    hint.className = 'share-hint';
    const mk = (cls) => {
        const b = document.createElement('button');
        b.className = 'share-btn ' + (cls || '');
        b.type = 'button';
        actions.appendChild(b);
        return b;
    };
    const bSave = mk('');
    const bCopy = mk('');
    const bShare = mk('');
    const bOpen = mk('secondary');
    const bClose = mk('secondary');
    // 兜底说明：任何浏览器都能"右键图片 → 复制图片"（手机是长按 → 保存/转发），
    // 一键复制在壳浏览器上本来就不可靠，把这条路明写在界面上。
    const cap = document.createElement('div');
    cap.className = 'share-cap';
    // 点遮罩关闭（点面板内部不关）
    ovl.addEventListener('click', (e) => {
        if (e.target === ovl) ovl.style.display = 'none';
    });
    sheet.appendChild(styleRow);
    sheet.appendChild(img);
    sheet.appendChild(cap);
    sheet.appendChild(actions);
    sheet.appendChild(hint);
    ovl.appendChild(sheet);
    document.body.appendChild(ovl);
    _shareEls = { ovl, img, bSave, bCopy, bShare, bOpen, bClose, hint, cap, styleBtns };
    return _shareEls;
}

function _renderSharePreview() {
    const els = _shareEls;
    const st = _SHARE_STYLES[_shareStyleIdx()];
    els.styleBtns.forEach(function (b, i) {
        b.classList.toggle('active', i === _shareStyleIdx());
    });
    _shareCanvas = _shareCardCanvas(st);
    _shareBlob = null;
    els.img.src = _shareCanvas.toDataURL('image/png');
    // 预取 Blob：分享/复制点击时直接用，避免异步丢用户手势
    _shareCanvas.toBlob(function (b) { _shareBlob = b; }, 'image/png');
}

function _shareHint(text) {
    if (!_shareEls) return;
    _shareEls.hint.textContent = text || '';
    if (_shareEls._hintTimer) clearTimeout(_shareEls._hintTimer);
    if (text) _shareEls._hintTimer = setTimeout(() => {
        if (_shareEls) _shareEls.hint.textContent = '';
    }, 4000);
}

function openShareCard() {
    if (!_lastDetail) return;
    const els = _ensureShareDialog();
    els.bSave.textContent = _shareT('charge.shareSave', '保存图片');
    els.bCopy.textContent = _shareT('charge.shareCopy', '复制图片');
    els.bShare.textContent = _shareT('charge.shareSend', '分享给微信好友');
    els.bOpen.textContent = _shareT('charge.shareOpen', '打开原图');
    els.bClose.textContent = I18N.t('common.close');
    els.cap.textContent = _shareT('charge.shareRightClick',
        '电脑端也可以右键图片直接「复制图片」；手机端长按图片可保存或转发');
    // 系统分享：手机浏览器上可直发微信；不支持的浏览器隐藏该按钮
    const canShare = typeof navigator.canShare === 'function'
        && typeof navigator.share === 'function';
    els.bShare.style.display = canShare ? '' : 'none';
    _renderSharePreview();

    // ── 保存图片 ──
    els.bSave.onclick = function () {
        const btn = this;
        _shareBlobPromise().then(function (blob) {
            if (!blob) return _shareHint(_shareT('charge.shareCopyFail', '生成图片失败'));
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'CUKTECH-charge-' + (_lastDetail.sid || '') + '.png';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
            btn.textContent = _shareT('charge.shareSavedBtn', '已保存 ✓');
            _shareHint(_shareT('charge.shareSaved', '图片已保存到下载'));
            setTimeout(function () {
                btn.textContent = _shareT('charge.shareSave', '保存图片');
            }, 2000);
        });
    };

    // ── 复制图片 ──
    els.bCopy.onclick = function () {
        const btn = this;
        const okText = _shareT('charge.shareCopied', '已复制到剪贴板，可直接 Ctrl+V 粘贴');
        const failText = _shareT('charge.shareCopyManual',
            '这个浏览器不支持一键复制图片，请右键点上方图片 → 选「复制图片」');
        btn.textContent = _shareT('charge.shareCopying', '复制中…');
        const work = function (blob) {
            if (!blob) {
                btn.textContent = _shareT('charge.shareCopy', '复制图片');
                return _shareHint(_shareT('charge.shareCopyFail', '生成图片失败'));
            }
            _copyImageToClipboard(blob).then(function (ok) {
                if (ok) {
                    btn.textContent = _shareT('charge.shareCopiedBtn', '已复制 ✓');
                    _shareHint(okText);
                } else {
                    btn.textContent = _shareT('charge.shareCopy', '复制图片');
                    _shareHint(failText);
                }
                setTimeout(function () {
                    btn.textContent = _shareT('charge.shareCopy', '复制图片');
                }, 2400);
            });
        };
        // 预渲染好的 Blob 直接同步用（保住手势），没有才异步取
        if (_shareBlob) work(_shareBlob);
        else _shareBlobPromise().then(work);
    };

    // ── 分享给微信好友 ──
    els.bShare.onclick = function () {
        const noShareText = _shareT('charge.shareNoShare',
            '此浏览器无法直接调起微信，图片已复制到剪贴板，可粘贴到微信聊天窗口发送');
        const go = function (blob) {
            if (!blob) return _shareHint(_shareT('charge.shareCopyFail', '生成图片失败'));
            try {
                const file = new File([blob], 'cuktech-charge.png', { type: 'image/png' });
                if (navigator.canShare && navigator.canShare({ files: [file] })) {
                    navigator.share({
                        files: [file],
                        title: _shareT('charge.shareReport', '充电报告'),
                    }).catch(function (err) {
                        // 用户主动取消不是错误；真调不起来就退级为"复制图片"
                        if (err && err.name === 'AbortError') return;
                        _copyForFallback(noShareText);
                    });
                    return;
                }
            } catch (e) { /* 落到退级 */ }
            _copyForFallback(noShareText);
        };
        // 退级：分享不可用时自动复制到剪贴板，用户直接去微信粘贴
        function _copyForFallback(hintText) {
            _copyImageToClipboard(blob).then(function (ok) {
                _shareHint(ok ? hintText
                    : _shareT('charge.shareCopyManual',
                        '这个浏览器不支持一键复制图片，请右键点上方图片 → 选「复制图片」'));
            });
        }
        _shareBlobPromise().then(go);
    };

    // ── 打开原图（最终兜底：右键复制 / 手机长按保存，任何浏览器都适用）──
    els.bOpen.onclick = function () {
        _shareBlobPromise().then(function (blob) {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
            setTimeout(() => URL.revokeObjectURL(url), 60000);
        });
    };

    els.bClose.onclick = function () { els.ovl.style.display = 'none'; };
    els.hint.textContent = '';
    els.ovl.style.display = 'flex';
}

// ── 电量口径：这次充电"从多少 % 充到多少 %" ──
//
// 充电器读到的是输出侧 Wh（含转换损耗），要换算成"电池增加了百分之几"必须
// 除以一个效率：GaN 快充整体（输出 → 电池）实测约 88%。分母是电池容量，
// 来源是用户选的型号（存进 battery_profiles，按充电签名复用）。
//
// 起点百分比也只能由用户填：PD/PPS/UFCS 不传输被充设备的电池电量（6U 的
// "放心充"是苹果私有 VDM 让 iPhone 自己上报，10U 没有这条路）。
var CH_EFF = 0.88;

function _chNum(v) {
    var n = parseFloat(v);
    return isNaN(n) ? null : n;
}

function _chPct(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = parseFloat(v);
    if (isNaN(n)) return null;
    return Math.max(0, Math.min(100, n));
}

// ── SOC 分段涓流模型────────────────
// 默认衰减表按公开实测重标（充电头网 / ChargerLAB 对 iPhone Air 的全程充电
// 测试，25℃、40W 适配器：30min→50%、64min→80%、79min→90%、130min→100%，
// 功率台阶 18W→14W→10W→6W，90% 后进一步跌入涓流），并用用户实测交叉验证。
// 学习过的型号（/api/learn-curves，按「品牌+型号」归档）与默认表按学习次数
// 加权融合，没测过的区间回落默认值 —— 同一台设备充得越多越准。
var LEARN_BANDS = [0, 50, 70, 75, 80, 90, 95, 100];
var DEFAULT_CURVE = [[0, 0.8], [50, 0.45], [70, 0.4], [75, 0.28], [80, 0.18], [90, 0.11], [95, 0.09]];
var _learnCurves = null;
var _learnLoading = null;

function _ensureLearnCurves() {
    if (_learnCurves) return Promise.resolve(_learnCurves);
    if (_learnLoading) return _learnLoading;
    _learnLoading = chApi(API + '/api/learn-curves')
        .then(function (r) { return r.json(); })
        .then(function (d) {
            _learnCurves = (d && d.curves) || {};
            return _learnCurves;
        })
        .catch(function () {
            _learnCurves = {};
            return _learnCurves;
        });
    return _learnLoading;
}
_ensureLearnCurves();   // 页面加载即拉一次，详情打开时多半已经就绪

function _curveRatioAt(curve, soc) {
    var r = 1;
    for (var i = 0; i < curve.length; i++) {
        if (curve[i][0] <= soc) r = curve[i][1];
        else break;
    }
    return r;
}

// 学习曲线与默认表按 n/(n+1) 加权融合（n=1 实测占一半，越多越信实测）
function _blendLearned(learned) {
    var w = learned.n / (learned.n + 1);
    var out = [];
    for (var i = 0; i + 1 < LEARN_BANDS.length; i++) {
        var lo = LEARN_BANDS[i];
        var lr = null;
        for (var j = 0; j < learned.curve.length; j++) {
            if (learned.curve[j][0] === lo) { lr = learned.curve[j][1]; break; }
        }
        if (lr === null) lr = _curveRatioAt(DEFAULT_CURVE, lo);
        out.push([lo, Math.max(0.03, w * lr + (1 - w) * _curveRatioAt(DEFAULT_CURVE, lo))]);
    }
    return out;
}

// 型号匹配 key：「品牌+型号」，与后端 _learn_model_key 同一规则
function _learnModelKey(brand, model) {
    var m = String(model || '').trim();
    if (!m) return String(brand || '').trim();
    var b = String(brand || '').trim();
    return (b && m.indexOf(b) < 0) ? b + ' ' + m : m;
}

function _learnedFor(brand, model) {
    if (!_learnCurves) return null;
    var k = _learnModelKey(brand, model);
    if (!k) return null;
    var e = _learnCurves[k];
    return (e && e.curve && e.curve.length) ? e : null;
}

// 距 80 / 95 / 100% 还有多少分钟。
// o.peakW：本会话峰值功率 —— 对应涓流前的满速段，比瞬时功率更可靠的基准
//  （涓流期瞬时功率已经降下来了，拿它当基准会越算越乐观）；没有峰值时用
// 「当前功率 ÷ 当前段比例」反推满速峰值。o.learned：该型号已学习的曲线。
function predictMinutes(curPct, capWh, pNow, o) {
    o = o || {};
    var pct = _chPct(curPct);
    if (pct === null || !(capWh > 0) || !(pNow > 0)) return null;
    var curve = (o.learned && o.learned.curve && o.learned.curve.length)
        ? _blendLearned(o.learned) : DEFAULT_CURVE;
    var ref;
    if (o.peakW > pNow) {
        ref = o.peakW;
    } else {
        ref = Math.min(pNow / Math.max(0.15, _curveRatioAt(curve, pct)), pNow * 5);
    }
    function mAt(target) {
        var sec = 0;
        for (var i = 0; i < curve.length; i++) {
            var lo = Math.max(curve[i][0], pct);
            var hi = Math.min(i + 1 < curve.length ? curve[i + 1][0] : 100, target);
            if (hi <= lo) continue;
            var wh = (hi - lo) / 100 * capWh / CH_EFF;
            sec += wh / Math.max(0.5, ref * curve[i][1]) * 3600;
        }
        return sec / 60;
    }
    return { 80: mAt(80), 95: mAt(95), 100: mAt(100) };
}

function _chFmtMin(min) {
    var m = Math.max(1, Math.round(min));
    var h = Math.floor(m / 60), r = m % 60;
    if (h > 0) {
        return h + _shareT('charge.predictHr', '小时') + r + _shareT('charge.predictMin', '分钟');
    }
    return r + _shareT('charge.predictMin', '分钟');
}

// 会话列表 / 详情行尾的电量摘要：
//   充电中 → "约 25 分钟充满（当前 68%）"
//   已结束 → "20% → 78%"（未充满的标"未充满"；没填起点就只给"已充 +39%"）
function sessionPctSummary(s) {
    if (!s) return null;
    var cap = _chNum(s.cap_wh);
    if (!(cap > 0)) return null;
    var wh = _chNum(s.total_wh) || 0;
    if (wh <= 0) return null;
    // pct_wh = 填电量那一刻已经充进去的 Wh。用户可能在充了半小时后才填"现在 42%"，
    // 那前面的 Wh 不能算进增量，否则会把"现在 42%"当成"开始时 42%"重复累加。
    var baseWh = _chNum(s.pct_wh) || 0;
    var gained = Math.max(0, wh - baseWh) * CH_EFF / cap * 100;
    var start = _chPct(s.start_pct);
    var active = !!s.is_active;

    if (active) {
        var pNow = _chNum(s.power_now);
        if (!(pNow > 0.5)) pNow = _chNum(s.avg_power_w) || 0;
        if (start === null) {
            return {
                text: '已充 +' + Math.round(gained) + '%',
                cls: 'is-active',
                title: '未填当前电量，只能给出填完之后充入的百分比增量（约 '
                    + Math.max(0, wh - baseWh).toFixed(1) + 'Wh）'
            };
        }
        var cur = Math.min(100, start + gained);
        if (cur >= 99.5) {
            return { text: '已充满', cls: 'is-active is-full', title: '当前约 100%' };
        }
        if (!(pNow > 0.5)) {
            return {
                text: Math.round(cur) + '% · 已暂停',
                cls: 'is-active',
                title: '当前没有充电功率，无法估算剩余时间'
            };
        }
        // 学习曲线匹配：列表行只有设备显示名（标记/型号名），按名字直接命中；
        // 没命中就回落默认表。peak 用会话峰值，比瞬时功率稳。
        var eta = predictMinutes(cur, cap, pNow, {
            peakW: _chNum(s.peak_power_w) || 0,
            learned: _learnCurves ? _learnedFor('', (s.device && s.device.name) || '') : null
        });
        return {
            text: '约 ' + _chFmtMin(eta[100]) + '充满（当前 ' + Math.round(cur) + '%）',
            cls: 'is-active',
            title: '按当前 ' + pNow.toFixed(1) + 'W 估算；80% 约 '
                + _chFmtMin(eta[80]) + '，95% 约 ' + _chFmtMin(eta[95])
        };
    }

    var end = start === null ? null : Math.min(100, start + gained);
    if (end === null) {
        return {
            text: '已充 +' + Math.round(gained) + '%',
            cls: '',
            title: '未填起始电量，只能给出本次充入的百分比增量（约 '
                + Math.max(0, wh - baseWh).toFixed(1) + 'Wh）'
        };
    }
    var from = Math.round(start), to = Math.round(end);
    if (to >= 99) {
        return { text: from + '% → 100%', cls: 'is-full', title: '充满' };
    }
    return {
        text: from + '% → ' + to + '%',
        cls: '',
        title: '未充满，按充入 ' + wh.toFixed(1) + 'Wh / 容量 ' + cap.toFixed(1)
            + 'Wh 估算（含 ' + Math.round(CH_EFF * 100) + '% 转换效率）'
    };
}

// ── 充满预测：选设备型号 → 填当前电量 → 保存并预测 ──
//
// 型号库在 battery_db.js（品牌 → 系列 → 型号 三级 + 关键词搜索）。选中的
// 品牌/型号/容量连同"当前电量"一起 POST 到 /api/sessions/{id}/battery：
//   · 当前电量写进本会话行（这一次的记录从此能显示"从 % 到 %"）
//   · 容量按充电签名存进档案（下次同一台设备插上来，型号自动带出，
//     用户只需要改一个数字）

var _capMode = 'browse';
var _pickedBattery = null;      // {brand, series, name, wh, mah}
var _batteryProfiles = null;    // signature -> profile
var _profilesLoading = null;
var _predictBuilt = false;

function _batteryLib() {
    return (typeof BatteryDB !== 'undefined') ? BatteryDB : null;
}

function _predictEl(id) { return document.getElementById(id); }

function _ensureBatteryProfiles() {
    if (_batteryProfiles) return Promise.resolve(_batteryProfiles);
    if (_profilesLoading) return _profilesLoading;
    _profilesLoading = chApi(API + '/api/battery-profiles')
        .then(function (r) { return r.json(); })
        .then(function (d) {
            _batteryProfiles = (d && d.profiles) || {};
            return _batteryProfiles;
        })
        .catch(function () {
            _batteryProfiles = {};
            return _batteryProfiles;
        });
    return _profilesLoading;
}

function togglePredict() {
    var body = _predictEl('sdPredictBody');
    if (!body) return;
    var show = body.style.display === 'none';
    body.style.display = show ? 'block' : 'none';
    var btn = _predictEl('sdPredictToggle');
    if (btn) btn.textContent = show
        ? _shareT('charge.predictHide', '收起')
        : _shareT('charge.predictToggle', '展开');
    if (show && !_predictBuilt) {
        _predictBuilt = true;
        _buildCapacityPickers();
    }
    if (show) _syncPickersToPicked();
}

function _buildCapacityPickers() {
    var lib = _batteryLib();
    var brandSel = _predictEl('predictBrand');
    if (!lib || !brandSel) return;
    brandSel.innerHTML = '';
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = _shareT('charge.predictPickBrand', '选择品牌');
    brandSel.appendChild(ph);
    lib.brands().forEach(function (b) {
        var o = document.createElement('option');
        o.value = b;
        o.textContent = b;
        brandSel.appendChild(o);
    });
    onBrandChange();
}

function setCapMode(mode) {
    _capMode = mode === 'search' ? 'search' : 'browse';
    var browse = _predictEl('capBrowseBox');
    var search = _predictEl('capSearchBox');
    var b1 = _predictEl('capModeBrowse');
    var b2 = _predictEl('capModeSearch');
    if (browse) browse.style.display = _capMode === 'browse' ? 'flex' : 'none';
    if (search) search.style.display = _capMode === 'search' ? 'block' : 'none';
    if (b1) b1.classList.toggle('active', _capMode === 'browse');
    if (b2) b2.classList.toggle('active', _capMode === 'search');
    if (_capMode === 'search') {
        var inp = _predictEl('predictSearch');
        if (inp) inp.focus();
    }
}

// 品牌变了：把该品牌所有系列的型号按 optgroup 铺进型号下拉
function onBrandChange() {
    var lib = _batteryLib();
    var brandSel = _predictEl('predictBrand');
    var modelSel = _predictEl('predictModel');
    if (!lib || !brandSel || !modelSel) return;
    modelSel.innerHTML = '';
    var brand = brandSel.value;
    var custom = document.createElement('option');
    custom.value = '__custom__';
    custom.textContent = _shareT('charge.predictCustomWh', '自定义容量（Wh）');
    modelSel.appendChild(custom);
    if (!brand) { modelSel.disabled = true; return; }
    modelSel.disabled = false;
    lib.series(brand).forEach(function (s) {
        var grp = document.createElement('optgroup');
        grp.label = s;
        lib.models(brand, s).forEach(function (m) {
            var o = document.createElement('option');
            o.value = m.name;
            o.textContent = m.name + ' · ' + m.wh + 'Wh';
            o.dataset.wh = m.wh;
            o.dataset.mah = m.mah || 0;
            o.dataset.series = s;
            grp.appendChild(o);
        });
        modelSel.appendChild(grp);
    });
    // 已经选过型号（从档案带出来的）就定位过去。档案里的型号可能不在内置库里
    // （用户手填或以后新出的机型），那就补一个临时选项挂上去——否则下拉落回
    // "自定义"，onModelChange 会把档案带出来的容量清掉。
    if (_pickedBattery && _pickedBattery.brand === brand && _pickedBattery.name) {
        var has = Array.prototype.some.call(modelSel.options, function (o) {
            return o.value === _pickedBattery.name;
        });
        if (!has) {
            var extra = document.createElement('option');
            extra.value = _pickedBattery.name;
            extra.textContent = _pickedBattery.name + ' · ' + _pickedBattery.wh + 'Wh';
            extra.dataset.wh = _pickedBattery.wh;
            extra.dataset.mah = _pickedBattery.mah || 0;
            extra.dataset.series = _pickedBattery.series || '';
            modelSel.appendChild(extra);
        }
        modelSel.value = _pickedBattery.name;
    }
    onModelChange();
}

function onModelChange() {
    var modelSel = _predictEl('predictModel');
    if (!modelSel) return;
    var opt = modelSel.options[modelSel.selectedIndex];
    if (!opt || opt.value === '__custom__') {
        _pickedBattery = null;
        _renderPicked();
        return;
    }
    _pickedBattery = {
        brand: _predictEl('predictBrand').value,
        series: opt.dataset.series || '',
        name: opt.value,
        wh: parseFloat(opt.dataset.wh) || 0,
        mah: parseFloat(opt.dataset.mah) || 0
    };
    _renderPicked();
}

function onSearchInput(q) {
    var lib = _batteryLib();
    var box = _predictEl('predictSuggest');
    if (!lib || !box) return;
    var hits = lib.search(q, 12);
    if (!hits.length) {
        box.innerHTML = '<div class="predict-suggest-empty">'
            + esc(_shareT('charge.predictSearchNone', '没找到，换成手动填 Wh')) + '</div>';
        return;
    }
    box.innerHTML = hits.map(function (h, i) {
        return '<div class="predict-suggest-item" data-i="' + i + '" role="button" tabindex="0">'
            + '<span class="psi-name">' + esc(h.name) + '</span>'
            + '<span class="psi-meta">' + esc(h.brand) + ' · ' + h.wh + 'Wh</span>'
            + '</div>';
    }).join('');
    Array.prototype.forEach.call(box.children, function (node) {
        var i = parseInt(node.dataset.i, 10);
        var pick = function () { pickBattery(hits[i]); };
        node.onclick = pick;
        node.onkeydown = function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
        };
    });
}

function pickBattery(hit) {
    if (!hit) return;
    _pickedBattery = {
        brand: hit.brand, series: hit.series || '', name: hit.name,
        wh: hit.wh, mah: hit.mah || 0
    };
    var box = _predictEl('predictSuggest');
    if (box) box.innerHTML = '';
    var inp = _predictEl('predictSearch');
    if (inp) inp.value = hit.name;
    // 浏览模式的三个下拉也跟着走，用户切回去时不会对不上
    var brandSel = _predictEl('predictBrand');
    if (brandSel && hit.brand) {
        brandSel.value = hit.brand;
        onBrandChange();
        var modelSel = _predictEl('predictModel');
        if (modelSel) modelSel.value = hit.name;
    }
    _renderPicked();
}

function _renderPicked() {
    var out = _predictEl('predictPicked');
    var whRow = _predictEl('predictCapWhRow');
    if (whRow) {
        whRow.style.display = (_pickedBattery && _pickedBattery.wh > 0) ? 'none' : 'flex';
    }
    if (!out) return;
    if (_pickedBattery && _pickedBattery.wh > 0) {
        out.innerHTML = '<span class="predict-chip">'
            + esc(_pickedBattery.name) + ' · ' + _pickedBattery.wh + 'Wh</span>';
        out.style.display = 'block';
    } else {
        out.innerHTML = '';
        out.style.display = 'none';
    }
}

function _syncPickersToPicked() {
    var brandSel = _predictEl('predictBrand');
    if (!brandSel || !brandSel.options.length) return;
    if (_pickedBattery && _pickedBattery.brand) {
        brandSel.value = _pickedBattery.brand;
        onBrandChange();
    }
    _renderPicked();
}

function _setCustomWh(wh) {
    _pickedBattery = null;
    var el = _predictEl('predictCapWh');
    if (el && wh > 0) el.value = wh;
    _renderPicked();
}

// ── mAh ↔ Wh 双向换算（手机/平板电池标称电压按 3.85V 折算）──
// 不是所有人都知道自己设备多少 Wh，但电池上一般都印着 mAh。
var CAP_NOMINAL_V = 3.85;

function onCapMahInput(v) {
    var mah = _chNum(v);
    var el = _predictEl('predictCapWh');
    if (!el || !(mah > 0)) return;
    // mAh × 3.85 ÷ 1000 = Wh；保留 2 位小数（5 号电池芯 2170mAh ≈ 8.35Wh）
    el.value = Math.round(mah * CAP_NOMINAL_V / 10) / 100;
    _renderPicked();
}

function onCapWhInput(v) {
    var wh = _chNum(v);
    var el = _predictEl('predictCapMah');
    if (!el || !(wh > 0)) return;
    el.value = Math.round(wh * 1000 / CAP_NOMINAL_V);
    _renderPicked();
}

// 打开一条会话时把"上次给这台设备填过什么"带出来
function applySessionBattery(stats) {
    if (!stats) {
        var out0 = _predictEl('predictResult');
        if (out0) out0.textContent = '';
        return;
    }
    var pctEl = _predictEl('predictPct');
    if (pctEl && stats.start_pct !== null && stats.start_pct !== undefined) {
        pctEl.value = String(Math.round(stats.start_pct));
    }
    // 充电中填的是"现在多少 %"，已结束填的是"这次从多少 % 开始"，标签得跟着变
    var lab = _predictEl('predictPctLabel');
    if (lab) {
        lab.textContent = stats.is_active
            ? _shareT('charge.predictPct', '当前电量 %')
            : _shareT('charge.predictStartPct', '起始电量 %');
    }
    var hint = _predictEl('predictDeviceHint');
    var dev = stats.device || null;
    if (hint) {
        hint.textContent = (dev && dev.name) ? ('→ ' + dev.name) : '';
    }
    _ensureBatteryProfiles().then(function (profiles) {
        // 详情可能已经翻到别的会话了，迟到的档案不要再往界面上写
        if (!_lastDetail || String(_lastDetail.sid) !== String(stats.session_id)) return;
        var sig = dev && dev.signature;
        var prof = (sig && profiles) ? profiles[sig] : null;
        if (prof && prof.cap_wh > 0) {
            _pickedBattery = {
                brand: prof.brand || '', series: '', name: prof.model || '',
                wh: prof.cap_wh, mah: prof.cap_mah || 0
            };
            _syncPickersToPicked();
        } else if (stats.cap_wh > 0) {
            _setCustomWh(stats.cap_wh);
        } else {
            // 这条会话既没有档案也没有手填容量：把上一条会话选的型号清掉，
            // 否则用户会以为"这台设备的容量已经填过了"。
            _pickedBattery = null;
            var bs = _predictEl('predictBrand');
            if (bs) { bs.value = ''; onBrandChange(); }
            var ws = _predictEl('predictSearch');
            if (ws) ws.value = '';
            _renderPicked();
        }
    });
}

function predictCapChanged() { /* 旧版下拉已换成三级选择器，保留空函数给旧缓存页面 */ }

function _selectedCapWh() {
    if (_pickedBattery && _pickedBattery.wh > 0) return _pickedBattery.wh;
    var el = _predictEl('predictCapWh');
    var v = parseFloat(el && el.value);
    return isNaN(v) ? null : v;
}

function runPredict() {
    var out = _predictEl('predictResult');
    if (!out || !_lastDetail) return;
    var pct = _chPct(_predictEl('predictPct') && _predictEl('predictPct').value);
    var wh = _selectedCapWh();
    if (pct === null || !wh || wh <= 0) {
        out.textContent = _shareT('charge.predictNeed', '请先填写当前电量和电池容量');
        return;
    }
    // 当前功率：优先"这一刻"的实测值，没有就退回会话均值
    var pNow = _chNum(_lastDetail.powerNow) || 0;
    if (!(pNow > 0.5)) pNow = _chNum(_lastDetail.avgPower) || 0;
    if (!(pNow > 0.5)) {
        out.textContent = _shareT('charge.predictNoPower', '当前没有充电功率，无法预测');
        return;
    }

    // 先存：当前电量进会话行，容量进设备档案（下次自动带出）
    var body = {
        pct: pct,
        cap_wh: wh,
        brand: _pickedBattery ? _pickedBattery.brand : '',
        model: _pickedBattery ? _pickedBattery.name : '',
        cap_mah: _pickedBattery ? (_pickedBattery.mah || 0) : 0
    };
    // 型号联动：从库里选出了具体型号 → 设备名自动跟过去（chip 立刻显示）。
    // 自定义手填 Wh 时没有型号名，不动设备名——保持用户标记/推测的原样。
    if (_pickedBattery && _pickedBattery.name) body.device_name = _pickedBattery.name;
    var sid = _lastDetail.sid;
    var saveHint = _predictEl('predictSavedHint');
    if (sid != null) {
        chApi(API + '/api/sessions/' + sid + '/battery', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(function (r) { return r.json(); }).then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || 'save failed');
            _lastDetail.startPct = pct;
            _lastDetail.capWh = wh;
            if (saveHint) {
                saveHint.textContent = _batteryProfiles && d.signature
                    ? _shareT('charge.predictSaved', '已保存，下次这台设备自动带出')
                    : _shareT('charge.predictSavedSession', '已保存到这次记录');
            }
            if (_batteryProfiles && d.signature && d.profile) {
                _batteryProfiles[d.signature] = d.profile;
            }
            // 已结束的会话补填电量时后端刚学完这条曲线，拉最新（充电中的
            // 会话要等收尾才学，这里刷新只是保持缓存新鲜）
            _learnCurves = null;
            _learnLoading = null;
            _ensureLearnCurves();
            // 型号联动成功：chip 与列表立刻显示选出的型号名
            if (d.device) {
                _lastDetail.device = d.device;
                renderDeviceStrip(d.device, _currentProtocols);
            }
            if (typeof refreshChargeHistory === 'function') refreshChargeHistory(true);
            _refreshDetailPctChip();
        }).catch(function (e) {
            if (saveHint) saveHint.textContent = _shareT('charge.predictSaveFail', '保存失败');
            console.error('save battery failed:', e);
        });
    }

    var learned = _pickedBattery
        ? _learnedFor(_pickedBattery.brand, _pickedBattery.name) : null;
    var eta = predictMinutes(pct, wh, pNow, {
        peakW: _chNum(_lastDetail.peak) || 0,
        learned: learned
    });
    var nowSec = Date.now() / 1000;
    var lines = [];
    [80, 95, 100].forEach(function (target) {
        if (target <= pct) return;
        var m = eta[target];
        if (!(m > 0)) return;
        lines.push('<b>' + target + '%</b>：'
            + _shareT('charge.predictEta', '约 {{min}} 后（{{time}}）')
                .replace('{{min}}', _chFmtMin(m))
                .replace('{{time}}', fmtTime(nowSec + m * 60)));
    });
    if (!lines.length) {
        out.textContent = _shareT('charge.predictDone', '当前电量已达到这些目标');
        return;
    }
    var note = _shareT('charge.predictNote',
        '按当前实测功率估算，接近满电时功率会下降，误差约 ±10~15%')
        .replace('{{power}}', pNow.toFixed(1));
    var html = '<div class="predict-lines">' + lines.join('<br>') + '</div>'
        + '<div class="predict-note">' + note + '</div>';
    if (learned && learned.n > 0) {
        html += '<div class="predict-calib">'
            + esc(_shareT('charge.predictCalibrated', '✓ 已按此型号 {{n}} 次实测校准')
                .replace('{{n}}', learned.n)) + '</div>';
    }
    out.innerHTML = html;
}

// 详情标题栏的电量 chip（填完电量/存过档案后要立刻反映出来）
function _refreshDetailPctChip() {
    var chip = _predictEl('sdPct');
    if (!chip || !_lastDetail) return;
    var summary = sessionPctSummary({
        cap_wh: _lastDetail.capWh,
        start_pct: _lastDetail.startPct,
        pct_wh: _lastDetail.pctWh,
        total_wh: _lastDetail.energy,
        is_active: !!_lastDetail.isActive,
        power_now: _lastDetail.powerNow,
        avg_power_w: _lastDetail.avgPower
    });
    if (!summary) { chip.textContent = ''; chip.style.display = 'none'; return; }
    chip.textContent = summary.text;
    chip.title = summary.title || '';
    chip.className = 'sd-pct ' + (summary.cls || '');
    chip.style.display = '';
}
