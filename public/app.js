'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  // 元素
  const joinScreen = $('join');
  const chatScreen = $('chat');
  const roomInput = $('roomInput');
  const pwInput = $('pwInput');
  const joinBtn = $('joinBtn');
  const joinErr = $('joinErr');
  const roomLabel = $('roomLabel');
  const presenceEl = $('presence');
  const messagesEl = $('messages');
  const statusEl = $('status');
  const textInput = $('textInput');
  const sendBtn = $('sendBtn');
  const imgBtn = $('imgBtn');
  const fileInput = $('fileInput');
  const fileBtn = $('fileBtn');
  const fileAllInput = $('fileAllInput');
  const shareBtn = $('shareBtn');
  const leaveBtn = $('leaveBtn');

  // 状态
  let ws = null;
  let currentRoom = null;
  let currentPw = '';
  let reconnectTimer = null;
  let retry = 0;
  let joined = false;

  // 从 URL 预填房间号
  const params = new URLSearchParams(location.search);
  const preRoom = params.get('room');
  if (preRoom) roomInput.value = preRoom;

  // 防止浏览器密码管家把保存的密码自动回填到「房间密码」框
  function clearStrayPw() {
    if (!pwInput.dataset.touched) pwInput.value = '';
  }
  pwInput.addEventListener('input', () => { pwInput.dataset.touched = '1'; });
  window.addEventListener('load', () => { clearStrayPw(); setTimeout(clearStrayPw, 300); });

  // ---------- 工具 ----------
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function formatSize(bytes) {
    if (!bytes || bytes < 0) return '';
    if (bytes < 1024) return bytes + ' B';
    const kb = bytes / 1024;
    if (kb < 1024) return kb.toFixed(1) + ' KB';
    const mb = kb / 1024;
    if (mb < 1024) return mb.toFixed(1) + ' MB';
    return (mb / 1024).toFixed(2) + ' GB';
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // 判断文件名是否为可直接预览的图片（与服务端黑名单一致，svg 已被拦截）
  function isImageExt(name) {
    if (!name) return false;
    const ext = String(name).toLowerCase().split('.').pop();
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(ext);
  }

  function setStatus(text, kind) {
    statusEl.textContent = text || '';
    statusEl.className = 'status-bar' + (kind ? ' ' + kind : '');
  }

  // ---------- 渲染消息 ----------
  function renderMessage(m) {
    const wrap = document.createElement('div');
    wrap.className = 'msg';
    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = fmtTime(m.ts);
    wrap.appendChild(time);

    if (m.type === 'image') {
      const a = document.createElement('a');
      a.href = m.url;
      a.target = '_blank';
      a.rel = 'noopener';
      const img = document.createElement('img');
      img.src = m.url;
      img.alt = m.name || '图片';
      img.className = 'msg-img';
      img.loading = 'lazy';
      a.appendChild(img);
      wrap.appendChild(a);
      if (m.name) {
        const cap = document.createElement('div');
        cap.className = 'msg-cap';
        cap.textContent = m.name;
        wrap.appendChild(cap);
      }
    } else if (m.type === 'file') {
      if (isImageExt(m.name)) {
        // 图片文件：直接预览画面，并保留文件名/大小/下载入口
        const a = document.createElement('a');
        a.href = m.url;
        a.target = '_blank';
        a.rel = 'noopener';
        const img = document.createElement('img');
        img.src = m.url;
        img.alt = m.name || '图片';
        img.className = 'msg-img';
        img.loading = 'lazy';
        a.appendChild(img);
        wrap.appendChild(a);

        const cap = document.createElement('div');
        cap.className = 'msg-file-cap';
        const nm = document.createElement('span');
        nm.className = 'file-name';
        nm.textContent = m.name || '图片';
        nm.title = m.name || '图片';
        const sz = document.createElement('span');
        sz.className = 'file-size';
        sz.textContent = formatSize(m.size);
        const dl = document.createElement('a');
        dl.className = 'file-dl';
        dl.href = m.url;
        dl.download = m.name || 'file';
        dl.rel = 'noopener';
        dl.textContent = '下载';
        cap.appendChild(nm);
        cap.appendChild(sz);
        cap.appendChild(dl);
        wrap.appendChild(cap);
      } else {
        // 普通文件：图标 + 文件名/大小 + 下载卡片
        const a = document.createElement('a');
        a.href = m.url;
        a.className = 'msg-file';
        a.download = m.name || 'file';
        a.rel = 'noopener';

        const icon = document.createElement('span');
        icon.className = 'file-icon';
        icon.textContent = '📄';

        const meta = document.createElement('span');
        meta.className = 'file-meta';
        const fname = document.createElement('span');
        fname.className = 'file-name';
        fname.textContent = m.name || '文件';
        fname.title = m.name || '文件';
        const fsize = document.createElement('span');
        fsize.className = 'file-size';
        fsize.textContent = formatSize(m.size);
        meta.appendChild(fname);
        meta.appendChild(fsize);

        const dl = document.createElement('span');
        dl.className = 'file-dl';
        dl.textContent = '下载';

        a.appendChild(icon);
        a.appendChild(meta);
        a.appendChild(dl);
        wrap.appendChild(a);
      }
    } else {
      const txt = document.createElement('div');
      txt.className = 'msg-text';
      txt.textContent = m.text; // textContent 天然防 XSS
      wrap.appendChild(txt);
    }
    messagesEl.appendChild(wrap);
    scrollToBottom();
  }

  // ---------- WebSocket ----------
  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function connect() {
    setStatus('连接中喵~');
    ws = new WebSocket(wsUrl());

    ws.onopen = () => {
      retry = 0;
      joined = false;
      ws.send(JSON.stringify({ type: 'join', room: currentRoom, password: currentPw }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'history') {
        messagesEl.innerHTML = '';
        (msg.messages || []).forEach(renderMessage);
        setStatus('');
        if (!joined) { joined = true; showChat(); }
      } else if (msg.type === 'message') {
        renderMessage(msg.message);
      } else if (msg.type === 'presence') {
        presenceEl.textContent = `在线 ${msg.count} 人`;
      } else if (msg.type === 'error') {
        // 密码错误等：退回登录页
        if (!joined) {
          joinErr.textContent = msg.msg;
          showJoin();
        } else {
          setStatus(msg.msg, 'err');
        }
      }
    };

    ws.onclose = () => {
      if (!currentRoom) return;
      setStatus('连接断开，重连中喵~', 'err');
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** retry, 15000);
    retry += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  // ---------- 发送 ----------
  function sendText() {
    const text = textInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'text', text }));
    textInput.value = '';
  }

  async function sendImage(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setStatus('只能发送图片喵~', 'err');
      return;
    }
    setStatus('上传中…');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '上传失败');
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'image', url: data.url, name: data.name }));
      }
      setStatus('');
    } catch (e) {
      setStatus(e.message || '上传失败', 'err');
    }
  }

  async function sendFile(file) {
    if (!file) return;
    setStatus('上传中…');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '上传失败');
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'file', url: data.url, name: data.name, size: data.size }));
      }
      setStatus('');
    } catch (e) {
      setStatus(e.message || '上传失败', 'err');
    }
  }

  // ---------- 界面切换 ----------
  function showChat() {
    joinScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');
    document.body.classList.add('chat-open');
    roomLabel.textContent = '房间：' + currentRoom;
  }

  function showJoin() {
    chatScreen.classList.add('hidden');
    joinScreen.classList.remove('hidden');
    document.body.classList.remove('chat-open');
    currentRoom = null;
    if (ws) { try { ws.close(); } catch {} ws = null; }
    messagesEl.innerHTML = '';
  }

  async function doJoin() {
    const room = roomInput.value.trim();
    if (!room) {
      joinErr.textContent = '请输入房间号喵~';
      return;
    }
    if (ws) { try { ws.close(); } catch {} ws = null; }
    joinErr.textContent = '检查中喵~…';
    try {
      const res = await fetch('/api/room/check?room=' + encodeURIComponent(room));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '检查失败喵~');
      if (!data.exists) throw new Error('房间不存在喵~，请联系管理员');
      if (data.requirePassword && !pwInput.value) throw new Error('这个房间需要密码喵~');
      currentRoom = room;
      currentPw = pwInput.value;
      joined = false;
      // 同步到 URL，方便分享
      const u = new URL(location.href);
      u.searchParams.set('room', room);
      history.replaceState(null, '', u);
      connect();
    } catch (e) {
      joinErr.textContent = e.message;
    }
  }

  async function doShare() {
    const url = location.origin + '/?room=' + encodeURIComponent(currentRoom);
    try {
      await navigator.clipboard.writeText(url);
      setStatus('分享链接已复制喵~', 'ok');
    } catch {
      prompt('复制以下链接分享给其他设备：', url);
    }
  }

  // ---------- 事件绑定 ----------
  joinBtn.addEventListener('click', doJoin);
  roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

  sendBtn.addEventListener('click', sendText);
  textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });

  imgBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    sendImage(f);
    fileInput.value = '';
  });

  fileBtn.addEventListener('click', () => fileAllInput.click());
  fileAllInput.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    sendFile(f);
    fileAllInput.value = '';
  });

  shareBtn.addEventListener('click', doShare);
  leaveBtn.addEventListener('click', () => {
    showJoin();
  });

  // 密码可见化
  (function () {
    const pwToggle = $('pwToggle');
    const EYE = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><path d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'/><circle cx='12' cy='12' r='3.2'/></svg>";
    const EYE_OFF = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><path d='M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24'/><line x1='1' y1='1' x2='23' y2='23'/></svg>";
    const render = () => { pwToggle.innerHTML = pwInput.classList.contains('secure') ? EYE : EYE_OFF; };
    render();
    pwToggle.addEventListener('click', () => {
      pwInput.classList.toggle('secure');
      render();
      pwInput.focus();
    });
  })();

  // 粘贴图片直接发送
  document.addEventListener('paste', (e) => {
    if (!currentRoom) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith('image/')) {
        sendImage(it.getAsFile());
        break;
      }
    }
  });
})();
