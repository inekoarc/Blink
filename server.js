'use strict';

// 在读取环境变量前加载 .env（若存在），便于在不暴露密码到命令行的前提下配置 ADMIN_PASSWORD / PORT
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');

// 主机身份 ID 池与分配器（二次元角色名，接入时自动分配、断开时回收）
const { CHARACTER_POOL, HostIdAllocator } = require('./hostids');
const hostAllocator = new HostIdAllocator(CHARACTER_POOL);

const PORT = process.env.PORT || 7777;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 50);
const CHUNK_SIZE = 2 * 1024 * 1024; // 分片上传单片大小（2MB，须与前端一致）
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 500);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || require('crypto').randomBytes(12).toString('hex');
const ADMIN_TOKEN_TTL = Number(process.env.ADMIN_TOKEN_TTL || 1000 * 60 * 60 * 24); // 默认 24h

const DATA_DIR = path.join(__dirname, 'data');
const MSG_DIR = path.join(DATA_DIR, 'messages');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const CHUNK_DIR = path.join(DATA_DIR, 'chunks'); // 分片上传临时目录（合并后清理）
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const ROOM_FILES_FILE = path.join(DATA_DIR, 'room-files.json');

// 上传类型策略：不再拦截任何文件类型（含 exe 等可执行文件），任何类型均可传。
// 仅对「浏览器会直接渲染执行」的少数类型在存储时降级为 .bin（下载名仍保留原始名），
// 避免他人点击 .html/.svg 等即执行其中脚本。其余类型按真实扩展名存储。
const RENDER_RISK_EXT = new Set([
  'html', 'htm', 'xhtml', 'svg', 'js', 'jse', 'php', 'asp', 'aspx', 'jsp',
  'cgi', 'pl', 'hta', 'wsh', 'wsf', 'vbs', 'vbe', 'ps1', 'psm1', 'sh',
]);

// 从文件名拆分为「主体 + 扩展名」（扩展名仅字母数字，最长 10 位）
function splitName(name) {
  const s = String(name || '');
  const m = s.toLowerCase().match(/\.([a-z0-9]{1,10})$/);
  if (m) return { stem: s.slice(0, -(m[1].length + 1)), ext: m[1] };
  return { stem: s, ext: '' };
}

// 文件名净化：去除路径分隔等非法字符，避免路径穿越 / 非法文件名（保留中文等正常字符）
function sanitizeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\n\r\t]/g, '_').trim();
}

// 生成不重名的最终存储名（主体 + 安全扩展名），冲突时追加 _1 / _2 …
function uniqueStoredName(dir, stem, ext) {
  const base = (sanitizeName(stem) || 'file').slice(0, 100);
  let candidate = base + (ext ? '.' + ext : '');
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}_${i}` + (ext ? '.' + ext : '');
    i += 1;
    if (i > 99999) break; // 防止极端死循环
  }
  return candidate;
}

// ---------- 数据目录与持久化辅助 ----------

function ensureDirs() {
  for (const d of [DATA_DIR, MSG_DIR, UPLOAD_DIR, CHUNK_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}
ensureDirs();

function safeRoom(room) {
  // 仅保留安全字符与中文（CJK），防止路径穿越
  let s = String(room || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9_\-@.]/g, '').slice(0, 64);
  if (/^\.+$/.test(s)) s = ''; // 禁止纯点号文件名（如 . 或 ..）
  return s;
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
        out[k] = { password: v || null, createdAt: Date.now(), note: null };
      } else if (v && typeof v === 'object') {
        out[k] = {
          password: (v.password || null),
          createdAt: v.createdAt || Date.now(),
          note: v.note || null,
          destroyAt: (typeof v.destroyAt === 'number' && v.destroyAt > 0) ? v.destroyAt : null,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

let roomRegistry = loadRooms();

// 房间 → 文件关联索引：结构 { [room]: [filename, filename, ...] }
// 用于删除/清空房间时可靠地清理所有本地上传文件（包括上传成功但消息未发送的残留）。
function loadRoomFiles() {
  try {
    const obj = JSON.parse(fs.readFileSync(ROOM_FILES_FILE, 'utf8')) || {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string');
    }
    return out;
  } catch {
    return {};
  }
}

let roomFiles = loadRoomFiles();

function saveRoomFiles() {
  fs.writeFile(ROOM_FILES_FILE, JSON.stringify(roomFiles), (err) => {
    if (err) console.error('保存房间文件索引失败:', err.message);
  });
}

// 记录某个文件属于某个房间；幂等，不会重复添加。
function recordRoomFile(room, filename) {
  const r = safeRoom(room || '');
  const fn = String(filename || '').trim();
  if (!r || !fn) return;
  if (!roomFiles[r]) roomFiles[r] = [];
  if (!roomFiles[r].includes(fn)) {
    roomFiles[r].push(fn);
    saveRoomFiles();
  }
}

// 获取某个房间关联的所有文件名
function getRoomFiles(room) {
  const r = safeRoom(room || '');
  return r && roomFiles[r] ? [...roomFiles[r]] : [];
}

// 从索引中移除某个房间的全部记录（不删磁盘文件，仅清索引）
function removeRoomFiles(room) {
  const r = safeRoom(room || '');
  if (r && roomFiles[r]) {
    delete roomFiles[r];
    saveRoomFiles();
  }
}

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

// 彻底清空一个房间：删除消息文件、关联上传文件，并清内存缓存。
// 不碰注册表、不踢人、不动连接（destroyRoom 负责那些）。
function purgeRoomData(room) {
  // 1) 优先根据「房间-文件索引」删除所有关联上传文件（覆盖上传成功但消息未发送的残留）
  const indexed = getRoomFiles(room);
  for (const fn of indexed) {
    const p = path.join(UPLOAD_DIR, fn);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
  }
  removeRoomFiles(room);

  // 2) 兜底：再读消息文件，删除其中引用的 /uploads/ 文件（处理旧数据 / 索引缺失的情况）
  // 注意 URL 是 encodeURIComponent 编码的，需要 decode 后才能匹配磁盘上的中文文件名。
  const f = roomFile(room);
  if (fs.existsSync(f)) {
    try {
      const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(arr)) {
        for (const m of arr) {
          if (m && typeof m.url === 'string' && m.url.startsWith('/uploads/')) {
            const raw = m.url.slice('/uploads/'.length);
            const decoded = decodeURIComponent(raw);
            // 同时删除编码名和解码名，避免各种历史残留
            for (const name of [decoded, raw]) {
              const p = path.join(UPLOAD_DIR, path.basename('/uploads/' + name));
              try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
            }
          }
        }
      }
    } catch { /* ignore */ }
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  delete messageCache[room];
}

// 清空房间：删除全部消息与文件，但保留房间本身（注册表/密码/备注/在线连接均保留）
function clearRoom(room, reason) {
  reason = reason || '房间消息已被管理员清空';
  purgeRoomData(room);
  // 通知在线用户同步清空本地历史（房间与连接保留）
  if (wsRooms.has(room)) {
    for (const client of [...wsRooms.get(room)]) {
      try { client.send(JSON.stringify({ type: 'cleared', msg: reason })); } catch { /* ignore */ }
    }
  }
}

// 退房 / 自动销毁：彻底清理房间一切痕迹（消息、文件、注册表、在线连接）
function destroyRoom(room, reason) {
  reason = reason || '房间已自动销毁';
  purgeRoomData(room);
  delete roomRegistry[room];
  saveRooms();
  if (wsRooms.has(room)) {
    for (const client of [...wsRooms.get(room)]) {
      try { client.send(JSON.stringify({ type: 'error', msg: reason })); } catch { /* ignore */ }
      try { client.close(); } catch { /* ignore */ }
    }
    wsRooms.delete(room);
  }
}

// 自动销毁调度器：周期性扫描房间注册表，对到达销毁时间的房间执行彻底清理。
// 进程启动时也会立即清理一次（覆盖服务重启期间"错过"的到期房间）。
let destroyTimer = null;
function scheduleRoomDestroy() {
  function tick() {
    const now = Date.now();
    const due = [];
    for (const [name, info] of Object.entries(roomRegistry)) {
      if (info.destroyAt && info.destroyAt <= now) due.push(name);
    }
    for (const name of due) {
      console.log(`[自动销毁] 房间「${name}」到达设定的销毁时间，正在清理喵~`);
      destroyRoom(name, '房间已到自动销毁时间');
    }
  }
  // 启动即清理一次，避免服务器停机期间到期的房间残留
  tick();
  if (destroyTimer) clearInterval(destroyTimer);
  destroyTimer = setInterval(tick, 30 * 1000); // 每 30 秒扫描一次
}

// 清理过期分片临时目录：未完成/中断的上传会残留 .part 分片，定期回收避免磁盘泄漏
function cleanupChunks() {
  try {
    if (!fs.existsSync(CHUNK_DIR)) return;
    const now = Date.now();
    const MAX_AGE = 2 * 60 * 60 * 1000; // 2 小时未改动的临时目录回收
    for (const fid of fs.readdirSync(CHUNK_DIR)) {
      const dir = path.join(CHUNK_DIR, fid);
      try {
        const st = fs.statSync(dir);
        if (now - st.mtimeMs > MAX_AGE) fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
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

// 静态前端：HTML/CSS/JS 禁止浏览器缓存，确保代码更新后即时生效
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (['.html', '.css', '.js'].includes(ext)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

// 上传的文件（图片、文档等任意类型）静态服务
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

// 列出 public/avatars 下已有的真实头像文件名（前端据此决定使用本地头像还是回退）
app.get('/api/avatars', (req, res) => {
  const dir = path.join(__dirname, 'public', 'avatars');
  try {
    const names = fs.readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith('.png'))
      .map(f => f.slice(0, -4));
    res.json({ names });
  } catch {
    res.json({ names: [] });
  }
});

// 文件上传接口（返回可访问 URL，由 WS 广播该 URL 实现跨设备传输）
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // 保留原始文件名（净化 + 不重名）；仅对「浏览器会渲染执行」的类型降级为 .bin，防打开即执行
    let { stem, ext } = splitName(file.originalname);
    if (RENDER_RISK_EXT.has(ext)) ext = 'bin';
    cb(null, uniqueStoredName(UPLOAD_DIR, stem, ext));
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    // 不再拦截任何文件类型：任意扩展名均可上传
    cb(null, true);
  },
});

app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: '未收到文件喵~' });
    const url = `/uploads/${encodeURIComponent(req.file.filename)}`;
    // 文件名仅作展示/下载用，去除路径分隔等危险字符
    const safeName = String(req.file.originalname || 'file')
      .replace(/[\\/:*?"<>|\n\r\t]/g, '_')
      .slice(0, 120);
    // 记录文件与房间的关联，便于删除房间时一并清理
    recordRoomFile((req.body && req.body.room) || '', req.file.filename);
    res.json({ url, name: safeName, size: req.file.size });
  });
});

// ---------- 分片上传（大文件 / 断点续传 / 暂停继续） ----------
// 协议：客户端按 fileId（文件元信息 SHA-256 十六进制）逐片 POST 到 /chunk，服务端将每片存为
// DATA/chunks/<fileId>/<index>.part；所有分片就绪后 POST /complete 合并为最终文件；
// GET /status 返回已收到的分片下标（断点续传用），取消时 POST /cancel 清理临时目录。
const SAFE_FILE_ID = /^[a-f0-9]{16,128}$/;

const chunkUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const fid = String((req.body && req.body.fileId) || '');
      if (!SAFE_FILE_ID.test(fid)) return cb(new Error('无效的 fileId'));
      const dir = path.join(CHUNK_DIR, fid);
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return cb(e); }
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const idx = parseInt((req.body && req.body.index), 10);
      if (!Number.isInteger(idx) || idx < 0) return cb(new Error('无效的 chunk index'));
      cb(null, idx + '.part');
    },
  }),
  // 单片上限略大于 CHUNK_SIZE，容忍边界溢出
  limits: { fileSize: CHUNK_SIZE + 1024 * 1024, files: 1 },
});

// 接收单个分片
app.post('/api/upload/chunk', (req, res) => {
  chunkUpload.single('chunk')(req, res, (err) => {
    if (err) {
      const fid = (req.body && req.body.fileId) || '-';
      const idx = (req.body && req.body.index) || '-';
      const code = err.code || '-';
      const type = err instanceof multer.MulterError ? 'MulterError' : err.constructor.name;
      console.error(`[upload chunk error] ip=${req.ip || '-'} fileId=${fid} index=${idx} type=${type} code=${code} msg=${err.message}`);
      console.error(err.stack);
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      const fid = (req.body && req.body.fileId) || '-';
      const idx = (req.body && req.body.index) || '-';
      console.error(`[upload chunk error] ip=${req.ip || '-'} fileId=${fid} index=${idx} msg=no file received`);
      return res.status(400).json({ error: '未收到分片喵~' });
    }
    res.json({ ok: true, index: parseInt(req.body.index, 10) });
  });
});

// 查询已收到的分片下标，支持断点续传
app.get('/api/upload/status', (req, res) => {
  const fid = String(req.query.fileId || '');
  if (!SAFE_FILE_ID.test(fid)) return res.status(400).json({ error: '无效的 fileId' });
  const dir = path.join(CHUNK_DIR, fid);
  let received = [];
  try {
    received = fs.readdirSync(dir)
      .filter((f) => /^\d+\.part$/.test(f))
      .map((f) => parseInt(f, 10));
  } catch { /* 目录不存在视为无分片 */ }
  res.json({ received });
});

// 取消上传：清理该 fileId 的临时分片目录
app.post('/api/upload/cancel', (req, res) => {
  const fid = String((req.body && req.body.fileId) || '');
  if (!SAFE_FILE_ID.test(fid)) return res.status(400).json({ error: '无效的 fileId' });
  fs.rm(path.join(CHUNK_DIR, fid), { recursive: true, force: true }, () => {});
  res.json({ ok: true });
});

// 合并分片为最终文件并返回可访问 URL
app.post('/api/upload/complete', async (req, res) => {
  const body = req.body || {};
  const fid = String(body.fileId || '');
  const total = parseInt(body.total, 10);
  const size = parseInt(body.size, 10);
  if (!SAFE_FILE_ID.test(fid)) return res.status(400).json({ error: '无效的 fileId' });
  if (!Number.isInteger(total) || total <= 0 || total > 20000) {
    console.error(`[upload complete error] ip=${req.ip || '-'} fileId=${fid} reason=invalid_total value=${total}`);
    return res.status(400).json({ error: '无效的 total' });
  }
  if (!Number.isInteger(size) || size <= 0) {
    console.error(`[upload complete error] ip=${req.ip || '-'} fileId=${fid} reason=invalid_size value=${size}`);
    return res.status(400).json({ error: '无效的文件大小' });
  }
  const dir = path.join(CHUNK_DIR, fid);
  // 校验分片齐全，且累计大小与声明一致（防篡改 / 丢片）
  let sum = 0;
  for (let i = 0; i < total; i++) {
    const p = path.join(dir, i + '.part');
    let st;
    try { st = fs.statSync(p); } catch {
      console.error(`[upload complete error] ip=${req.ip || '-'} fileId=${fid} reason=missing_chunk index=${i}`);
      return res.status(409).json({ error: '分片缺失', missing: i });
    }
    sum += st.size;
  }
  if (sum !== size) {
    console.error(`[upload complete error] ip=${req.ip || '-'} fileId=${fid} reason=size_mismatch sum=${sum} size=${size}`);
    return res.status(400).json({ error: '分片大小与声明不符', sum, size });
  }
  // 合并为最终文件（保留原始文件名 + 安全扩展名；渲染高风险类型降级为 .bin）
  let { stem, ext } = splitName(String(body.name || ''));
  if (RENDER_RISK_EXT.has(ext)) ext = 'bin';
  const finalName = uniqueStoredName(UPLOAD_DIR, stem, ext);
  const finalPath = path.join(UPLOAD_DIR, finalName);
  try {
    const fh = await fs.promises.open(finalPath, 'w');
    for (let i = 0; i < total; i++) {
      const buf = await fs.promises.readFile(path.join(dir, i + '.part'));
      await fh.write(buf);
    }
    await fh.close();
  } catch (e) {
    console.error(`[upload complete error] ip=${req.ip || '-'} fileId=${fid} reason=merge_failed msg=${e.message}`);
    return res.status(500).json({ error: '合并失败：' + e.message });
  }
  // 清理临时分片
  fs.rm(dir, { recursive: true, force: true }, () => {});
  // 记录文件与房间的关联，便于删除房间时一并清理
  recordRoomFile(String(body.room || ''), finalName);
  const safeName = String(body.name || 'file')
    .replace(/[\\/:*?"<>|\n\r\t]/g, '_')
    .slice(0, 120);
  res.json({ url: '/uploads/' + encodeURIComponent(finalName), name: safeName, size });
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

// 房间列表（含在线人数、消息数、自动销毁时间）
app.get('/api/admin/rooms', requireAdmin, (req, res) => {
  const list = Object.keys(roomRegistry).map((name) => ({
    name,
    hasPassword: !!roomRegistry[name].password,
    note: roomRegistry[name].note || null,
    messageCount: loadMessages(name).length,
    online: wsRooms.has(name) ? wsRooms.get(name).size : 0,
    createdAt: roomRegistry[name].createdAt,
    destroyAt: roomRegistry[name].destroyAt || null,
  }));
  res.json({ rooms: list });
});

// 创建房间（可选密码 / 备注 / 自动销毁时间）
app.post('/api/admin/room/create', requireAdmin, (req, res) => {
  const room = safeRoom(req.body && req.body.room);
  if (!room) return res.status(400).json({ error: '房间名无效喵~（仅允许中英文/数字/_-@.，且不能为空或纯点号）' });
  if (roomExists(room)) return res.status(400).json({ error: '房间已存在喵~' });
  const pw = req.body && req.body.password ? String(req.body.password) : null;
  const note = req.body && req.body.note ? String(req.body.note).slice(0, 200).trim() : null;
  const destroyAt = parseDestroyAt(req.body);
  if (req.body && (req.body.destroyAt !== undefined || req.body.destroyInSeconds !== undefined) && destroyAt === null) {
    return res.status(400).json({ error: '自动销毁时间无效喵~（需为未来时间）' });
  }
  roomRegistry[room] = { password: pw, createdAt: Date.now(), note, destroyAt };
  saveRooms();
  res.json({ ok: true, destroyAt });
});

// 解析自动销毁时间：接受绝对时间戳（destroyAt，epoch ms）或相对秒数（destroyInSeconds），
// 均需为未来时间；非法或已过期则返回 null。
function parseDestroyAt(body) {
  if (!body) return null;
  let ts = null;
  if (typeof body.destroyAt === 'number' && body.destroyAt > 0) {
    ts = body.destroyAt;
  } else if (typeof body.destroyInSeconds === 'number' && body.destroyInSeconds > 0) {
    ts = Date.now() + body.destroyInSeconds * 1000;
  }
  if (!ts || ts <= Date.now()) return null;
  return ts;
}

// 修改 / 移除房间密码（password 为空则移除密码）
app.post('/api/admin/room/password', requireAdmin, (req, res) => {
  const room = safeRoom(req.body && req.body.room);
  if (!roomExists(room)) return res.status(404).json({ error: '房间不存在喵~' });
  const pw = req.body && req.body.password ? String(req.body.password) : null;
  roomRegistry[room].password = pw;
  saveRooms();
  res.json({ ok: true, hasPassword: !!pw });
});

// 设置房间备注（说明房间用途；note 为空则清除备注）
app.post('/api/admin/room/note', requireAdmin, (req, res) => {
  const room = safeRoom(req.body && req.body.room);
  if (!roomExists(room)) return res.status(404).json({ error: '房间不存在喵~' });
  const note = req.body && req.body.note ? String(req.body.note).slice(0, 200).trim() : null;
  roomRegistry[room].note = note;
  saveRooms();
  res.json({ ok: true, note });
});

// 设置 / 取消房间自动销毁时间（destroyAt 为空或 0 则取消自动销毁）
app.post('/api/admin/room/destroy-at', requireAdmin, (req, res) => {
  const room = safeRoom(req.body && req.body.room);
  if (!roomExists(room)) return res.status(404).json({ error: '房间不存在喵~' });
  const destroyAt = parseDestroyAt(req.body);
  // 显式要求取消（传入 destroyAt:0 / null / '' 等）时把自动销毁关闭
  const wantsCancel = req.body && (req.body.destroyAt === null || req.body.destroyAt === 0 || req.body.destroyAt === '' || req.body.destroyInSeconds === 0);
  if (!destroyAt && !wantsCancel) {
    return res.status(400).json({ error: '自动销毁时间无效喵~（需为未来时间，或显式取消）' });
  }
  roomRegistry[room].destroyAt = wantsCancel ? null : destroyAt;
  saveRooms();
  res.json({ ok: true, destroyAt: roomRegistry[room].destroyAt });
});

// 退房：立即销毁房间并清理全部数据（等价于到点的自动销毁）
app.post('/api/admin/room/destroy', requireAdmin, (req, res) => {
  const room = safeRoom(req.body && req.body.room);
  if (!roomExists(room)) return res.status(404).json({ error: '房间不存在喵~' });
  destroyRoom(room, '房间已被管理员退房销毁');
  res.json({ ok: true });
});

// 清空房间（删除一切存在痕迹）
app.post('/api/admin/room/clear', requireAdmin, (req, res) => {
  const room = safeRoom(req.body && req.body.room);
  if (!roomExists(room)) return res.status(404).json({ error: '房间不存在喵~' });
  clearRoom(room);
  res.json({ ok: true });
});

// 收集当前被房间消息或 room-files 索引引用的上传文件名
function collectReferencedUploads() {
  const referenced = new Set();
  for (const arr of Object.values(roomFiles)) {
    if (Array.isArray(arr)) arr.forEach((f) => referenced.add(f));
  }
  try {
    for (const f of fs.readdirSync(MSG_DIR)) {
      if (!f.endsWith('.json')) continue;
      let arr;
      try { arr = JSON.parse(fs.readFileSync(path.join(MSG_DIR, f), 'utf8')); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      for (const m of arr) {
        if (m && typeof m.url === 'string' && m.url.startsWith('/uploads/')) {
          const raw = m.url.slice('/uploads/'.length);
          referenced.add(decodeURIComponent(raw));
          referenced.add(raw);
        }
      }
    }
  } catch { /* ignore */ }
  return referenced;
}

// 列出未被任何房间引用的上传文件（孤儿文件）
app.get('/api/admin/uploads/orphans', requireAdmin, (req, res) => {
  const referenced = collectReferencedUploads();
  let files = [];
  try { files = fs.readdirSync(UPLOAD_DIR); } catch { }
  const orphans = files.filter((f) => !referenced.has(f));
  res.json({ orphans, count: orphans.length });
});

// 清理未被任何房间引用的上传文件（谨慎操作，删除后不可恢复）
app.post('/api/admin/uploads/cleanup-orphans', requireAdmin, (req, res) => {
  const referenced = collectReferencedUploads();
  let files = [];
  try { files = fs.readdirSync(UPLOAD_DIR); } catch { }
  const removed = [];
  const failed = [];
  for (const f of files) {
    if (referenced.has(f)) continue;
    const p = path.join(UPLOAD_DIR, f);
    try { fs.unlinkSync(p); removed.push(f); } catch (e) { failed.push({ file: f, error: e.message }); }
  }
  console.log(`[admin cleanup-orphans] removed=${removed.length}, failed=${failed.length}`);
  res.json({ ok: true, removed, failed, removedCount: removed.length, failedCount: failed.length });
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
  // 为新接入的主机分配唯一身份 ID（二次元角色名），并在连接建立后下发给客户端
  ws.hostId = hostAllocator.assign();
  try { ws.send(JSON.stringify({ type: 'host', id: ws.hostId })); } catch { /* ignore */ }

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
        sender: ws.hostId, // 发送方身份 ID，接收方据此区分消息来源
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
      // 兜底记录文件与房间关联（兼容旧上传接口未传 room 的情况）
      try { recordRoomFile(ws.room, decodeURIComponent(url.slice('/uploads/'.length))); } catch { /* ignore */ }
      const message = {
        id: crypto.randomUUID(),
        type: 'image',
        url,
        name: String(msg.name || '').slice(0, 120),
        sender: ws.hostId,
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
      // 兜底记录文件与房间关联（兼容旧上传接口未传 room 的情况）
      try { recordRoomFile(ws.room, decodeURIComponent(url.slice('/uploads/'.length))); } catch { /* ignore */ }
      const message = {
        id: crypto.randomUUID(),
        type: 'file',
        url,
        name: String(msg.name || '文件').slice(0, 200),
        size: Number(msg.size || 0),
        sender: ws.hostId,
        ts: Date.now(),
      };
      appendMessage(ws.room, message);
      broadcast(ws.room, { type: 'message', message });
      return;
    }
  });

  ws.on('close', () => {
    // 主机断开：释放其占用的身份 ID，供后续复用
    if (ws.hostId) { hostAllocator.release(ws.hostId); ws.hostId = null; }
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
  console.log(`Blink 运行中: http://localhost:${PORT}`);
  console.log(`管理员页面: http://localhost:${PORT}/admin.html`);
  scheduleRoomDestroy(); // 启动自动销毁扫描（含启动即清理到期房间）
  cleanupChunks();
  setInterval(cleanupChunks, 10 * 60 * 1000); // 每 10 分钟回收过期分片临时目录
  if (!process.env.ADMIN_PASSWORD) {
    console.warn(`[安全提示] 未设置 ADMIN_PASSWORD 环境变量，已生成随机管理员密码：${ADMIN_PASSWORD}`);
    console.warn('[安全提示] 公网部署前请务必通过环境变量 ADMIN_PASSWORD 设置强密码。');
  } else if (ADMIN_PASSWORD === 'admin123') {
    console.warn('[安全警告] 正在使用默认管理员密码 "admin123"，公网部署前请务必修改。');
  }
});
