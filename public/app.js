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
  const identityEl = $('identity');
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
  const uploadPanel = $('uploadPanel');

  // 表情面板元素
  const emojiBtn = $('emojiBtn');
  const emojiPanel = $('emojiPanel');
  const emojiTabs = $('emojiTabs');
  const emojiGrid = $('emojiGrid');

  // 粘贴/选择图片后的 inline 预览（微信风格）
  const imagePreviewArea = $('imagePreviewArea');
  const imagePreviewThumb = $('imagePreviewThumb');
  const imagePreviewRemove = $('imagePreviewRemove');
  const imageLightbox = $('imageLightbox');
  const imageLightboxImg = $('imageLightboxImg');
  let pendingImageFile = null;
  let pendingImageUrl = null;

  // 状态
  let ws = null;
  let currentRoom = null;
  let currentPw = '';
  let reconnectTimer = null;
  let retry = 0;
  let joined = false;
  let myHostId = null; // 本机被分配的身份 ID（二次元角色名）
  // 本地真实头像清单（public/avatars 下已有的文件名，去掉 .png），由 /api/avatars 提供
  const avatarNames = new Set();
  try {
    fetch('/api/avatars').then(r => r.json()).then(d => {
      if (d && Array.isArray(d.names)) d.names.forEach(n => avatarNames.add(n));
    }).catch(() => {});
  } catch (_) {}

  // 初始化分片上传管理器（进度条/暂停/断点续传），完成后通过 WS 广播文件消息
  if (window.uploadManager && uploadPanel) {
    window.uploadManager.init(uploadPanel);
    window.uploadManager.onComplete = (info) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'file', url: info.url, name: info.name, size: info.size }));
      }
    };
    if (currentRoom) window.uploadManager.setRoom(currentRoom);
  }

  // 从 URL 预填房间号
  const params = new URLSearchParams(location.search);
  const preRoom = params.get('room');

  // 刷新后自动重连：sessionStorage 在同一标签页刷新间保留，关闭标签页则清除
  const savedRoom = sessionStorage.getItem('relayRoom');
  const savedPw = sessionStorage.getItem('relayPw') || '';
  if (savedRoom) {
    roomInput.value = savedRoom;
    if (savedPw) {
      pwInput.value = savedPw;
      pwInput.dataset.touched = '1'; // 标记已填，避免被 clearStrayPw 清掉
    }
    // 延后到 load 之后触发，避免与 clearStrayPw 的定时清理冲突
    setTimeout(() => doJoin(), 0);
  } else if (preRoom) {
    roomInput.value = preRoom;
  }

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

  // 滚动条自动隐藏：仅在「实际滚动」时显示，悬停/程序滚底不触发；停止滚动后延时淡出
  // 延时（开始淡出前的等待）与淡出时长均集中在 style.css 的 --scrollbar-hide-delay / --scrollbar-fade-duration，
  // 这里从 CSS 变量读取，保证「改一处即可调」；解析失败时用兜底值。
  const readMs = (name, fallback) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  };
  let scrollHideTimer = null;
  function revealScrollbar() {
    if (!messagesEl || messagesEl.classList.contains('hidden')) return;
    // 内容不足以滚动则不显示
    if (messagesEl.scrollHeight <= messagesEl.clientHeight) return;
    messagesEl.classList.add('scrolling');
    if (scrollHideTimer) { clearTimeout(scrollHideTimer); scrollHideTimer = null; }
  }
  function hideScrollbarSoon() {
    if (scrollHideTimer) clearTimeout(scrollHideTimer);
    const HIDE_DELAY = readMs('--scrollbar-hide-delay', 800);   // 与 CSS 变量保持一致
    scrollHideTimer = setTimeout(() => {
      if (messagesEl) messagesEl.classList.remove('scrolling');  // 淡出动画由 CSS opacity 过渡负责
      scrollHideTimer = null;
    }, HIDE_DELAY);
  }
  const isScrollKey = (e) =>
    ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ', 'Spacebar'].includes(e.key);
  // 判断 mousedown 是否落在滚动条（右侧竖条 / 底部横条）区域内
  function isOnScrollbar(e) {
    const rect = messagesEl.getBoundingClientRect();
    const onVertical = e.clientX >= rect.left + messagesEl.clientWidth - 1;
    const onHorizontal = e.clientY >= rect.top + messagesEl.clientHeight - 1;
    return onVertical || onHorizontal;
  }

  // 用户滚动来源：滚轮 / 触摸滑动 / 方向键 → 显示并延时隐藏
  messagesEl.addEventListener('wheel', () => { revealScrollbar(); hideScrollbarSoon(); }, { passive: true });
  messagesEl.addEventListener('touchmove', () => { revealScrollbar(); hideScrollbarSoon(); }, { passive: true });
  messagesEl.addEventListener('keydown', (e) => {
    if (isScrollKey(e)) { revealScrollbar(); hideScrollbarSoon(); }
  });
  // 拖动 / 点击滚动条滑块也算真实滚动：mousedown 落在滚动条区域即显示，抬起后延时隐藏
  messagesEl.addEventListener('mousedown', (e) => {
    if (isOnScrollbar(e)) { revealScrollbar(); hideScrollbarSoon(); }
  });
  // 程序滚底（新消息 / 图片加载）只刷新隐藏计时，绝不让滚动条凭空出现
  messagesEl.addEventListener('scroll', () => {
    if (messagesEl.classList.contains('scrolling')) hideScrollbarSoon();
  }, { passive: true });
  // 鼠标移出面板：立即开始淡出（与停止滚动同样走延时+opacity 过渡）
  messagesEl.addEventListener('mouseleave', hideScrollbarSoon);

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

  // 显示本机被分配的身份 ID
  function updateIdentity() {
    identityEl.textContent = myHostId ? ('你的身份：' + myHostId) : '';
  }

  // 根据 sender 名确定头像：
  //   1) AVATAR_OVERRIDE（avatarMap.js 中的手动 URL，可选）；
  //   2) 本地真实图片 public/avatars/<角色名>.png（命中即显示，缺图回退）；
  //   3) 首字 + HSL 主题色生成的 SVG 头像。
  function avatarFor(name) {
    const s = String(name || '?');
    if (typeof AVATAR_OVERRIDE !== 'undefined' && AVATAR_OVERRIDE[s]) {
      return AVATAR_OVERRIDE[s];
    }
    if (avatarNames.has(s)) {
      return '/avatars/' + encodeURIComponent(s) + '.png';
    }
    const chars = Array.from(s);
    const char = chars.find(c => /\S/.test(c)) || '?';
    let h = 0;
    for (const ch of s) h = ((h << 5) - h) + ch.charCodeAt(0) | 0;
    const hue = Math.abs(h) % 360;
    const bg = `hsl(${hue}, 70%, 45%)`;
    const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" rx="50" fill="${esc(bg)}"/><text x="50" y="68" font-size="48" text-anchor="middle" fill="#fff" font-family="system-ui, -apple-system, sans-serif" font-weight="600">${esc(char)}</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  // ---------- 渲染消息（QQ 风格：头像 + 名字 + 气泡） ----------
  function renderMessage(m) {
    const wrap = document.createElement('div');
    wrap.className = 'msg';
    // 根据发送方 ID 区分自己与他人的消息
    const isSelf = !!(myHostId && m.sender && m.sender === myHostId);
    if (isSelf) wrap.classList.add('self');

    const senderName = m.sender || '匿名';

    // 头像
    const avatar = document.createElement('img');
    avatar.className = 'msg-avatar';
    avatar.src = avatarFor(senderName);
    avatar.alt = senderName;
    // 若本地真实头像缺失（如清单尚未加载完），回退到首字生成头像，避免裂图
    avatar.onerror = () => {
      if (!avatar.src.startsWith('data:')) {
        avatar.onerror = null;
        avatar.src = (() => {
          const s = String(senderName || '?');
          const chars = Array.from(s);
          const char = chars.find(c => /\S/.test(c)) || '?';
          let h = 0;
          for (const ch of s) h = ((h << 5) - h) + ch.charCodeAt(0) | 0;
          const hue = Math.abs(h) % 360;
          const bg = `hsl(${hue}, 70%, 45%)`;
          const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" rx="50" fill="${esc(bg)}"/><text x="50" y="68" font-size="48" text-anchor="middle" fill="#fff" font-family="system-ui, -apple-system, sans-serif" font-weight="600">${esc(char)}</text></svg>`;
          return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        })();
      }
    };
    wrap.appendChild(avatar);

    // 内容区：名字 + 气泡 + 时间
    const body = document.createElement('div');
    body.className = 'msg-body';

    const sender = document.createElement('div');
    sender.className = 'msg-sender';
    sender.textContent = senderName;
    body.appendChild(sender);

    if (m.type === 'image') {
      const a = document.createElement('a');
      a.href = m.url;
      a.target = '_blank';
      a.rel = 'noopener';
      const img = document.createElement('img');
      img.src = m.url;
      img.alt = m.name || '图片';
      img.className = 'msg-img';
      img.onload = scrollToBottom;
      img.onerror = scrollToBottom;
      a.appendChild(img);
      body.appendChild(a);
      if (m.name) {
        const cap = document.createElement('div');
        cap.className = 'msg-cap';
        cap.textContent = m.name;
        body.appendChild(cap);
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
        img.onload = scrollToBottom;
        img.onerror = scrollToBottom;
        a.appendChild(img);
        body.appendChild(a);

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
        body.appendChild(cap);
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
        body.appendChild(a);
      }
    } else {
      const txt = document.createElement('div');
      txt.className = 'msg-text';
      txt.innerHTML = renderEmojiText(m.text); // 先转义再解析 [表情名]，防 XSS 且支持内联表情
      body.appendChild(txt);
    }

    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = fmtTime(m.ts);
    body.appendChild(time);

    wrap.appendChild(body);
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
    joinErr.textContent = '连接中喵~…';
    const url = wsUrl();
    console.log('[ws] connecting to', url);
    ws = new WebSocket(url);

    // 连接握手超时保护：若 5 秒内没进入 open，提示用户
    const openTimer = setTimeout(() => {
      console.warn('[ws] open timeout');
      if (!joined && ws && ws.readyState !== WebSocket.OPEN) {
        joinErr.textContent = '连接 handshake 超时，请检查网络或刷新喵~';
      }
    }, 5000);

    ws.onopen = () => {
      clearTimeout(openTimer);
      retry = 0;
      joined = false;
      console.log('[ws] open, joining room', currentRoom);
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
        // 聊天区显示后再滚到底部：隐藏时 scrollHeight 为 0，无法正确定位
        scrollToBottom();
      } else if (msg.type === 'message') {
        renderMessage(msg.message);
      } else if (msg.type === 'presence') {
        presenceEl.textContent = `在线 ${msg.count} 人`;
      } else if (msg.type === 'cleared') {
        // 房间消息被管理员清空：同步清空本地显示（房间与连接保留）
        messagesEl.innerHTML = '';
        setStatus(msg.msg || '房间消息已被清空', 'info');
      } else if (msg.type === 'host') {
        // 服务端为本机分配的身份 ID
        myHostId = msg.id;
        updateIdentity();
      } else if (msg.type === 'error') {
        // 密码错误等：退回登录页
        if (!joined) {
          joinErr.textContent = msg.msg;
          showJoin(true); // 保留房间号，仅清密码
        } else {
          setStatus(msg.msg, 'err');
        }
      }
    };

    ws.onclose = (ev) => {
      clearTimeout(openTimer);
      console.log('[ws] close', ev.code, ev.reason);
      if (!joined) {
        // 还没成功进入房间就断了：留在登录页并给出提示
        joinErr.textContent = '连接被断开，请刷新或检查服务器喵~';
      }
      if (!currentRoom) return;
      setStatus('连接断开，重连中喵~', 'err');
      scheduleReconnect();
    };

    ws.onerror = (ev) => {
      clearTimeout(openTimer);
      console.error('[ws] error', ev);
      if (!joined) {
        joinErr.textContent = 'WebSocket 连接出错，请打开控制台查看详情喵~';
      }
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

  // 统一发送入口：有图片预览时先发图片，再把输入框文字作为 caption 发出
  async function doSend() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const text = textInput.value.trim();
    if (pendingImageFile) {
      const f = pendingImageFile;
      const caption = text;
      clearImagePreview();
      await sendImage(f);
      if (caption) {
        ws.send(JSON.stringify({ type: 'text', text: caption }));
        textInput.value = '';
      }
    } else if (text) {
      sendText();
    }
  }

  // 规范化文件名：保留真实扩展名（选文件时），缺失时按 MIME 推断并补时间戳（粘贴图片时无文件名）
  function pickName(file) {
    const raw = (file && file.name) || '';
    if (raw && /\.[a-z0-9]+$/i.test(raw)) return raw;
    const t = file && file.type ? file.type.split('/')[1] : '';
    let ext = '';
    if (t) ext = t === 'jpeg' ? 'jpg' : t.replace('svg+xml', 'svg').replace('+xml', '');
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const prefix = file && file.type && file.type.startsWith('image/') ? '图片' : '文件';
    return `${prefix}_${ts}${ext ? '.' + ext : ''}`;
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
    if (currentRoom) fd.append('room', currentRoom);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '上传失败');
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'image', url: data.url, name: pickName(file) }));
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

  function showJoin(keepSession) {
    chatScreen.classList.add('hidden');
    joinScreen.classList.remove('hidden');
    document.body.classList.remove('chat-open');
    currentRoom = null;
    if (!keepSession) {
      sessionStorage.removeItem('relayRoom');
      sessionStorage.removeItem('relayPw');
    } else {
      // 密码错误退回登录页：保留房间号，仅清掉（可能错误的）密码
      sessionStorage.removeItem('relayPw');
    }
    if (ws) { try { ws.close(); } catch {} ws = null; }
    messagesEl.innerHTML = '';
    clearImagePreview();
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
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch('/api/room/check?room=' + encodeURIComponent(room), { signal: ctl.signal });
      clearTimeout(t);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '检查失败喵~');
      if (!data.exists) throw new Error('房间不存在喵~，请联系管理员');
      if (data.requirePassword && !pwInput.value) throw new Error('这个房间需要密码喵~');
      currentRoom = room;
      currentPw = pwInput.value;
      // 让上传管理器知道当前房间，上传时附带 room 便于删除房间时清理文件
      if (window.uploadManager) window.uploadManager.setRoom(room);
      // 记入住址栏 + sessionStorage，刷新可自动重连
      sessionStorage.setItem('relayRoom', room);
      sessionStorage.setItem('relayPw', currentPw);
      joined = false;
      // 同步到 URL，方便分享
      const u = new URL(location.href);
      u.searchParams.set('room', room);
      history.replaceState(null, '', u);
      connect();
    } catch (e) {
      joinErr.textContent = e.name === 'AbortError' ? '检查房间超时，请刷新再试喵~' : (e.message || '检查失败喵~');
      console.error('[doJoin error]', e);
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

  // ---------- 贴吧表情面板 ----------
  let emojiBuilt = false;

  function buildEmojiPanel() {
    if (emojiBuilt) return;
    emojiBuilt = true;
    const cats = Object.keys(window.TIEBA_EMOJIS || {});
    emojiTabs.innerHTML = '';
    cats.forEach((cat, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'emoji-tab' + (idx === 0 ? ' active' : '');
      b.textContent = cat;
      b.addEventListener('click', () => {
        emojiTabs.querySelectorAll('.emoji-tab').forEach((t) => t.classList.remove('active'));
        b.classList.add('active');
        renderEmojiGrid(cat);
      });
      emojiTabs.appendChild(b);
    });
    renderEmojiGrid(cats[0]);
  }

  function renderEmojiGrid(cat) {
    emojiGrid.innerHTML = '';
    const list = (window.TIEBA_EMOJIS && window.TIEBA_EMOJIS[cat]) || [];
    list.forEach((e) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'emoji-item';
      item.title = e.name;
      const img = document.createElement('img');
      img.src = '/emojis/' + e.file;
      img.alt = e.name;
      img.loading = 'lazy';
      item.appendChild(img);
      item.addEventListener('click', (ev) => {
        ev.stopPropagation();
        insertEmoji(e.name);
      });
      emojiGrid.appendChild(item);
    });
  }

  // 在输入框光标处插入 [表情名] token；若浏览器不支持 selection，则追加到末尾
  function insertEmoji(name) {
    const token = '[' + name + ']';
    const el = textInput;
    const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
    const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
    el.value = el.value.slice(0, start) + token + el.value.slice(end);
    const pos = start + token.length;
    el.focus();
    try { el.setSelectionRange(pos, pos); } catch (_) {}
  }

  function toggleEmojiPanel(force) {
    const show = force === undefined ? emojiPanel.classList.contains('hidden') : force;
    if (show) {
      buildEmojiPanel();
      emojiPanel.classList.remove('hidden');
    } else {
      emojiPanel.classList.add('hidden');
    }
  }

  // 消息文本中的 [表情名] -> 内联 <img class="emoji">；未知方括号保持原样（先转义防 XSS）
  function renderEmojiText(text) {
    const escaped = escapeHtml(text);
    const map = window.EMOJI_MAP || {};
    return escaped.replace(/\[([^\]]+)\]/g, (m, name) => {
      if (map[name]) {
        const alt = escapeHtml(name);
        return '<img class="emoji" src="/emojis/' + map[name] + '" alt="' + alt + '" title="' + alt + '">';
      }
      return m;
    });
  }

  // ---------- 事件绑定 ----------
  joinBtn.addEventListener('click', doJoin);
  roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

  sendBtn.addEventListener('click', doSend);
  textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });

  imgBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) showImagePreview(f);
    fileInput.value = '';
  });

  fileBtn.addEventListener('click', () => fileAllInput.click());
  fileAllInput.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    // 走分片上传器（带进度条 / 暂停 / 断点续传），完成后回调发送 WS 文件消息
    if (f) window.uploadManager.addFile(f);
    fileAllInput.value = '';
  });

  shareBtn.addEventListener('click', doShare);
  leaveBtn.addEventListener('click', () => {
    showJoin();
  });

  // 表情面板：点击按钮开关；点击面板外部（含输入框）收起，保证交互流畅
  emojiBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleEmojiPanel();
  });
  document.addEventListener('click', (ev) => {
    if (emojiPanel.classList.contains('hidden')) return;
    if (emojiPanel.contains(ev.target) || emojiBtn.contains(ev.target) || ev.target === textInput) return;
    toggleEmojiPanel(false);
  });
  // Esc 收起面板
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !emojiPanel.classList.contains('hidden')) toggleEmojiPanel(false);
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

  // 粘贴/选择图片：inline 预览，配文字后按回车或发送按钮发出（微信风格）
  function showImagePreview(file) {
    if (!file || !file.type.startsWith('image/')) return;
    clearImagePreview(); // 防止重复预览时泄漏旧 URL
    pendingImageFile = file;
    pendingImageUrl = URL.createObjectURL(file);
    imagePreviewThumb.src = pendingImageUrl;
    imagePreviewArea.classList.remove('hidden');
    textInput.focus();
  }

  function clearImagePreview() {
    imagePreviewArea.classList.add('hidden');
    imagePreviewThumb.removeAttribute('src');
    closeLightbox();
    if (pendingImageUrl) { URL.revokeObjectURL(pendingImageUrl); pendingImageUrl = null; }
    pendingImageFile = null;
  }

  // 缩略图点击放大灯箱
  function openLightbox() {
    if (!pendingImageUrl) return;
    imageLightboxImg.src = pendingImageUrl;
    imageLightbox.classList.remove('hidden');
  }
  function closeLightbox() {
    if (imageLightbox.classList.contains('hidden')) return;
    imageLightbox.classList.add('hidden');
    imageLightboxImg.removeAttribute('src');
  }
  imagePreviewThumb.addEventListener('click', openLightbox);
  imageLightbox.addEventListener('click', closeLightbox);
  // Esc：优先关灯箱，其次取消图片预览
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!imageLightbox.classList.contains('hidden')) {
      closeLightbox();
    } else if (pendingImageFile && !imagePreviewArea.classList.contains('hidden')) {
      clearImagePreview();
    }
  });

  // 粘贴图片：拦截并进入 inline 预览
  document.addEventListener('paste', (e) => {
    if (!currentRoom) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith('image/')) {
        e.preventDefault();
        showImagePreview(it.getAsFile());
        break;
      }
    }
  });
})();
