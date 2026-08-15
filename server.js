'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 7777;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 50);
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 500);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_TOKEN_TTL = Number(process.env.ADMIN_TOKEN_TTL || 1000 * 60 * 60 * 24); // 默认 24h

const DATA_DIR = path.join(__dirname, 'data');
const MSG_DIR = path.join(DATA_DIR, 'messages');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');

// 上传类型安全策略：采用黑名单，屏蔽可在浏览器渲染执行、或在客户端
// 直接执行的文件类型（html/svg/js/exe/ps1 等），其余一切文件类型均可传。
const BLOCKED_EXT = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'vb', 'vbs', 'js', 'jse',
  'ws', 'wsf', 'wsh', 'ps1', 'ps1xml', 'psc1', 'msh', 'msh1', 'msh2', 'jar',
  'app', 'deb', 'rpm', 'run', 'sh', 'csh', 'ksh', 'zsh', 'py', 'pyw', 'hta',
  'lnk', 'scf', 'inf', 'reg', 'msc', 'gadget', 'application',
  'html', 'htm', 'xhtml', 'svg', 'php', 'asp', 'aspx', 'jsp', 'cgi', 'pl',
]);

// 从原始文件名提取安全扩展名（仅字母数字，最长 10 位）
function extFromName(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,10})$/);
  return m ? m[1] : '';
}

// ---------- 数据目录与持久化辅助 ----------

function ensureDirs() {
  for (const d of [DATA_DIR, MSG_DIR, UPLOAD_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}
ensureDirs();

function safeRoom(room) {
  // 仅保留安全字符，防止路径穿越
  return String(room || '').replace(/[^a-zA-Z0-9_\-@.]/g, '').slice(0, 64);
}

function roomFile(room) {
  return path.join(MSG_DIR, `${safeRoom(room)}.json`);
}

// 内存消息缓存：作为历史消息的权威来源，避免并发落盘的竞态（竞态会导致磁盘 JSON 损坏、刷新后历史丢失）
const messageCache = {};

function loadMessages(room) {
  if (messageCache[room]) return messageCache[room];
  let arr = [];
  try {
    const raw = fs.readFileSync(roomFile(room), 'utf8').trim();
    if (raw) {
      try {
        arr = JSON.parse(raw);
      } catch {
        // 尝试修复「拼接型损坏」：把多余的对象/数组边界补成合法的逗号分隔
        const fixed = raw
          .replace(/]\s*\[/g, ',')      // ][ 之间补逗号（数组被重复覆盖写入）
          .replace(/}\s*{/g, '},{');    // }{ 之间补逗号（对象被直接拼接）
        arr = JSON.parse(fixed);
        fs.writeFileSync(roomFile(room), JSON.stringify(arr)); // 修复后写回
      }
    }
  } catch { /* 损坏且无法修复时按空处理 */ }
  if (!Array.isArray(arr)) arr = [];
  messageCache[room] = arr;
  return arr;
}

// 使用同步写盘，避免并发 writeFile 在文件层面交错/截断导致 JSON 损坏
function saveMessages(room, messages) {
  try {
    fs.writeFileSync(roomFile(room), JSON.stringify(messages));
  } catch (e) {
    console.error('保存消息失败:', room, e.message);
  }
}

// ---------- 房间注册表（管理员创建 / 控制） ----------
// 结构：{ [room]: { password: string|null, createdAt: number } }
// 房间“存在”当且仅当它是本表的键；游客只能加入已存在的房间。
function loadRooms() {
  try {
    const obj = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')) || {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') {
        // 兼容旧格式：纯密码字符串
        out[k] = { password: v || null, createdAt: Date.now() };
      } else if (v && typeof v === 'object') {
        out[k] = { password: (v.password || null), createdAt: v.createdAt || Date.now() };
      }
    }
    return out;
  } catch {
    return {};
  }
}

let roomRegistry = loadRooms();

function saveRooms() {
  fs.writeFile(ROOMS_FILE, JSON.stringify(roomRegistry), (err) => {
    if (err) console.error('保存房间注册表失败:', err.message);
  });
}

function roomExists(room) {
  return Object.prototype.hasOwnProperty.call(roomRegistry, room);
}

function roomPassword(room) {
  return roomExists(room) ? (roomRegistry[room].password || null) : undefined;
}

// 彻底清空一个房间：删除消息文件、关联上传文件、注册表记录，并踢出在线用户
function clearRoom(room) {
  const f = roomFile(room);
  if (fs.existsSync(f)) {
    try {
      const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(arr)) {
        for (const m of arr) {
          // 清理所有落在本站 /uploads/ 下的图片与文件
          if (m && typeof m.url === 'string' && m.url.startsWith('/uploads/')) {
            const p = path.join(UPLOAD_DIR, path.basename(m.url));
            try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
          }
        }
      }
    } catch { /* ignore */ }
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  delete messageCache[room];
  delete roomRegistry[room];
  saveRooms();
  if (wsRooms.has(room)) {
    for (const client of [...wsRooms.get(room)]) {
      try { client.send(JSON.stringify({ type: 'error', msg: '房间已被管理员清空' })); } catch { /* ignore */ }
      try { client.close(); } catch { /* ignore */ }
    }
    wsRooms.delete(room);
  }
}

// ---------- 管理员会话（token） ----------
const adminSessions = new Map(); // token -> 过期时间戳(ms)

function createAdminToken() {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, Date.now() + ADMIN_TOKEN_TTL);
  return token;
}

function validAdminToken(token) {
  if (!token) return false;
  const exp = adminSessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

// ---------- Express ----------

const app = express();
app.use(express.json());

// 静态前端
app.use(express.static(path.join(__dirname, 'public')));

// 上传的文件（图片、文档等任意类型）静态服务
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

// 文件上传接口（返回可访问 URL，由 WS 广播该 URL 实现跨设备传输）
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // 保留原始扩展名（若被黑名单命中则用 .bin 兜底），文件名主体随机防猜测
    let ext = extFromName(file.originalname);
    if (BLOCKED_EXT.has(ext)) ext = 'bin';
    const name = crypto.randomBytes(16).toString('hex') + (ext ? '.' + ext : '');
    cb(null, name);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    // 允许一切非黑名单扩展名的文件（图片、文档、压缩包、安装包等均可）
    const ext = extFromName(file.originalname);
    if (BLOCKED_EXT.has(ext)) {
      return cb(new Error('不支持该文件类型喵~（出于安全限制可执行/脚本类文件）'));
    }
    cb(null, true);
  },
});

app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: '未收到文件喵~' });
    const url = `/uploads/${req.file.filename}`;
    // 文件名仅作展示/下载用，去除路径分隔等危险字符
    const safeName = String(req.file.originalname || 'file')
      .replace(/[\\/:*?"<>|\n\r\t]/g, '_')
      .slice(0, 120);
    res.json({ url, name: safeName, size: req.file.size });
  });
});

// 健康检查
app.get('/healthz', (req, res) => res.json({ ok: true }));

// 游客预检：房间是否存在、是否需要密码（不暴露密码内容）
app.get('/api/room/check', (req, res) => {
  const room = safeRoom(req.query.room);
  if (!room) return res.status(400).json({ error: '房间名无效喵~' });
  const exists = roomExists(room);
  res.json({
    exists,
    requirePassword: exists ? !!roomRegistry[room].password : false,
  });
});

// ---------- 管理员鉴权 ----------
function authTokenFromReq(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function requireAdmin(req, res, next) {
  if (!validAdminToken(authTokenFromReq(req))) {
    return res.status(401).json({ error: '未登录或登录已过期喵~' });
  }
  next();
}

app.post('/api/admin/login', (req, res) => {
  const pw = String((req.body && req.body.password) || '');
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: '管理员密码错误喵~' });
  const token = createAdminToken();
  res.json({ token });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  adminSessions.delete(authTokenFromReq(req));
  res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => {
  res.json({ ok: validAdminToken(authTokenFromReq(req)) });
});

// 房间列表（含在线人数、消息数）
app.get('/api/admin/rooms', requireAdmin, (req, res) => {
  const list = Object.keys(roomRegistry).map((name) => ({
    name,
    hasPassword: !!roomRegistry[name].password,
    messageCount: loadMessages(name).length,
    online: wsRooms.has(name) ? wsRooms.get(name).size : 0,
    createdAt: roomRegistry[name].createdAt,
  }));
  res.json({ rooms: list });
});

// 创建房间（可选密码）
app.post('/api/admin/room/create', requireAdmin, (req, res) => {
  const room = safeRoom(req.body && req.body.room);
  if (!room) return res.status(400).json({ error: '房间名无效喵~（仅允许字母/数字/_-@.）' });
  if (roomExists(room)) return res.status(400).json({ error: '房间已存在喵~' });
  const pw = req.body && req.body.password ? String(req.body.password) : null;
  roomRegistry[room] = { password: pw, createdAt: Date.now() };
  saveRooms();
  res.json({ ok: true });
});

// 修改 / 移除房间密码（password 为空则移除密码）
app.post('/api/admin/room/password', requireAdmin, (req, res) => {
  const room = safeRoom(req.body && req.body.room);
  if (!roomExists(room)) return res.status(404).json({ error: '房间不存在喵~' });
  const pw = req.body && req.body.password ? String(req.body.password) : null;
  roomRegistry[room].password = pw;
  saveRooms();
  res.json({ ok: true, hasPassword: !!pw });
});

// 清空房间（删除一切存在痕迹）
app.post('/api/admin/room/clear', requireAdmin, (req, res) => {
  const room = safeRoom(req.body && req.body.room);
  if (!roomExists(room)) return res.status(404).json({ error: '房间不存在喵~' });
  clearRoom(room);
  res.json({ ok: true });
});

// ---------- WebSocket 房间管理 ----------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// wsRooms: Map<room, Set<ws>>
const wsRooms = new Map();

function broadcast(room, payload, exclude) {
  const set = wsRooms.get(room);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const client of set) {
    if (client !== exclude && client.readyState === client.OPEN) {
      client.send(data);
    }
  }
}

function presence(room) {
  const set = wsRooms.get(room);
  return set ? set.size : 0;
}

function sendPresence(room) {
  broadcast(room, { type: 'presence', count: presence(room) });
}

wss.on('connection', (ws) => {
  ws.room = null;
  ws.authed = false;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'join') {
      const room = safeRoom(msg.room);
      if (!room) {
        return ws.send(JSON.stringify({ type: 'error', msg: '房间名无效喵~' }));
      }
      // 游客只能加入「已存在且未清空」的房间
      if (!roomExists(room)) {
        return ws.send(JSON.stringify({ type: 'error', msg: '房间不存在喵~，请联系管理员' }));
      }
      const expected = roomPassword(room);
      // 房间有密码且不匹配 -> 拒绝
      if (expected && msg.password !== expected) {
        return ws.send(JSON.stringify({ type: 'error', msg: '密码错误喵~' }));
      }
      // 离开旧房间
      if (ws.room && wsRooms.has(ws.room)) {
        wsRooms.get(ws.room).delete(ws);
        sendPresence(ws.room);
      }
      ws.room = room;
      ws.authed = true;
      if (!wsRooms.has(room)) wsRooms.set(room, new Set());
      wsRooms.get(room).add(ws);

      // 回放历史
      const history = loadMessages(room);
      ws.send(JSON.stringify({ type: 'history', messages: history }));
      sendPresence(room);
      return;
    }

    // 以下消息需先加入房间
    if (!ws.authed || !ws.room) {
      return ws.send(JSON.stringify({ type: 'error', msg: '请先加入房间喵~' }));
    }

    if (msg.type === 'text') {
      const text = String(msg.text || '').slice(0, 8000).trim();
      if (!text) return;
      const message = {
        id: crypto.randomUUID(),
        type: 'text',
        text,
        ts: Date.now(),
      };
      appendMessage(ws.room, message);
      broadcast(ws.room, { type: 'message', message });
      return;
    }

    if (msg.type === 'image') {
      const url = String(msg.url || '');
      // 仅允许本站 uploads 路径，防外链注入
      if (!url.startsWith('/uploads/')) {
        return ws.send(JSON.stringify({ type: 'error', msg: '非法的图片地址喵~' }));
      }
      const message = {
        id: crypto.randomUUID(),
        type: 'image',
        url,
        name: String(msg.name || '').slice(0, 120),
        ts: Date.now(),
      };
      appendMessage(ws.room, message);
      broadcast(ws.room, { type: 'message', message });
      return;
    }

    if (msg.type === 'file') {
      const url = String(msg.url || '');
      // 仅允许本站 uploads 路径，防外链注入
      if (!url.startsWith('/uploads/')) {
        return ws.send(JSON.stringify({ type: 'error', msg: '非法的文件地址喵~' }));
      }
      const message = {
        id: crypto.randomUUID(),
        type: 'file',
        url,
        name: String(msg.name || '文件').slice(0, 200),
        size: Number(msg.size || 0),
        ts: Date.now(),
      };
      appendMessage(ws.room, message);
      broadcast(ws.room, { type: 'message', message });
      return;
    }
  });

  ws.on('close', () => {
    if (ws.room && wsRooms.has(ws.room)) {
      wsRooms.get(ws.room).delete(ws);
      sendPresence(ws.room);
      if (wsRooms.get(ws.room).size === 0) wsRooms.delete(ws.room);
    }
  });
});

function appendMessage(room, message) {
  const messages = loadMessages(room);
  messages.push(message);
  if (messages.length > MAX_HISTORY) messages.splice(0, messages.length - MAX_HISTORY);
  saveMessages(room, messages);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Browser Relay 运行中: http://localhost:${PORT}`);
  console.log(`管理员页面: http://localhost:${PORT}/admin.html`);
  if (ADMIN_PASSWORD === 'admin123') {
    console.warn('[安全警告] 正在使用默认管理员密码 "admin123"，请通过环境变量 ADMIN_PASSWORD 修改后再部署到公网。');
  }
});
