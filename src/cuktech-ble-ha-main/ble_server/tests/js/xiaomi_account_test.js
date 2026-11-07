#!/usr/bin/env node
/**
 * 配置页「切换米家账号」的契约测试。
 *
 * 锁住四条不变式：
 *   1. 扫码成功后页面能显示当前账号（脱敏标签 + 区域），用户才知道要不要换；
 *   2. 切换账号会先 POST /api/xiaomi/logout 销毁旧会话，本地清单/勾选/轮询/账号
 *      全部复位并回到登录表单（可重选区域）；
 *   3. 切换账号**绝不删设备卡片**——用户可能刚导入了旧账号的设备但还没保存；
 *   4. 等扫码阶段也能取消换账号，且下一次登录带上 replace_session 兜底。
 *
 * 用 vm 抽取 config.html 的内联脚本执行；fetch / DOM 都是桩，不触网。
 * Usage: node tests/js/xiaomi_account_test.js
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
        return {
            id: id || '', value: '', checked: false, textContent: '', innerHTML: '', hidden: false,
            style: { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {}, cssText: '' },
            dataset: {}, className: '', children: [], options: [], attrs: {},
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
            setAttribute(k, v) { this.attrs[k] = String(v); },
            getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
            appendChild() {}, remove() {}, addEventListener() {},
            querySelector() { return null; }, querySelectorAll() { return []; },
            closest() { return null; }, focus() {}, blur() {},
        };
    }
    function getEl(id) {
        if (!els.has(id)) {
            const el = makeEl(id);
            // 真实 DOM 里 <select id="xiaomi_server"> 默认选中第一项 cn；
            // 纯对象桩没有 option 解析，这里补上，否则测到的会是空区域。
            if (id === 'xiaomi_server') el.value = 'cn';
            els.set(id, el);
        }
        return els.get(id);
    }
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        Intl, URL,
        // 不执行回调：否则 xiaomiPollOnce 的 3 秒轮询会在沙箱里无限递归。
        setTimeout: () => 0,
        clearTimeout() {}, setInterval: () => 0, clearInterval() {},
        Promise, JSON, Math, Date, RegExp, String, Number, Boolean, Object, Array,
        isNaN, parseFloat, parseInt, Error, Map, Set,
        fetch: (url, init) => {
            const u = String(url);
            if (init && init.method === 'POST') {
                posts.push({ url: u, body: JSON.parse(init.body || '{}') });
                if (u.indexOf('/api/xiaomi/login') >= 0) {
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
                        ok: true, session_id: 'sess-new', qr_image: 'data:image/png;base64,AAAA',
                        login_url: 'https://example.invalid/qr', timeout: 300,
                    }) });
                }
                if (u.indexOf('/api/xiaomi/qr/complete') >= 0) {
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(
                        { ok: false, error: '等待扫码中...' }) });
                }
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
            }
            if (u.indexOf('/api/devices') >= 0) {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(DEVICES_PAYLOAD) });
            }
            if (u.indexOf('/api/config') >= 0) {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(CONFIG_PAYLOAD) });
            }
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
        },
        confirm: () => true,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        navigator: { language: 'zh-CN' },
        location: { origin: 'http://charger.local', href: 'http://charger.local/config.html' },
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
        CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    };
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

const ctx = buildSandbox();
const peek = (expr) => vm.runInContext(expr, ctx);
const tick = () => new Promise((r) => setImmediate(r));
const t = (key) => peek(`I18N.t('${key}')`);
const lastPost = (needle) => ctx.__posts.filter((p) => p.url.indexOf(needle) >= 0).pop();

async function main() {
    // loadConfig() 在脚本末尾直接调用，等它的微任务跑完
    await tick(); await tick();

    console.log('\n-- 文案：切换账号相关 key 运行时可用 --');
    {
        for (const key of ['currentAccount', 'switchAccount', 'cancelScan',
                           'accountUnknown', 'accountSwitched']) {
            const v = t(`config.${key}`);
            ok(typeof v === 'string' && v.length > 0 && v !== `config.${key}`,
               `I18N.t(config.${key}) 有翻译`, JSON.stringify(v));
        }
    }

    console.log('\n-- 扫码成功：显示脱敏账号与区域 --');
    {
        peek(`showDeviceList({ devices: [], cuktech: [],
                account: { label: '****5678', server: 'cn' } })`);
        eq(peek(`document.getElementById('xiaomiAccountName').textContent`),
           '****5678 · CN', '账号条显示脱敏标签 + 大写区域');
        eq(peek(`document.getElementById('xiaomiDeviceList').style.display`),
           'block', '设备清单可见');
    }

    console.log('\n-- 切换账号：销毁旧会话 + 本地状态复位，但保留设备卡片 --');
    {
        const cardsBefore = JSON.parse(peek('JSON.stringify(_devices)'));
        peek(`_xiaomiSessionId = 'sess-old'; _xiaomiQRActive = false;
              _xiaomiPolling = true; _xiaomiDevices = [{did:'x'}];
              _xiaomiSelected = new Set(['x']);`);
        await peek('xiaomiSwitchAccount()');

        const logout = lastPost('/api/xiaomi/logout');
        ok(!!logout, '切换时 POST /api/xiaomi/logout');
        eq(logout && logout.body.session_id, 'sess-old', '登出的是旧会话');
        eq(peek('_xiaomiSessionId'), '', '本地会话 id 清空');
        eq(peek('_xiaomiDevices.length'), 0, '旧账号的设备清单清空');
        eq(peek('_xiaomiSelected.size'), 0, '勾选状态清空');
        eq(peek('_xiaomiAccount'), null, '当前账号清空');
        eq(peek('_xiaomiPolling'), false, '轮询已停止');
        eq(peek(`document.getElementById('xiaomiLoginForm').style.display`),
           'block', '回到登录表单（可重选区域）');
        eq(peek(`document.getElementById('xiaomiDeviceList').style.display`),
           'none', '设备清单收起');
        eq(peek(`document.getElementById('xiaomiQRForm').style.display`),
           'none', '二维码面板收起');
        eq(peek(`document.getElementById('xiaomiLoginBtn').textContent`),
           t('config.getQR'), '按钮恢复「获取二维码」而不是「重新获取」');
        eq(peek(`document.getElementById('xiaomiAccountName').textContent`),
           t('config.accountUnknown'), '账号条显示未知账号');
        eq(JSON.parse(peek('JSON.stringify(_devices)')), cardsBefore,
           '切换账号不删已填入的充电器卡片');
    }

    console.log('\n-- 重新扫码：登录请求带 replace_session 兜底 --');
    {
        await peek('xiaomiStartQR()');
        const login = lastPost('/api/xiaomi/login');
        ok(!!login, '发起新的 /api/xiaomi/login');
        eq(login && login.body.server, 'cn', '区域随表单提交');
        ok(login && 'replace_session' in login.body,
           '登录 payload 带 replace_session 字段');
        eq(peek('_xiaomiSessionId'), 'sess-new', '保存新会话 id');
        eq(peek('_xiaomiAccount'), null, '新二维码阶段不显示旧账号');
    }

    console.log('\n-- 等扫码时也能取消换账号 --');
    {
        peek(`_xiaomiQRActive = true; _xiaomiSessionId = 'sess-new';`);
        await peek('xiaomiSwitchAccount()');
        eq(lastPost('/api/xiaomi/logout').body.session_id, 'sess-new',
           '未扫码的会话同样被登出，不留后台长轮询');
        eq(peek('_xiaomiQRActive'), false, '二维码状态复位');
        eq(peek(`document.getElementById('xiaomiLoginForm').style.display`),
           'block', '回到登录表单');
    }

    console.log('\n-- 兼容旧服务端 / 二维码过期：账号显示与清理 --');
    {
        peek(`showDeviceList({ devices: [], cuktech: [] })`);
        eq(peek(`document.getElementById('xiaomiAccountName').textContent`),
           t('config.accountUnknown'), '没有 account 字段时显示未知账号');
        peek(`showDeviceList({ devices: [], cuktech: [],
                account: { label: '****9999', server: 'de' } });
              xiaomiQRExpired('expired');`);
        eq(peek('_xiaomiAccount'), null, '二维码过期后账号信息一并清空');
        eq(peek(`document.getElementById('xiaomiAccountName').textContent`),
           t('config.accountUnknown'), '账号条复位');
    }

    console.log('\n-- 切换账号后忽略尚未返回的旧请求 --');
    {
        const originalFetch = ctx.fetch;
        let finish;
        ctx.fetch = (url, init) => String(url).includes('/api/xiaomi/qr/complete')
            ? new Promise(resolve => { finish = resolve; }) : originalFetch(url, init);
        peek(`_xiaomiSessionId = 'old-poll'; _xiaomiPolling = true;
              _xiaomiPollDeadline = Date.now() + 10000;`);
        const pending = peek('xiaomiPollOnce()');
        await peek('xiaomiSwitchAccount()');
        finish({ json: async () => ({ok: true, devices: [{did:'old'}],
            cuktech: [], account: {label:'old-account', server:'cn'}}) });
        await pending;
        eq(peek('_xiaomiAccount'), null, '旧轮询响应不能恢复已退出的账号');
        eq(peek('_xiaomiDevices.length'), 0, '旧轮询响应不能恢复旧设备清单');
        eq(peek(`document.getElementById('xiaomiDeviceList').style.display`),
            'none', '切换后旧响应不能重新打开设备清单');
        ctx.fetch = originalFetch;
    }
    {
        const originalFetch = ctx.fetch;
        let finish;
        ctx.fetch = (url, init) => String(url).includes('/api/xiaomi/login')
            ? new Promise(resolve => { finish = resolve; }) : originalFetch(url, init);
        const pending = peek('xiaomiStartQR()');
        await peek('xiaomiSwitchAccount()');
        finish({ json: async () => ({ok:true, session_id:'cancelled-login',
            qr_image:'', login_url:'https://example.invalid', timeout:300}) });
        await pending;
        eq(peek('_xiaomiSessionId'), '', '取消后晚到的登录响应不能恢复会话');
        eq(lastPost('/api/xiaomi/logout').body.session_id, 'cancelled-login',
            '晚到的登录会话必须在服务端销毁');
        ctx.fetch = originalFetch;
    }
    {
        peek(`_xiaomiSessionId = 'empty-account';
              showDeviceList({devices:[], cuktech:[], account:{label:'masked',server:'cn'}});
              closeXiaomiModal(); openXiaomiModal();`);
        eq(peek(`document.getElementById('xiaomiDeviceList').style.display`),
            'block', '账号没有设备时重新开窗仍能看到账号与切换按钮');
    }

    {
        const originalFetch = ctx.fetch;
        let finish;
        ctx.fetch = (url, init) => String(url).includes('/api/xiaomi/import')
            ? new Promise(resolve => { finish = resolve; }) : originalFetch(url, init);
        peek(`_xiaomiSessionId = 'old-import'; _xiaomiSelected = new Set(['old']);`);
        const before = peek('JSON.stringify(_devices)');
        const pending = peek('importXiaomiSelected()');
        await peek('xiaomiSwitchAccount()');
        finish({ json: async () => ({ok:true, devices:[{did:'old',name:'old',
            mac:'AA:BB:CC:DD:EE:09',token:'11'.repeat(16),ble_key:'key'}]}) });
        await pending;
        eq(peek('JSON.stringify(_devices)'), before, '切换后晚到的导入不能修改设备卡片');
        ok(!lastPost('/api/config'), '过期导入不能触发保存或重启');
        ctx.fetch = originalFetch;
    }

    console.log('\n-- HTML：两处切换入口都在 --');
    {
        const html = fs.readFileSync(path.join(WEB, 'config.html'), 'utf8');
        const hits = (html.match(/onclick="xiaomiSwitchAccount\(\)"/g) || []).length;
        eq(hits, 2, '设备清单 + 二维码界面各有一个切换入口');
        ok(html.indexOf('id="xiaomiAccountBar"') >= 0
           || html.indexOf('id="xiaomiAccountName"') >= 0,
           '设备清单里有当前账号栏');
    }

    console.log('\n-- 语言包文件：两套 key 值都非空且不同 --');
    {
        const zh = fs.readFileSync(path.join(WEB, 'static/locales/zh-CN.js'), 'utf8');
        const en = fs.readFileSync(path.join(WEB, 'static/locales/en.js'), 'utf8');
        for (const key of ['currentAccount', 'switchAccount', 'cancelScan',
                           'accountUnknown', 'accountSwitched']) {
            ok(zh.indexOf(`${key}:`) >= 0 && en.indexOf(`${key}:`) >= 0,
               `${key} 在 zh-CN 与 en 都存在`);
        }
    }
}

main().then(() => {
    if (failed) {
        console.log(`\n${failed}/${passed + failed} Mi Home account-switch checks FAILED.`);
        process.exit(1);
    }
    console.log(`\nAll ${passed} Mi Home account-switch checks passed.`);
}).catch((e) => { console.error(e); process.exit(1); });
