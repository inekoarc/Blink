# 跨设备浏览器通信（Blink）

一个**纯浏览器**的实时通信服务：部署到云服务器后，任意设备（手机 / 电脑 / 平板）打开同一个网址即可互发**文字、图片、文件和表情**，无需安装任何客户端软件。

通过「房间号」区分通信对象，只有使用同一房间号（且密码正确）的设备才能互相收发，互不干扰。消息与文件持久化到磁盘，重启或刷新不丢失。

## 特性

- 🌐 纯网页，零客户端安装，移动端友好
- 🏠 房间号隔离，多设备共享同一房间实时互通
- 📎 支持发送任意文件（文档 / 压缩包 / 安装包等），跨设备秒收
- 🔒 可选房间密码，首次设置后生效
- 💾 文字、图片与文件持久化到磁盘（重启不丢）
- 🔁 断线自动重连
- 🎭 多主机随机身份：每台设备自动分配二次元角色名，断开即释放复用
- 💬 QQ 风格气泡消息，本地化真实角色头像
- 😊 内置百度贴吧经典表情包（滑稽、汗、黑线等 50 个），随消息发送
- 💣 房间退房（彻底删除）与到点自动销毁（清理房间及全部内容）
- 📋 一键复制分享链接、支持粘贴发送图片

## 快速开始（本地）

```bash
npm install
npm start
# 打开 http://localhost:7777
```

打开两个浏览器标签（或用手机 + 电脑），输入**相同房间号**即可互发消息。

## 部署到云服务器

### 方式一：直接运行（Node + pm2）

```bash
# 1. 安装 Node.js 18+
git clone <本仓库> && cd <目录>
npm install

# 2. 用 pm2 守护进程（开机自启）
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # 按提示执行生成的命令
```

服务默认监听 `7777` 端口（可用 `PORT` 环境变量修改）。其他可用环境变量：

- `PORT`：监听端口（默认 `7777`）
- `MAX_UPLOAD_MB`：单文件大小上限（默认 `50`，单位 MB）
- `MAX_HISTORY`：单房间保留消息条数（默认 `500`）
- `ADMIN_PASSWORD`：管理员登录密码（默认随机生成并打印到日志，**公网部署务必显式设置**）
- `ADMIN_TOKEN_TTL`：管理员登录有效期，毫秒（默认 `86400000` = 24 小时）

> ⚠️ **改代码后必须重启进程**：修改服务端代码（`server.js` / `hostids.js` 等）后，必须**重启 Node 进程**（如 `pm2 restart all`）才会生效——运行中进程不会热更新，仅同步 / `git pull` 文件是不够的。前端静态文件（`public/` 下）改动则只需刷新浏览器。

### 方式二：Docker

```bash
docker compose up -d --build
# 数据持久化在 ./data 目录
```

### HTTPS（强烈建议）

明文下房间密码与文件内容会被嗅探，请务必用 nginx 反代并配置 Let's Encrypt 免费证书：

```nginx
server {
    listen 443 ssl;
    server_name your.domain.com;

    ssl_certificate     /etc/letsencrypt/live/your.domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your.domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:7777;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 60m;   # 需大于 MAX_UPLOAD_MB
    }
}

server {
    listen 80;
    server_name your.domain.com;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}
```

> 申请证书：`sudo certbot --nginx -d your.domain.com`
> 前端会自动根据页面协议选择 `wss://` 或 `ws://`，HTTPS 下即为加密连接。

## 管理员与房间管控

为防网址泄露后被恶意占用，房间采用「**先建后入**」模型：**游客只能加入由管理员预先创建、且未被清空的房间**，无法自行创建或认领房间。

访问 `http://<域名或IP>:7777/admin.html` 进入管理页，用 `ADMIN_PASSWORD` 登录后可：

- **创建房间**：指定房间名（仅允许 `中文/字母/数字/_-@.`，最长 64 字符）与可选密码，并可设定自动销毁时间。
- **修改密码**：覆盖或移除某房间的密码。
- **房间备注**：为房间添加备注说明（仅管理员可见）。
- **清空房间**：删除该房间的全部消息、图片、文件（**保留房间本身与密码**，在线用户不踢出）。
- **退房**：彻底删除房间（删除注册表、消息与文件，并踢出在线用户）。
- **设置自动销毁**：为房间设定到期时间，到点后自动清理房间及全部内容；每次服务启动也会清理已过期房间（值为 0/null 可取消）。

API 一览（管理员接口均需 `Authorization: Bearer <token>` 头）：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/admin/login` | 密码登录，返回 token |
| POST | `/api/admin/logout` | 注销当前 token |
| GET  | `/api/admin/me` | 校验 token 是否有效 |
| GET  | `/api/admin/rooms` | 房间列表（含在线人数、消息数、销毁时间） |
| POST | `/api/admin/room/create` | `{ room, password?, destroyAt?, destroyInSeconds? }` 创建房间 |
| POST | `/api/admin/room/password` | `{ room, password }` 改/移除密码 |
| POST | `/api/admin/room/note` | `{ room, note }` 设置房间备注 |
| POST | `/api/admin/room/destroy-at` | `{ room, destroyAt?, destroyInSeconds? }` 设置/取消自动销毁时间（0/null 取消） |
| POST | `/api/admin/room/clear` | `{ room }` 清空房间（保留房间） |
| POST | `/api/admin/room/destroy` | `{ room }` 退房（彻底删除房间并踢在线用户） |

> 前端另有 `/api/room/check`（进入前校验房间是否存在 / 需密码）、`/api/avatars`（头像清单）等接口，供页面内部调用。

## 使用说明

1. 打开网址，输入**房间号**（和可选密码）进入。
2. 把网址连同 `?room=房间号` 通过「分享」按钮复制给另一台设备。
3. 两台设备进入同一房间后，发文字、点 😊 选贴吧表情、点 🖼️ 发图片、点 📎 发文件，实时互收。
4. 消息以 QQ 风格气泡展示，每条带有随机分配的二次元角色身份与头像；时间显示在消息底部。
5. 文件会在房间内持久保存，晚进入的设备也可从历史中下载。

## 身份、头像与表情

### 多主机随机身份
每台接入设备会由服务端从二次元角色名池（原神 / 鸣潮 / 星铁 / 崩坏3 / 方舟 / 番剧等，见 `hostids.js`）随机分配一个**全局唯一、连接期间稳定**的展示身份（如「雷电将军」）。设备断开连接即释放该名字，供后续复用。身份只是本场次的展示人格，每条消息本身带有唯一 UUID 与时间戳，不会产生混淆。

> 身份绑定的是「本次 WebSocket 连接」而非账号或房间：刷新页面 / 断开重连会重新分配一个名字。

### 头像
消息头像优先使用 `public/avatars/<角色名>.png`（已本地化一批原神角色头像）；若该角色缺图，则回退为名字首字的彩色 SVG 占位图。

**自定义头像**：把图片按 `public/avatars/<角色名>.png` 命名放入该目录即可生效，无需改代码。

### 贴吧经典表情包
聊天输入框旁有 😊 按钮，点击弹出百度贴吧经典表情面板（滑稽、汗、黑线、阴险等 50 个，按「表情 / 物品」分类）。选中表情以 `[表情名]` 形式插入输入框，随消息发送，并在消息中渲染为内联小图。

**新增表情**：将图片按 `public/emojis/i_fXX.png` 命名放入该目录，并在 `public/emojiData.js` 登记一行即可。

## 目录结构

```
server.js            主服务（Express + ws + 上传接口 + 持久化 + 房间自动销毁）
hostids.js           主机身份角色名池与随机分配器（多主机身份）
public/              前端（index.html / app.js / style.css / emojiData.js / avatarMap.js）
public/avatars/      真实角色头像（<角色名>.png，约定式自定义）
public/emojis/       百度贴吧经典表情图片（i_fXX.png）
data/                运行时数据（消息 / 房间密码 / 上传文件），已 gitignore
Dockerfile           容器构建
docker-compose.yml   容器编排
ecosystem.config.js  pm2 配置
```

## 安全说明

- 渲染消息使用 `textContent` / 转义，防止 XSS。
- 文件上传采用**黑名单**：屏蔽可在浏览器渲染执行、或客户端直接执行的类型（如 html/svg/js/exe/ps1 等），其余类型均可；随机文件名防路径猜测与穿越。
- **大文件分片上传**：前端 `uploader.js` 按 2MB 分片逐片 POST 到 `/api/upload/chunk`，服务端落 `data/chunks/<fileId>/<index>.part`；全部就绪后 `/api/upload/complete` 合并为最终文件。支持实时进度/速度、暂停/继续/取消、网络中断自动重试与断点续传（`/api/upload/status` 查询已传分片）；未完成的上传临时目录每 10 分钟自动回收（2 小时未改动即清理）。
- 上传的文件广播仅允许本站 `/uploads/` 路径，防外链注入。
- 房间密码与文件内容在客户端 → 服务端明文传输，**必须配合 HTTPS** 使用才安全。

## 暂未实现（可后续扩展）

用户注册登录、端到端加密、消息撤回/编辑。

> 注：消息过期自动清理已通过「房间自动销毁时间」实现（管理员可为房间设定到期时间，到点清理房间及全部内容）。
