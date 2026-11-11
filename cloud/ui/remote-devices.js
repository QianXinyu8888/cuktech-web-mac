(() => {
'use strict';

const el = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (text, handler) => {
  const node = el('button', text);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
};

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
  const response = await fetch(path, options);
  let data;
  try { data = await response.json(); }
  catch { throw new Error('服务器响应无效'); }
  if (!response.ok || data.ok === false) throw new Error(data.error || '请求失败');
  return data;
}

function setup() {
  const config = document.querySelector('[data-remote-config]');
  const actions = config?.querySelector('[data-remote-actions]') || el('div');
  if (config) {
    if (new URLSearchParams(location.search).get('from') === 'phone') {
      config.querySelector('[data-remote-back]').href = '/phone.html';
    }
  } else {
    actions.className = 'remote-actions remote-actions-page';
    (document.querySelector('.footer-inner') || document.querySelector('#app') || document.body).append(actions);
  }

  const open = button('管理设备', show);
  open.className = 'remote-devices-open';
  open.setAttribute('aria-haspopup', 'dialog');
  const logout = button('退出远程访问', async () => {
    logout.disabled = true;
    try {
      await api('/api/logout', {});
      location.replace('/login.html');
    } catch {
      logout.textContent = '退出失败，点此重试';
      logout.disabled = false;
    }
  });
  logout.className = 'remote-logout';
  actions.append(open, logout);

  const dialog = el('dialog');
  dialog.className = 'remote-devices-dialog';
  dialog.setAttribute('aria-labelledby', 'remote-devices-title');
  dialog.innerHTML = `
    <div class="remote-devices-head">
      <h2 id="remote-devices-title">设备管理</h2>
      <button type="button" data-close aria-label="关闭">×</button>
    </div>
    <p>在 Mac 上运行 <code>.venv/bin/python macos/esp_setup.py</code>，先扫码导入米家设备，再按本机助手提示连接 ESP32 配网热点。</p>
    <form data-register><label>新网关名称 <input name="name" maxlength="80" required></label><button>注册网关</button></form>
    <p data-status role="status" aria-live="polite"></p>
    <section data-secret hidden>
      <h3>一次性云端凭据</h3>
      <p>请立即复制并输入本机配网助手；关闭后无法再次查看。请勿分享。</p>
      <label>云端地址<input data-url readonly></label>
      <label>凭据<input data-token readonly></label>
      <button type="button" data-copy>复制凭据</button>
      <button type="button" data-clear>已保存，清除显示</button>
    </section>
    <form data-edit hidden>
      <h3 data-edit-title></h3>
      <p data-edit-warning></p>
      <label data-edit-name-label>新名称 <input name="name" maxlength="80"></label>
      <button data-edit-submit></button>
      <button type="button" data-edit-cancel>取消</button>
    </form>
    <ul data-list></ul>`;
  document.body.append(dialog);

  const status = dialog.querySelector('[data-status]');
  const list = dialog.querySelector('[data-list]');
  const secret = dialog.querySelector('[data-secret]');
  const token = dialog.querySelector('[data-token]');
  const url = dialog.querySelector('[data-url]');
  const closeButton = dialog.querySelector('[data-close]');
  const register = dialog.querySelector('[data-register]');
  const edit = dialog.querySelector('[data-edit]');
  const editName = edit.elements.name;
  const editSubmit = edit.querySelector('[data-edit-submit]');
  const editCancel = edit.querySelector('[data-edit-cancel]');
  const editWarning = edit.querySelector('[data-edit-warning]');
  let editTarget;
  let pending = false;

  function clearSecret() {
    token.value = '';
    url.value = '';
    secret.hidden = true;
  }
  function clearEdit() {
    edit.hidden = true;
    editTarget = null;
  }
  closeButton.onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => {
    if (pending) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    clearSecret();
    clearEdit();
    open.focus();
  });
  dialog.querySelector('[data-clear]').onclick = clearSecret;
  dialog.querySelector('[data-copy]').onclick = async () => {
    try {
      await navigator.clipboard.writeText(token.value);
      status.textContent = '凭据已复制，请粘贴到本机助手。';
    } catch { status.textContent = '复制失败，请手动选择凭据。'; }
  };

  function showSecret(data) {
    if (!data.provisioning?.cloud_token) throw new Error('未收到一次性凭据');
    token.value = data.provisioning.cloud_token;
    url.value = data.provisioning.cloud_url;
    secret.hidden = false;
  }

  const changes = {
    rename: { label: '改名', submit: '保存名称', success: '名称已更新。' },
    'rotate-token': {
      label: '轮换凭据',
      submit: '确认轮换',
      warning: '旧凭据将立即失效，网关会离线。请使用新凭据重新配网。',
      success: '凭据已轮换，请立即完成配网。'
    },
    revoke: {
      label: '撤销',
      submit: '确认撤销',
      warning: '网关将立即离线，凭据失效。历史记录会保留。',
      success: '网关已撤销，历史记录保留。'
    }
  };
  function showEdit(device, action, trigger) {
    if (pending) return;
    const change = changes[action];
    const rename = action === 'rename';
    editTarget = { device, action, trigger };
    edit.querySelector('[data-edit-title]').textContent = `${change.label} · ${device.name}`;
    editWarning.textContent = change.warning || '';
    editWarning.hidden = !change.warning;
    edit.querySelector('[data-edit-name-label]').hidden = !rename;
    editName.required = rename;
    editName.value = rename ? device.name : '';
    editSubmit.textContent = change.submit;
    edit.hidden = false;
    if (rename) {
      editName.focus();
      editName.select();
    } else editCancel.focus();
  }

  editCancel.onclick = () => {
    const trigger = editTarget?.trigger;
    clearEdit();
    trigger?.focus();
  };

  function addArchivedHistory(device, controls, row) {
    const history = el('div');
    controls.append(button('查看历史', async () => {
      try {
        const result = await api('/api/sessions?period=all&device=' + encodeURIComponent(device.id));
        history.replaceChildren(el('p', '历史会话（只读）'));
        for (const session of result.sessions || []) {
          const entry = el('p', new Date(session.start_time * 1000).toLocaleString() +
            ' · 端口 ' + session.port + ' · ' + Number(session.total_wh || 0).toFixed(2) + ' Wh ');
          const link = el('a', '导出曲线');
          link.href = '/api/sessions/' + encodeURIComponent(session.id) + '/export?device=' + encodeURIComponent(device.id);
          entry.append(link);
          history.append(entry);
        }
        if (!result.sessions?.length) history.append(el('p', '暂无历史会话'));
      } catch (error) { history.textContent = error.message; }
    }));
    row.append(controls, history);
  }

  async function refresh() {
    const data = await api('/api/devices?include_archived=1');
    list.replaceChildren();
    for (const device of data.devices) {
      const row = el('li');
      const archived = device.status === 'disabled';
      row.append(el('strong', device.name), el('span', archived
        ? '已撤销 · 仅可查看历史' : device.gateway_connected ? '网关在线' : '网关离线'));
      const controls = el('div');
      controls.className = 'remote-devices-actions';
      if (archived) {
        addArchivedHistory(device, controls, row);
      } else {
        for (const [action, change] of Object.entries(changes)) {
          controls.append(button(change.label, event => showEdit(device, action, event.currentTarget)));
        }
        row.append(controls);
      }
      list.append(row);
    }
  }

  async function show() {
    dialog.showModal();
    status.textContent = '正在读取设备…';
    try {
      await refresh();
      status.textContent = '';
    } catch (error) { status.textContent = error.message; }
  }

  async function mutate(operation) {
    if (pending) return;
    pending = true;
    const controls = [closeButton, register.querySelector('button'), editSubmit, editCancel];
    for (const control of controls) control.disabled = true;
    try {
      await operation();
      await refresh();
    } catch (error) { status.textContent = error.message; }
    finally {
      pending = false;
      for (const control of controls) control.disabled = false;
    }
  }

  register.onsubmit = event => {
    event.preventDefault();
    const input = register.elements.name;
    void mutate(async () => {
      const result = await api('/api/devices/register', { name: input.value });
      showSecret(result);
      input.value = '';
      status.textContent = '网关已注册，请立即完成配网。';
    });
  };
  edit.onsubmit = event => {
    event.preventDefault();
    if (!editTarget) return;
    const { device, action } = editTarget;
    void mutate(async () => {
      const result = await api('/api/devices/' + encodeURIComponent(device.id) + '/' + action,
        action === 'rename' ? { name: editName.value } : {});
      clearEdit();
      if (action === 'rotate-token') showSecret(result);
      status.textContent = changes[action].success;
    });
  };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
else setup();
})();
