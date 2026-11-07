#!/usr/bin/env node
/**
 * config.html 设备卡片列表的契约测试（多设备 §3.12 / §3.10）。
 *
 * 为什么单独测 config.html 的那段内联脚本：它是整个多设备改造里**唯一会写配置**
 * 的地方，而保存 payload 的形状有两个硬约束，写错了不会报错、只会在重启后
 * 悄悄变成另一种配置：
 *   1. 第一台必须展开回 `ble:` 节（老工具/脚本只认这个节，primary 的 id 恒为
 *      default 也是锚在这里）；
 *   2. 其余设备进 `devices:` 节，字段名必须与 config.py 的 from_mapping 一致
 *      （id/name/mac/token/ble_key/topic_prefix/bemfa_*）。
 * 另外锁住"任何卡片都可删除"：primary 只是落盘位置，删掉第一张时后一张自动
 * 顶上（凭据按 source_id 由服务端继承），删到一张不剩也能保存。
 *
 * Usage: node tests/js/config_devices_test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.resolve(__dirname, '../../web');

let failed = 0;
let passed = 0;
function ok(cond, label, detail) {
    if (cond) { passed++; console.log(`  ok   ${label}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}
function eq(actual, expected, label) {
    ok(JSON.stringify(actual) === JSON.stringify(expected), label,
       `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

function extractInlineScripts(htmlPath) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const scripts = [];
    const re = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(html))) scripts.push(m[1]);
    return scripts.join('\n');
}

// 服务端真实形状的桩：/api/config 只给 primary 的凭据（掩码），/api/devices 给设备清单
const CONFIG_PAYLOAD = {
    ok: true,
    config: {
        ble: { mac: 'AA:BB:CC:DD:EE:01', token: '****1234', ble_key: '****abcd', scan_timeout: 10 },
        mqtt: { enabled: false, host: '', port: 1883, username: '', password: '', topic_prefix: 'cuktech/charger' },
        bemfa: { enabled: false, uid: '', name_c1: '', name_c2: '', name_c3: '', name_a: '', name_ble: '' },
        server: { port: 8199, log_level: 'info', history_retention_days: 2 },
    },
};
const DEVICES_PAYLOAD = {
    ok: true,
    devices: [
        { id: 'default', name: '书房充电器', mac: 'AA:BB:CC:DD:EE:01', connected: true, topic_prefix: 'cuktech/charger', is_primary: true },
        { id: 'desk', name: '书桌充电器', mac: 'AA:BB:CC:DD:EE:02', connected: false, topic_prefix: 'cuktech/charger/desk', is_primary: false },
    ],
};

function buildSandbox() {
    const els = new Map();
    const posts = [];
    function makeEl(id) {
        const el = {
            id: id || '', value: '', checked: false, textContent: '', innerHTML: '', hidden: false,
            style: { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {}, cssText: '' },
            dataset: {}, className: '', children: [], options: [], attrs: {},
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
            setAttribute(k, v) { this.attrs[k] = String(v); },
            getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
            appendChild() {}, remove() {},
            addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
            closest() { return null; }, focus() {}, blur() {},
        };
        return el;
    }
    function getEl(id) {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
    }
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        Intl, URL,
        // 默认立即执行（老用例依赖它把 showToast 的 opacity 定时器跑掉）。
        // 导入后要轮询 /api/health 再跳主页，那个递归定时器立即执行会无限递归，
        // 所以用例可以 __syncTimers = false 改成排队，自己 flushTimers 控制节奏。
        setTimeout: (fn) => {
            if (typeof fn !== 'function') return 0;
            if (sandbox.__syncTimers) { fn(); return 0; }
            sandbox.__timers.push(fn);
            return sandbox.__timers.length;
        },
        clearTimeout() {}, setInterval: () => 0, clearInterval() {},
        Promise, JSON, Math, Date, RegExp, String, Number, Boolean, Object, Array,
        isNaN, parseFloat, parseInt, Error, Map, Set,
        fetch: (url, init) => {
            const u = String(url);
            if (init && init.method === 'POST') {
                posts.push({ url: u, body: JSON.parse(init.body || '{}') });
                // 米家批量导入：返回的载荷由用例通过 __xiaomiImport 设定
                if (u.indexOf('/api/xiaomi/import') >= 0) {
                    return Promise.resolve({
                        ok: true, status: 200,
                        json: () => Promise.resolve(sandbox.__xiaomiImport
                            || { ok: true, devices: [] }),
                    });
                }
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
            }
            // 保存后服务端 os.execv 重启，健康检查会先挂一阵子：__health = 'down'
            // 模拟重启窗口，'up' 模拟新进程已经起来
            if (u.indexOf('/api/health') >= 0) {
                const up = sandbox.__health !== 'down';
                return Promise.resolve({
                    ok: up, status: up ? 200 : 503,
                    json: () => Promise.resolve({ ok: up }),
                });
            }
            if (u.indexOf('/api/devices') >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(DEVICES_PAYLOAD) });
            if (u.indexOf('/api/config') >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(CONFIG_PAYLOAD) });
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
        },
        confirm: () => sandbox.__confirmAnswer !== false,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        navigator: { language: 'zh-CN' },
        location: {
            origin: 'http://charger.local:8199',
            href: 'http://charger.local:8199/config.html',
            replace(url) { sandbox.__navigated = url; },
            reload() {},
        },
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
        CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    };
    sandbox.__timers = [];
    sandbox.__syncTimers = true;
    sandbox.__navigated = null;
    sandbox.window = sandbox;
    sandbox.document = {
        documentElement: makeEl('html'), body: makeEl('body'), head: makeEl('head'),
        title: '', readyState: 'complete',
        getElementById: getEl, querySelector: () => null, querySelectorAll: () => [],
        createElement: () => makeEl('new'), addEventListener() {},
    };
    vm.createContext(sandbox);
    for (const f of ['static/locales/zh-CN.js', 'static/locales/en.js', 'static/i18n.js']) {
        vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'), sandbox, { filename: f });
    }
    vm.runInContext(extractInlineScripts(path.join(WEB, 'config.html')), sandbox, { filename: 'config.html' });
    sandbox.__posts = posts;
    return sandbox;
}

function peek(ctx, expr) { return vm.runInContext(expr, ctx); }

// 排队模式下把定时器按顺序跑掉（新排进来的也算下一轮），最多 steps 轮，
// 防止被测代码里的递归定时器把用例挂死。
function flushTimers(ctx, steps) {
    for (let i = 0; i < (steps || 20) && ctx.__timers.length; i++) {
        ctx.__timers.shift()();
    }
}
// 让 fetch → then → then 的微任务链跑完（不依赖真实时钟）
const tick = () => new Promise((resolve) => setImmediate(resolve));

const ctx = buildSandbox();
const devices = () => JSON.parse(peek(ctx, 'JSON.stringify(_devices)'));

// loadConfig() 是文件末尾直接调用的 async 函数：等它的微任务跑完再断言
setTimeout(async () => {
    console.log('\n-- 配置标题与添加按钮文案 --');
    {
        const html = fs.readFileSync(path.join(WEB, 'config.html'), 'utf8');
        const addButton = html.match(/<button[^>]*onclick="addDevice\(\)"[^>]*>([\s\S]*?)<\/button>/)[1];
        ok(!addButton.includes('+'), '添加充电器按钮不显示加号');
        ok(!html.includes('data-i18n="config.multiDeviceBeta"'), '设备标题不显示 Beta 标记');
        eq(peek(ctx, "I18N.t('config.devicesSection')"), 'CUKTECH 10 Ultra', '中文界面使用英文产品名');
        const en = fs.readFileSync(path.join(WEB, 'static/locales/en.js'), 'utf8');
        ok(/devicesSection:\s*'CUKTECH 10 Ultra'/.test(en), '英文界面使用相同产品名');
    }

    console.log('\n-- 加载：设备清单来自 /api/devices，凭据来自 /api/config --');
    {
        const list = devices();
        eq(list.length, 2, '两台设备各生成一张卡片');
        eq(list[0].is_primary, true, '第一张恒为 primary');
        eq(list[0].id, 'default', 'primary 的 id 固定为 default（不可配置）');
        eq(list[0].name, '书房充电器', 'primary 名字取自 /api/devices');
        eq(list[0].token, '****1234', 'primary 的 token 用 /api/config 的掩码值预填（原值不下发）');
        eq(list[1].id, 'desk', '第二台是附加设备');
        eq(list[1].topic_prefix, '', '自动派生的 topic 前缀保持自动，随基前缀与设备ID变化');
        eq(list[1].token, '', '非 primary 的 token 页面拿不到 → 留空 = 保持不变');
        ok(peek(ctx, 'document.getElementById("deviceList").innerHTML').indexOf('device-card-1') >= 0,
           '两张卡片确实渲染进列表');
        ok(peek(ctx, 'document.getElementById("deviceList").innerHTML').indexOf('主设备') >= 0,
           'primary 卡片上标了"主设备"');
    }

    console.log('\n-- 重命名：主设备名称可修改并清空 --');
    {
        peek(ctx, "updateDeviceField(0, 'name', '新的充电器名称')");
        await peek(ctx, 'saveConfig()');
        let post = ctx.__posts.filter(p => p.url.includes('/api/config')).pop();
        eq(post.body.config.ble.name, '新的充电器名称', '重命名写入保存请求');
        peek(ctx, "updateDeviceField(0, 'name', '')");
        await peek(ctx, 'saveConfig()');
        post = ctx.__posts.filter(p => p.url.includes('/api/config')).pop();
        eq(post.body.config.ble.name, '', '清空名称必须显式保存，不能保留旧名');
        peek(ctx, "updateDeviceField(0, 'name', '书房充电器')");
    }

    console.log('\n-- 编辑设备标识时保留旧凭据来源 --');
    {
        peek(ctx, "updateDeviceField(1, 'id', 'office')");
        await peek(ctx, 'saveConfig()');
        const post = ctx.__posts.filter(p => p.url.includes('/api/config')).pop();
        eq(post.body.config.devices[0].source_id, 'desk', '保存额外设备的原始标识供继承凭据');
        peek(ctx, "updateDeviceField(1, 'id', 'desk')");
    }

    console.log('\n-- 任意卡片都可删除：删主设备后下一台自动顶上 --');
    {
        ok(peek(ctx, 'document.getElementById("deviceList").innerHTML').indexOf('removeDevice(0)') >= 0,
           '主设备卡片也有删除按钮');
        peek(ctx, `_bemfaEntities = [
            { name: 'C口1开关', device: 'default', port: 'c1' },
            { name: '书桌 C1', device: 'desk', port: 'c1' },
        ]; renderBemfaEntities()`);

        peek(ctx, 'removeDevice(0)');
        const list = devices();
        eq(list.length, 1, '删掉主设备 → 只剩一台');
        eq(list[0].is_primary, true, '剩下那台自动成为 primary');
        eq(list[0].id, 'default', '提升后 id 恒为 default');
        eq(list[0].source_id, 'desk', '保留旧 id 供服务端继承凭据 / 查明文');
        eq(list[0].token, '', '页面拿不到明文，凭据交给服务端继承');
        eq(list[0].topic_prefix, '', '旧 topic 前缀不再适用于 primary');
        eq(JSON.parse(peek(ctx, 'JSON.stringify(_bemfaEntities)')),
           [{ name: '书桌 C1', device: 'default', port: 'c1' }],
           '旧主设备的实体被删、被提升设备的实体重绑到 default');
        ok(peek(ctx, 'document.getElementById("deviceList").innerHTML').indexOf('removeDevice(0)') >= 0,
           '提升后的卡片依旧可删');

        await peek(ctx, 'saveConfig()');
        const post = ctx.__posts.filter((p) => p.url.indexOf('/api/config') >= 0).pop();
        eq(post.body.primary_credential_source, 'desk', '保存告诉服务端从旧 devices.desk 继承凭据');
        eq(post.body.config.ble.mac, 'AA:BB:CC:DD:EE:02', 'ble 节换成被提升那台的 MAC');
        eq(post.body.config.devices.length, 0, 'devices 节相应清空');
        ok('name' in post.body.config.ble, '主设备换了身份 → 显式清掉旧 ble.name');

        // 删到一张不剩：旧实现会插回一张空白卡并拦住保存
        peek(ctx, 'removeDevice(0)');
        eq(devices().length, 0, '删光后是空态，不再自动插回空白卡');
        const before = ctx.__posts.length;
        await peek(ctx, 'saveConfig()');
        ok(ctx.__posts.length > before, '删光充电器仍能保存');
        const empty = ctx.__posts[ctx.__posts.length - 1].body.config;
        eq(empty.ble.mac, '', '空态保存会清空 ble.mac（不留幽灵设备）');
        eq(empty.devices.length, 0, '空态保存不带附加设备');

        // 复原成加载态，供后面的用例使用
        await peek(ctx, 'loadConfig()');
    }

    console.log('\n-- 保存 payload：第一台展开回 ble: 节，其余进 devices: 节 --');
    {
        // 用户在新加的设备上填了 id/mac/token
        peek(ctx, 'addDevice()');
        eq(devices().length, 3, 'addDevice() 追加一张卡片');
        peek(ctx, `updateDeviceField(2, 'id', 'balcony')`);
        peek(ctx, `updateDeviceField(2, 'name', '阳台充电器')`);
        peek(ctx, `updateDeviceField(2, 'mac', 'AA:BB:CC:DD:EE:03')`);
        peek(ctx, `updateDeviceField(2, 'token', 'tok-balcony')`);
        // 第二台补上凭据（页面拿不到原值，用户重填才会上报）
        peek(ctx, `updateDeviceField(1, 'token', 'tok-desk')`);

        await peek(ctx, 'saveConfig()');
        const post = ctx.__posts.filter((p) => p.url.indexOf('/api/config') >= 0).pop();
        ok(!!post, '保存走了 POST /api/config');
        const cfg = post.body.config;

        eq(cfg.ble.mac, 'AA:BB:CC:DD:EE:01', 'ble 节拿到的就是 primary 的 mac');
        eq(cfg.ble.token, '****1234', 'primary 的掩码 token 原样回传（服务端据此保留原值）');
        eq(cfg.ble.name, '书房充电器', 'primary 的显示名随卡片一起回写（与 /api/devices 报来的一致）');

        eq(cfg.devices.length, 2, 'devices 节 = 除 primary 外的两台');
        eq(cfg.devices[0].id, 'desk', '附加设备 id 字段名与 config.py 一致');
        eq(cfg.devices[0].topic_prefix, '',
           '/api/devices 给的已解析前缀若等于默认派生值就不落盘（改基前缀才生效）');
        eq(cfg.devices[0].token, 'tok-desk', '用户重填的 token 上报');
        ok(!('bemfa_ble' in cfg.devices[0]), '空的 bemfa 覆盖项不写进 YAML');
        eq(cfg.devices[1].id, 'balcony', '新加的设备也进 devices 节');
        eq(cfg.devices[1].name, '阳台充电器', '名字一并保存');
        eq(cfg.devices[1].mac, 'AA:BB:CC:DD:EE:03', 'mac 一并保存');
        ok(!('is_primary' in cfg.devices[1]) && !('connected' in cfg.devices[1]),
           'payload 只带配置字段（不含运行时的 is_primary/connected）');

        // 设备清单加载真实名字，主动清空应恢复默认名称。
        peek(ctx, `updateDeviceField(0, 'name', '')`);
        await peek(ctx, 'saveConfig()');
        const postCleared = ctx.__posts.filter((p) => p.url.indexOf('/api/config') >= 0).pop();
        eq(postCleared.body.config.ble.name, '', '清空名字时显式写空串恢复默认名称');

        // 主设备起名后要写回 ble.name
        peek(ctx, `updateDeviceField(0, 'name', '书房主充')`);
        await peek(ctx, 'saveConfig()');
        const post2 = ctx.__posts.filter((p) => p.url.indexOf('/api/config') >= 0).pop();
        eq(post2.body.config.ble.name, '书房主充', 'primary 起了名就写进 ble.name');
    }

    console.log('\n-- 本地校验拦下明显会起不来的配置 --');
    {
        // 非法设备 id：服务端 validate_device_specs 会拒绝启动，必须在前端先拦
        peek(ctx, `updateDeviceField(1, 'id', 'Desk 1')`);
        const before = ctx.__posts.length;
        await peek(ctx, 'saveConfig()');
        eq(ctx.__posts.length, before, '非法 id → 不提交（不会被重启后才发现的错误拖下水）');
        peek(ctx, `updateDeviceField(1, 'id', 'desk')`);

        // 新增设备缺 token 必须拦：服务端没有旧值可继承
        peek(ctx, `updateDeviceField(2, 'token', '')`);
        const before2 = ctx.__posts.length;
        await peek(ctx, 'saveConfig()');
        eq(ctx.__posts.length, before2, '新增设备缺 token → 不提交');
        peek(ctx, `updateDeviceField(2, 'token', 'tok-balcony')`);

        // 已有设备不重填 token 也要能保存：页面拿不到明文，空串 = 保持不变，
        // 服务端按 id 从旧 YAML 继承。以前这里一律拦下，改个 MQTT 地址都存不了。
        peek(ctx, `updateDeviceField(1, 'token', '')`);
        const before3 = ctx.__posts.length;
        await peek(ctx, 'saveConfig()');
        ok(ctx.__posts.length > before3, '已有附加设备 token 留空 → 不该拦保存');
        peek(ctx, `updateDeviceField(1, 'token', 'tok-desk')`);
    }

    console.log('\n-- 设备改名：巴法云实体重绑必须用 trim 后的 id --');
    {
        // 落盘写的是 d.id.trim()、validateDevices 也按 trim 后的值校验；重绑若拿
        // 原始输入（'desk ' 带尾空格），本地校验会通过、设备 id 存成 desk、实体却
        // 指向 'desk ' —— 服务端随后以「实体指向的设备不存在」拒收整份配置。
        peek(ctx, `updateDeviceField(1, 'token', 'tok-desk')`);   // 上一节清空过
        peek(ctx, `_bemfaEntities.push({ name: 'tmp-trim-row', device: 'desk', port: 'c1' })`);
        peek(ctx, `updateDeviceField(1, 'id', 'desk ')`);
        const rows = JSON.parse(peek(ctx, 'JSON.stringify(_bemfaEntities)'));
        ok(!rows.some(r => r.device === 'desk '), '实体不会绑到带尾空格的 id 上');
        ok(rows.some(r => r.device === 'desk'), '实体跟着改成 trim 后的 id');

        // 存一次：payload 里必须是 trim 后的 id（否则服务端校验直接拒收）
        const before = ctx.__posts.length;
        await peek(ctx, 'saveConfig()');
        ok(ctx.__posts.length > before, '尾空格不该让保存被前端拦下（校验按 trim 后的值）');
        const saved = ctx.__posts[ctx.__posts.length - 1];
        const savedIds = (saved.body.config.devices || []).map(d => d.id);
        ok(!savedIds.some(id => id !== String(id).trim()),
           `落盘的设备 id 必须是 trim 过的，实际：${JSON.stringify(savedIds)}`);

        // 复原给后续用例：id 改回 'desk'，临时那行实体删掉
        peek(ctx, `updateDeviceField(1, 'id', 'desk')`);
        peek(ctx, `_bemfaEntities = _bemfaEntities.filter(e => e.name !== 'tmp-trim-row')`);
    }

    console.log('\n-- 巴法云语音开关表：一行 = (名字, 设备, 端口) --');
    {
        const rows = () => JSON.parse(peek(ctx, 'JSON.stringify(_bemfaEntities)'));
        // 上一节把 desk 的 token 清空着，先补回来，本节的保存用例才走得通
        peek(ctx, `updateDeviceField(1, 'token', 'tok-desk')`);

        // 老配置（没有 entities 键）→ 把 primary 的 5 个名字铺回成表，名字沿用默认值
        eq(rows().length, 5, '老配置加载出 5 行（C1/C2/C3/USB-A/蓝牙）');
        eq(rows()[0], { name: 'C口1开关', device: 'default', port: 'c1' },
           'primary 的默认名沿用老配置里的「C口1开关」（零迁移）');
        eq(rows().map(r => r.port), ['c1', 'c2', 'c3', 'a', 'ble'], '端口顺序固定');

        // 「按设备生成」：每台设备 × 5 个开关，名字带设备名（否则 N 台的开关全同名）
        const nDev = devices().length;
        peek(ctx, 'autoFillBemfaEntities()');
        eq(rows().length, nDev * 5, `每台设备 × 5 个开关（当前 ${nDev} 台）`);
        ok(rows().some(r => r.device === 'desk' && r.port === 'c1' && r.name === '书桌充电器 C口1'),
           '附加设备的开关名带设备名（巴法云 App 里分得清是谁）');
        ok(rows().some(r => r.device === 'default' && r.port === 'c1' && r.name === 'C口1开关'),
           'primary 仍然用老名字');

        // 改绑设备：名字还是默认值时跟着改（用户手改过的名字不动）
        peek(ctx, 'seedBemfaEntities({})');   // 复位成 primary 的 5 行
        peek(ctx, `updateBemfaEntity(0, 'device', 'desk')`);
        eq(rows()[0], { name: '书桌充电器 C口1', device: 'desk', port: 'c1' },
           '默认名跟着设备走');
        peek(ctx, `updateBemfaEntity(0, 'name', '我起的名字')`);
        peek(ctx, `updateBemfaEntity(0, 'port', 'c2')`);
        eq(rows()[0].name, '我起的名字', '用户起过的名字不跟着端口改');

        // 删设备 → 绑在它身上的开关必须一起走（否则保存被 400 拦下，用户一脸懵）
        peek(ctx, 'seedBemfaEntities({})');
        peek(ctx, `updateBemfaEntity(0, 'device', 'desk')`);
        eq(rows().filter(r => r.device === 'desk').length, 1, '先绑一行到 desk');
        peek(ctx, 'removeDevice(1)');
        eq(rows().filter(r => r.device === 'desk').length, 0, '删设备连带删它的开关');
        eq(rows().length, 4, '其余 4 行不受影响');
        peek(ctx, `_devices.splice(1, 0, { id: 'desk', name: '书桌充电器', mac: 'AA:BB:CC:DD:EE:02',
                 token: '', ble_key: '', topic_prefix: '', bemfa_ble: '', is_primary: false, connected: false })`);
        peek(ctx, `updateDeviceField(1, 'token', 'tok-desk')`);

        // 保存 payload：实体表 + 老字段 name_c* 双写。**显式记录下标**：
        // pop() 会拿到上一节的 POST，断言等于白测。
        peek(ctx, 'seedBemfaEntities({})');
        const idx = ctx.__posts.length;
        await peek(ctx, 'saveConfig()');
        const post = ctx.__posts[idx];
        ok(!!post && post.url.indexOf('/api/config') >= 0, '保存确实提交了');
        const b = post.body.config.bemfa;
        eq(b.entities.length, 5, 'entities 就是表格本身');
        eq(b.entities[0], { name: 'C口1开关', device: 'default', port: 'c1' }, '字段名与服务端一致');
        eq(b.name_c1, 'C口1开关', '老字段 name_c1 照旧写（旧工具读它）');
        eq(b.name_ble, '蓝牙开关', 'name_ble 映射到 ble 那一行');

        // 重复绑定挡在保存之前：服务端会拒，但用户等到重启后才知道就太晚了
        peek(ctx, `_bemfaEntities.push({ name: '重复的', device: 'default', port: 'c1' })`);
        const before = ctx.__posts.length;
        await peek(ctx, 'saveConfig()');
        eq(ctx.__posts.length, before, '同一台设备的同一个口重复 → 不提交');
        peek(ctx, 'seedBemfaEntities({})');
    }

    console.log('\n-- 语音开关区：默认折叠，点开才编辑 --');
    {
        // 默认收起：5 个开关就要 400+ 像素，常驻展开会把 MQTT/服务器挤到看不见的地方
        peek(ctx, 'setBemfaOpen(false)');
        eq(peek(ctx, 'document.getElementById("bemfaBody").hidden'), true,
           '默认折叠：表体 hidden');
        eq(peek(ctx, 'document.getElementById("bemfaToggle").getAttribute("aria-expanded")'), 'false',
           '折叠头 aria-expanded=false');
        ok(peek(ctx, 'JSON.stringify(_bemfaEntities.length)') !== '0',
           '折叠不影响数据（保存/校验/删设备连带清理都不该依赖展开状态）');

        // 计数徽标：收起时也能看出"我配了几个"
        ok(peek(ctx, 'document.getElementById("bemfaCount").textContent').indexOf('5') >= 0,
           '折叠头显示数量摘要');

        peek(ctx, 'toggleBemfaSection()');
        eq(peek(ctx, 'document.getElementById("bemfaBody").hidden'), false, '点一下展开');
        eq(peek(ctx, 'document.getElementById("bemfaToggle").getAttribute("aria-expanded")'), 'true',
           '展开后 aria-expanded=true');
        peek(ctx, 'toggleBemfaSection()');
        eq(peek(ctx, 'document.getElementById("bemfaBody").hidden'), true, '再点收回去');

        // 「按设备生成」/「+ 添加」必须把结果摆到用户眼前
        peek(ctx, 'setBemfaOpen(false)');
        peek(ctx, 'addBemfaEntity()');
        eq(peek(ctx, 'document.getElementById("bemfaBody").hidden'), false, '新增后自动展开');

        // 删最后一条要问一次：空表 = 保存后云端开关被删掉
        peek(ctx, 'seedBemfaEntities({})');
        peek(ctx, `_bemfaEntities.splice(0, _bemfaEntities.length - 1)`);
        peek(ctx, 'renderBemfaEntities()');
        ctx.__confirmAnswer = false;
        peek(ctx, 'removeBemfaEntity(0)');
        eq(peek(ctx, 'JSON.stringify(_bemfaEntities.length)'), '1',
           '取消确认 → 最后一条保留（不会静默删光云端开关）');
        ctx.__confirmAnswer = true;
        peek(ctx, 'removeBemfaEntity(0)');
        eq(peek(ctx, 'JSON.stringify(_bemfaEntities.length)'), '0', '确认后真删');
        peek(ctx, 'seedBemfaEntities({})');
    }

    console.log('\n-- 老配置的实体种子：必须照服务端派生清单铺（否则保存即丢别人的开关） --');
    {
        // 服务端 GET /api/config 现在直接给派生结果：`allowed_devices × 5`，
        // 名字也由服务端给 —— 前端不再自己拼（拼出来的和注册时的显示名会漂移）。
        peek(ctx, `seedBemfaEntities({
            entitiesDefined: false,
            allowedDevices: ['*'],
            derivedEntities: [
                { name: 'C口1开关', device: 'default', port: 'c1' },
                { name: 'C口2开关', device: 'default', port: 'c2' },
                { name: 'C口3开关', device: 'default', port: 'c3' },
                { name: 'USB-A开关', device: 'default', port: 'a' },
                { name: '蓝牙开关', device: 'default', port: 'ble' },
                { name: '书桌充电器 C口1', device: 'desk', port: 'c1' },
                { name: '书桌充电器 C口2', device: 'desk', port: 'c2' },
                { name: '书桌充电器 C口3', device: 'desk', port: 'c3' },
                { name: '书桌充电器 USB-A', device: 'desk', port: 'a' },
                { name: '书桌充电器 蓝牙开关', device: 'desk', port: 'ble' },
            ],
        })`);
        const rows = JSON.parse(peek(ctx, 'JSON.stringify(_bemfaEntities)'));
        eq(rows.length, 10, '老配置 + allowed_devices=["*"] → 两台设备各 5 个开关');
        ok(rows.some(r => r.device === 'desk' && r.port === 'ble'), '附加设备的开关没被漏掉');
        eq(rows[5], { name: '书桌充电器 C口1', device: 'desk', port: 'c1' },
           '名字用服务端给的（与注册时一致，不漂移）');

        // 旧服务端没有 derivedEntities 时兜底成 primary 的 5 行（不能空表）
        peek(ctx, 'seedBemfaEntities({ entitiesDefined: false })');
        eq(peek(ctx, 'JSON.stringify(_bemfaEntities.length)'), '5', '缺 derivedEntities → 兜底 5 行');
        peek(ctx, 'seedBemfaEntities({})');
    }

    console.log('\n-- 米家：勾选多台一次导入 + 名称同步 --');
    {
        // 云端清单：desk 是**已配置**的（MAC 大小写/分隔符不同，必须认成同一台），
        // 另一台是新设备（英文名 → 用它生成合法 id）
        peek(ctx, `showDeviceList({ cuktech: [
            { did: 'did-desk', name: '书桌（米家）', mac: 'AABBCCDDEE02', model: 'njcuk01' },
            { did: 'did-new', name: 'Bedroom', mac: 'aa:bb:cc:dd:ee:09', model: 'njcuk01' },
        ] })`);
        eq(peek(ctx, 'JSON.stringify(_xiaomiDevices.length)'), '2', '清单落在页面上（不是逐台点选）');
        eq(peek(ctx, 'JSON.stringify(Array.from(_xiaomiSelected))'), '["did-new"]',
           '默认只勾"还没配置过"的那台（已配置的不会被重复添加）');
        ok(peek(ctx, 'document.getElementById("xiaomiDevices").innerHTML').indexOf('已配置') >= 0,
           '已配置的设备在清单里标出来');
        ok(peek(ctx, 'document.getElementById("xiaomiDevices").innerHTML').indexOf('checkbox') >= 0,
           '每行是勾选框（多选的前提）');

        // 勾上全部 + 同步名称，一次导入；顺手把"自动关窗 / 提示 / 跳主页"做成探针
        ctx.__closed = 0;
        ctx.__navigated = null;
        ctx.__toasts = [];
        peek(ctx, `closeXiaomiModal = function () { __closed++; }`);
        peek(ctx, `showToast = function (m) { __toasts.push(m); }`);
        peek(ctx, `_xiaomiSessionId = 'sess1'`);
        const before = devices();
        peek(ctx, `document.getElementById('xiaomiSyncNames').checked = true; xiaomiSelectAll(true)`);
        ctx.__xiaomiImport = {
            ok: true,
            devices: [
                { did: 'did-desk', name: '书桌（米家）', mac: 'AABBCCDDEE02',
                  token: 'new-token-desk', model: 'njcuk01', ble_key: 'key-desk' },
                { did: 'did-new', name: 'Bedroom', mac: 'aa:bb:cc:dd:ee:09',
                  token: 'new-token-2', model: 'njcuk01', ble_key: 'key-2' },
            ],
        };
        const postsBefore = ctx.__posts.length;
        ctx.__syncTimers = false;  // 跳主页是定时器驱动的，手动 flush 才可控
        await peek(ctx, 'importXiaomiSelected()');

        const post = ctx.__posts.filter((p) => p.url.indexOf('/api/xiaomi/import') >= 0).pop();
        ok(!!post, '导入走 /api/xiaomi/import（批量端点）');
        eq(post.body.dids.sort(), ['did-desk', 'did-new'], '一次把选中的 did 全发出去');
        eq(post.body.session_id, 'sess1', '会话 id 跟着走');

        const after = devices();
        const byMac = (list, mac) => list.find((d) =>
            String(d.mac || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase() === mac);
        eq(after.length, before.length + 1, '已配置的更新、新的追加（只多一张卡片）');
        const desk = byMac(after, 'aabbccddee02');
        eq(desk.token, 'new-token-desk', '按 MAC 匹配到已有卡片并更新 token');
        eq(desk.ble_key, 'key-desk', 'BLE Key 一起更新');
        eq(desk.name, '书桌（米家）', '勾了同步名称 → 覆盖卡片里的旧名字');
        const fresh = byMac(after, 'aabbccddee09');
        ok(!!fresh, '新设备被追加进卡片列表');
        eq(fresh.name, 'Bedroom', '新设备的名称来自云端（同步名称的核心诉求）');
        eq(fresh.id, 'bedroom', '英文名生成合法设备 id（小写 slug）');
        eq(fresh.token, 'new-token-2', 'token 写入');
        eq(fresh.ble_key, 'key-2', 'BLE Key 写入');

        // 导入 ≠ 已添加：/api/xiaomi/import 只回凭据、不落盘，必须顺手保存，
        // 否则用户以为加上了，一刷新配置页全没了
        const cfgPost = ctx.__posts.slice(postsBefore)
            .filter((p) => p.url.indexOf('/api/config') >= 0).pop();
        ok(!!cfgPost, '导入成功后自动落盘（不然"已添加"是假的）');
        const savedMacs = [cfgPost.body.config.ble.mac]
            .concat(cfgPost.body.config.devices.map((d) => d.mac))
            .map((m) => String(m).replace(/[^0-9a-fA-F]/g, '').toLowerCase());
        ok(savedMacs.indexOf('aabbccddee09') >= 0, '新设备进了保存 payload');
        eq(cfgPost.body.config.devices[0].token, 'new-token-desk',
           '被更新的附加设备凭据也写进 payload（不是只有内存里改）');

        ok(ctx.__toasts.some((m) => m.indexOf('已添加') >= 0),
           '提示"已添加"（不是让用户再点一次保存）');
        eq(ctx.__closed, 1, '导入成功后自动关窗（不再停在"请至少选择一台设备"的灰按钮上）');

        // 服务重启有空窗：先等过窗口（此时健康检查失败），恢复后才跳主页
        ctx.__health = 'down';
        flushTimers(ctx);
        await tick();
        eq(ctx.__navigated, null, '服务还没起来时不能跳（否则 ERR_CONNECTION_REFUSED）');
        ctx.__health = 'up';
        flushTimers(ctx);
        await tick();
        eq(ctx.__navigated, '/', '服务回来后自动回主页（用户要看的是主面板）');
    }

    console.log('\n-- 米家：不勾"同步名称"时保留用户自己起的名字 --');
    {
        peek(ctx, `findDeviceIndex(d => normMac(d.mac) === 'aabbccddee02')`);
        peek(ctx, `_devices[findDeviceIndex(d => normMac(d.mac) === 'aabbccddee02')].name = '我自己起的名字'`);
        peek(ctx, `showDeviceList({ cuktech: [
            { did: 'did-desk', name: '书桌（米家）', mac: 'aabbccddee02', model: 'njcuk01' } ] })`);
        peek(ctx, `document.getElementById('xiaomiSyncNames').checked = false; xiaomiSelectAll(true)`);
        ctx.__xiaomiImport = {
            ok: true,
            devices: [{ did: 'did-desk', name: '书桌（米家）', mac: 'aabbccddee02',
                        token: 'rotated-token', model: 'njcuk01', ble_key: 'key-3' }],
        };
        await peek(ctx, 'importXiaomiSelected()');
        const after = devices();
        const desk = after.find((d) =>
            String(d.mac || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase() === 'aabbccddee02');
        eq(desk.name, '我自己起的名字', '没勾同步名称 → 用户起的名字不能被覆盖');
        eq(desk.token, 'rotated-token', '但凭据照常更新（换 token 是导入的主要用途）');
    }

    console.log('\n-- 米家：生成的设备 id 要避开保留字（否则保存时才被 400 拦下） --');
    {
        peek(ctx, `_xiaomiSessionId = 'sess1'`);
        peek(ctx, `showDeviceList({ cuktech: [
            { did: 'did-set', name: 'set', mac: 'aa:bb:cc:dd:ee:11', model: 'njcuk01' } ] })`);
        peek(ctx, `xiaomiSelectAll(true)`);
        ctx.__xiaomiImport = {
            ok: true,
            devices: [{ did: 'did-set', name: 'set', mac: 'aa:bb:cc:dd:ee:11',
                        token: 't-set', model: 'njcuk01', ble_key: 'k-set' }],
        };
        await peek(ctx, 'importXiaomiSelected()');
        const added = devices().find((d) =>
            String(d.mac || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase() === 'aabbccddee11');
        ok(!!added, '新设备照常导入');
        ok(['all', 'set', 'port', 'status', 'settings', 'ble', 'charge_event', 'default']
            .indexOf(added.id) < 0, `生成的 id 撞上保留字（${added.id}）`);
        ok(/^[a-z0-9][a-z0-9_-]*$/.test(added.id), `id 必须合法（${added.id}）`);
    }

    console.log('\n-- 米家：没选设备时不该发请求 --');
    {
        const before = ctx.__posts.filter((p) => p.url.indexOf('/api/xiaomi/import') >= 0).length;
        peek(ctx, 'xiaomiSelectAll(false)');
        await peek(ctx, 'importXiaomiSelected()');
        eq(ctx.__posts.filter((p) => p.url.indexOf('/api/xiaomi/import') >= 0).length, before,
           '空选择 → 不发请求（只在界面提示）');
        eq(peek(ctx, 'JSON.stringify(_xiaomiDevices.length)'), '1', '清单还在（可以改选）');
    }

    console.log('\n-- 配置加载与设置失败保护 --');
    {
        const originalFetch = ctx.fetch;
        ctx.fetch = (url, init) => (!init && String(url).includes('/api/devices'))
            ? Promise.resolve({ok:false,status:503,json:async()=>({ok:false,error:'offline'})})
            : originalFetch(url, init);
        await peek(ctx, 'loadConfig()');
        eq(peek(ctx, '_configStatus'), 'error', '设备清单加载失败不能显示加载成功');
        const before = ctx.__posts.filter(p=>p.url.includes('/api/config')).length;
        await peek(ctx, 'saveConfig({quiet:true})');
        eq(ctx.__posts.filter(p=>p.url.includes('/api/config')).length,before,
            '加载失败时禁止用不完整设备清单覆盖配置');
        ctx.fetch = originalFetch;
        await peek(ctx, 'loadConfig()');
        eq(peek(ctx,'document.getElementById("btnSave").disabled'),false,'重试加载成功后允许保存');
    }
    {
        const originalFetch = ctx.fetch;
        await peek(ctx,"setLogLevel('warning')");
        ctx.fetch = (url,init)=> String(url).includes('/api/log-level') && init
            ? Promise.resolve({json:async()=>({ok:false,error:'offline'})}) : originalFetch(url,init);
        peek(ctx,"document.getElementById('server_log_level').value='debug'");
        await peek(ctx,"setLogLevel('debug')");
        eq(peek(ctx,"document.getElementById('server_log_level').value"),'warning',
            '日志等级失败时恢复最近成功保存的等级');
        ctx.fetch = originalFetch;
    }
    {
        const originalFetch = ctx.fetch;
        ctx.fetch = (url,init)=>String(url).includes('/api/web-language') && init
            ? Promise.resolve({json:async()=>({ok:false,error:'offline'})}) : originalFetch(url,init);
        peek(ctx,"document.getElementById('web_language').value='en'");
        await peek(ctx,"setWebLanguage('en')");
        eq(peek(ctx,"document.getElementById('web_language').value"),'auto',
            '语言保存失败时选择框恢复实际生效语言');
        ctx.fetch = originalFetch;
    }
    console.log('\n-- 端口校验与保存后跳转 --');
    {
        peek(ctx,"_devices=[]; _bemfaEntities=[]; _configStatus='loaded'");
        const before=ctx.__posts.length;
        peek(ctx,"document.getElementById('server_port').value='0'");
        await peek(ctx,'saveConfig({quiet:true})');
        eq(ctx.__posts.length,before,'端口0不得静默改成8199并保存');
        peek(ctx,"document.getElementById('server_port').value='1e3'");
        await peek(ctx,'saveConfig({quiet:true})');
        const exponentPost=ctx.__posts.filter(p=>p.url.includes('/api/config')).pop();
        eq(exponentPost.body.config.server.port,1000,'数字输入按实际数值保存，不能被parseInt截断');
        peek(ctx,"document.getElementById('server_port').value='18345'");
        ctx.__syncTimers=false;ctx.__timers=[];ctx.__navigated=null;ctx.__health='down';
        const originalFetch = ctx.fetch;
        ctx.fetch = (url,init)=>String(url).startsWith('http://charger.local:18345/api/health')
            ? (ctx.__health === 'down' || init.mode !== 'no-cors'
                ? Promise.reject(new Error('network/CORS'))
                : Promise.resolve({ok:false,status:0,type:'opaque'}))
            : originalFetch(url,init);
        await peek(ctx,'saveConfig()');
        flushTimers(ctx);await tick();
        ctx.__health='up';flushTimers(ctx);await tick();
        ctx.fetch = originalFetch;
        eq(ctx.__navigated,'http://charger.local:18345/config.html',
            '修改Web端口后等待新端口并打开新地址');
    }

    console.log('\n-- 保存期间修改表单不能改变已保存的跳转端口 --');
    for (const quiet of [false,true]) {
        const originalFetch=ctx.fetch;
        const polled=[];let finish;
        ctx.__syncTimers=false;ctx.__timers=[];ctx.__health='down';
        peek(ctx,"document.getElementById('server_port').value='18345'");
        ctx.fetch=(url,init)=>{
            if(String(url).includes('/api/health'))polled.push(String(url));
            const response=originalFetch(url,init);
            if(String(url).includes('/api/config')&&init&&init.method==='POST'){
                return new Promise(resolve=>{finish=()=>response.then(resolve)});
            }
            return response;
        };
        const pending=peek(ctx,`saveConfig({quiet:${quiet}})`);
        peek(ctx,"document.getElementById('server_port').value='18346'");
        finish();await pending;
        if(quiet)peek(ctx,'goHomeWhenServerBack()');
        flushTimers(ctx,1);await tick();
        eq(polled[0],'http://charger.local:18345/api/health',
            quiet?'导入后使用已提交端口':'普通保存后使用已提交端口');
        ctx.fetch=originalFetch;
    }

    console.log(failed === 0
        ? `\nAll ${passed} config device-list checks passed.`
        : `\n${failed}/${passed + failed} config device-list checks FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}, 0);
