'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const loginCard = $('loginCard');
  const panel = $('panel');
  const adminPw = $('adminPw');
  const loginBtn = $('loginBtn');
  const loginErr = $('loginErr');
  const rememberPw = $('rememberPw');
  const logoutLink = $('logoutLink');

  const newRoom = $('newRoom');
  const newPw = $('newPw');
  const newNote = $('newNote');
  const createBtn = $('createBtn');
  const createErr = $('createErr');
  const refreshBtn = $('refreshBtn');
  const roomTable = $('roomTable');
  const toastEl = $('toast');

  let token = localStorage.getItem('adminToken') || '';
  let refreshTimer = null;

  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body });
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    if (res.status === 401) {
      // token 失效，退回登录
      token = '';
      localStorage.removeItem('adminToken');
      showLogin();
      throw new Error('登录已过期，请重新登录');
    }
    if (!res.ok) throw new Error(data.error || ('请求失败 (' + res.status + ')'));
    return data;
  }

  function showLogin() {
    loginCard.classList.remove('hidden');
    panel.classList.add('hidden');
    logoutLink.classList.add('hidden');
  }

  function showPanel() {
    loginCard.classList.add('hidden');
    panel.classList.remove('hidden');
    logoutLink.classList.remove('hidden');
    loadRooms();
  }

  async function tryRestore() {
    if (!token) return showLogin();
    try {
      const me = await api('/api/admin/me');
      if (me.ok) showPanel();
      else showLogin();
    } catch {
      showLogin();
    }
  }

  // ---------- 登录 / 登出 ----------
  async function doLogin() {
    loginErr.textContent = '';
    const pw = adminPw.value;
    loginBtn.disabled = true;
    loginBtn.textContent = '登录中喵~…';
    try {
      const data = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      }).then((r) => r.json().then((d) => ({ ok: r.ok, d })));
      if (!data.ok) throw new Error(data.d.error || '登录失败喵~');
      token = data.d.token;
      localStorage.setItem('adminToken', token);
      if (rememberPw.checked) localStorage.setItem('adminRememberPw', pw);
      else localStorage.removeItem('adminRememberPw');
      adminPw.value = '';
      showPanel();
    } catch (e) {
      loginErr.textContent = e.message;
      loginCard.classList.remove('shake');
      void loginCard.offsetWidth; // 重排以重新触发动画
      loginCard.classList.add('shake');
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = '登录喵~';
    }
  }

  async function doLogout() {
    try { await api('/api/admin/logout', { method: 'POST' }); } catch { /* ignore */ }
    token = '';
    localStorage.removeItem('adminToken');
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    showLogin();
  }

  // ---------- 创建房间 ----------
  async function doCreate() {
    createErr.textContent = '';
    const room = newRoom.value.trim();
    if (!room) { createErr.textContent = '请输入房间名'; return; }
    try {
      await api('/api/admin/room/create', {
        method: 'POST',
        body: JSON.stringify({ room, password: newPw.value || null, note: newNote.value.trim() || null }),
      });
      newRoom.value = '';
      newPw.value = '';
      newNote.value = '';
      toast('房间已创建喵~');
      loadRooms();
    } catch (e) {
      createErr.textContent = e.message;
    }
  }

  // ---------- 房间列表 ----------
  function fmtTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  async function loadRooms() {
    try {
      const data = await api('/api/admin/rooms');
      renderRooms(data.rooms || []);
    } catch (e) {
      // 错误已在 api 内处理
    }
  }

  function renderRooms(rooms) {
    if (!rooms.length) {
      roomTable.innerHTML = '<div class="empty">还没有房间喵~，请在上方创建一个。</div>';
      return;
    }
    let html = '<table><thead><tr><th>房间名</th><th>备注</th><th>密码</th><th>消息</th><th>在线</th><th>创建于</th><th>操作</th></tr></thead><tbody>';
    for (const r of rooms) {
      const pwBadge = r.hasPassword
        ? '<span class="badge lock">已设密码</span>'
        : '<span class="badge open">无密码</span>';
      const noteCell = r.note
        ? escapeHtml(r.note)
        : '<span class="muted">—</span>';
      html += `<tr>
        <td>${escapeHtml(r.name)}</td>
        <td class="note-cell" title="${escapeAttr(r.note || '')}">${noteCell}</td>
        <td>${pwBadge}</td>
        <td>${r.messageCount}</td>
        <td>${r.online}</td>
        <td>${fmtTime(r.createdAt)}</td>
        <td><div class="ops">
          <button class="btn ghost sm" data-act="note" data-room="${escapeAttr(r.name)}" data-note="${escapeAttr(r.note || '')}">备注</button>
          <button class="btn ghost sm" data-act="pw" data-room="${escapeAttr(r.name)}">改密码</button>
          <button class="btn danger sm" data-act="clear" data-room="${escapeAttr(r.name)}">清空</button>
        </div></td>
      </tr>`;
    }
    html += '</tbody></table>';
    roomTable.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---------- 行内操作 ----------
  roomTable.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const room = btn.getAttribute('data-room');
    const act = btn.getAttribute('data-act');
    if (act === 'pw') {
      const input = prompt(`修改房间「${room}」的密码喵~：\n留空表示移除密码，输入新密码则覆盖旧密码。`);
      if (input === null) return; // 取消
      try {
        await api('/api/admin/room/password', {
          method: 'POST',
          body: JSON.stringify({ room, password: input || null }),
        });
        toast(input ? '密码已更新喵~' : '密码已移除喵~');
        loadRooms();
      } catch (err) { toast(err.message); }
    } else if (act === 'clear') {
      if (!confirm(`确定清空房间「${room}」吗喵~？\n将删除该房间的全部消息、图片与密码，且房间将不再存在（游客无法再加入）。`)) return;
      try {
        await api('/api/admin/room/clear', { method: 'POST', body: JSON.stringify({ room }) });
        toast('房间已清空喵~');
        loadRooms();
      } catch (err) { toast(err.message); }
    } else if (act === 'note') {
      const cur = btn.getAttribute('data-note') || '';
      const input = prompt(`设置房间「${room}」的备注喵~：\n说明这个房间是做什么用的（留空则清除备注）。`, cur);
      if (input === null) return; // 取消
      try {
        await api('/api/admin/room/note', { method: 'POST', body: JSON.stringify({ room, note: input.trim() || null }) });
        toast(input.trim() ? '备注已保存喵~' : '备注已清除喵~');
        loadRooms();
      } catch (err) { toast(err.message); }
    }
  });

  // ---------- 事件 ----------
  loginBtn.addEventListener('click', doLogin);
  adminPw.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  logoutLink.addEventListener('click', (e) => { e.preventDefault(); doLogout(); });
  createBtn.addEventListener('click', doCreate);
  newRoom.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
  newPw.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
  newNote.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
  refreshBtn.addEventListener('click', loadRooms);

  // 回填记住的密码（标记此框，避免被下方兜底逻辑清空）
  const savedPw = localStorage.getItem('adminRememberPw');
  if (savedPw) { adminPw.value = savedPw; adminPw.dataset.remember = '1'; rememberPw.checked = true; }

  // 密码可见化
  function wirePwToggle(inputEl, btnEl) {
    const EYE = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><path d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'/><circle cx='12' cy='12' r='3.2'/></svg>";
    const EYE_OFF = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><path d='M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24'/><line x1='1' y1='1' x2='23' y2='23'/></svg>";
    const render = () => { btnEl.innerHTML = inputEl.classList.contains('secure') ? EYE : EYE_OFF; };
    render();
    btnEl.addEventListener('click', () => {
      inputEl.classList.toggle('secure');
      render();
      inputEl.focus();
    });
  }
  wirePwToggle(adminPw, $('adminPwToggle'));
  wirePwToggle(newPw, $('newPwToggle'));

  // 清除浏览器密码管家自动回填的值（跳过记住密码主动回填的 adminPw）
  function clearStrayPw() {
    ['adminPw', 'newPw'].forEach((id) => {
      const el = $(id);
      if (!el || el.dataset.remember) return;
      if (el.value) el.value = '';
    });
  }
  window.addEventListener('load', () => { clearStrayPw(); setTimeout(clearStrayPw, 300); });

  // 自动刷新在线人数
  tryRestore();
  refreshTimer = setInterval(() => { if (token && !panel.classList.contains('hidden')) loadRooms(); }, 5000);
})();
