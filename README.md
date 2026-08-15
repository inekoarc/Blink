# 跨设备浏览器通信（Blink）

一个**纯浏览器**的实时通信服务：部署到云服务器后，任意设备（手机 / 电脑 / 平板）打开同一个网址即可互发**文字、图片和文件**，无需安装任何客户端软件。

通过「房间号」区分通信对象，只有使用同一房间号（且密码正确）的设备才能互相收发，互不干扰。消息与文件持久化到磁盘，重启或刷新不丢失。

## 特性

- 🌐 纯网页，零客户端安装，移动端友好
- 🏠 房间号隔离，多设备共享同一房间实时互通
- 📎 支持发送任意文件（文档 / 压缩包 / 安装包等），跨设备秒收
- 🔒 可选房间密码，首次设置后生效
- 💾 文字、图片与文件持久化到磁盘（重启不丢）
- 🔁 断线自动重连
- 📋 一键复制分享链接、支持粘贴发送图片

## 快速开始（本地）

```bash
npm install
npm start
# 打开 http://localhost:3000
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

服务默认监听 `3000` 端口。可用环境变量调整：

- `PORT`：监听端口（默认 `3000`）
- `MAX_UPLOAD_MB`：单文件大小上限（默认 `50`，单位 MB）
- `MAX_HISTORY`：单房间保留消息条数（默认 `500`）
- `ADMIN_PASSWORD`：管理员登录密码（默认 `admin123`，**公网部署务必修改**）
- `ADMIN_TOKEN_TTL`：管理员登录有效期，毫秒（默认 `86400000` = 24 小时）

## 管理员与房间管控

为防网址泄露后被恶意占用，房间采用「**先建后入**」模型：**游客只能加入由管理员预先创建、且未被清空的房间**，无法自行创建或认领房间。

访问 `http://<域名或IP>:3000/admin.html` 进入管理页，用 `ADMIN_PASSWORD` 登录后可：

- **创建房间**：指定房间名（仅允许 `字母/数字/_-@.`）与可选密码。
- **修改密码**：覆盖或移除某房间的密码。
- **清空房间**：删除该房间的全部消息、图片、文件与密码记录，房间不再存在，在线用户会被踢出。

API 一览（均需 `Authorization: Bearer <token>` 头）：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/admin/login` | 密码登录，返回 token |
| POST | `/api/admin/logout` | 注销当前 token |
| GET  | `/api/admin/me` | 校验 token 是否有效 |
| GET  | `/api/admin/rooms` | 房间列表（含在线人数、消息数） |
| POST | `/api/admin/room/create` | `{ room, password? }` 创建房间 |
| POST | `/api/admin/room/password` | `{ room, password }` 改/移除密码 |
| POST | `/api/admin/room/clear` | `{ room }` 清空房间 |

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
        proxy_pass http://127.0.0.1:3000;
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

## 使用说明

1. 打开网址，输入**房间号**（和可选密码）进入。
2. 把网址连同 `?room=房间号` 通过「分享」按钮复制给另一台设备。
3. 两台设备进入同一房间后，发文字、点 🖼️ 发图片、点 📎 发文件，实时互收。
4. 文件会在房间内持久保存，晚进入的设备也可从历史中下载。

## 目录结构

```
server.js            主服务（Express + ws + 上传接口 + 持久化）
public/              前端（index.html / app.js / style.css）
data/                运行时数据（消息 / 房间密码 / 上传文件），已 gitignore
Dockerfile           容器构建
docker-compose.yml   容器编排
ecosystem.config.js  pm2 配置
```

## 安全说明

- 渲染消息使用 `textContent` / 转义，防止 XSS。
- 文件上传采用**黑名单**：屏蔽可在浏览器渲染执行、或客户端直接执行的类型（如 html/svg/js/exe/ps1 等），其余类型均可；随机文件名防路径猜测与穿越。
- 上传的文件广播仅允许本站 `/uploads/` 路径，防外链注入。
- 房间密码与文件内容在客户端 → 服务端明文传输，**必须配合 HTTPS** 使用才安全。

## 暂未实现（可后续扩展）

用户注册登录、端到端加密、消息过期自动清理、消息撤回/编辑。
