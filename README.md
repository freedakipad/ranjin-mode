# 🔥 燃尽模式 (Ranjin Mode)

[中文](#-燃尽模式-ranjin-mode) | [English](#-ranjin-mode-english)

---

**AI 持久输出助手** — AI 想结束时自动弹窗确认，支持手机远程遥控 AI 对话，兼容 Cursor / Windsurf / VS Code。

## 核心特性

- 🔄 **AI 持久输出** — AI 想结束对话时自动弹窗拦截，让你选择继续或停止
- 📱 **手机远程遥控** — 在手机上远程给 AI 下指令，无需守在电脑前
- 🌐 **公网中继模式** — 通过中继服务器实现跨网络远程控制（不限于局域网）
- 🤖 **多 IDE 支持** — 自动识别 Cursor / Windsurf / VS Code，生成对应规则文件
- 📊 **使用统计** — 记录 AI 交互次数、继续/结束比例等数据
- 📝 **历史记录** — 保存所有交互记录，支持导出
- ⌨️ **快捷键** — `Cmd+Shift+M` / `Ctrl+Shift+M` 手动触发反馈弹窗

## 项目结构

```
mcursor/
├── ranjin-mode-src/extension/     # VS Code/Cursor 扩展（核心）
│   ├── extension.js               # 扩展主入口
│   ├── dialog-trigger.js          # AI 触发脚本（AI 直接调用）
│   ├── webview.html               # 侧边栏控制面板 UI
│   ├── package.json               # 扩展元数据
│   ├── lib/                       # 核心模块
│   │   ├── config.js              # 配置常量和工具函数
│   │   ├── dialog-manager.js      # 弹窗管理（核心交互逻辑）
│   │   ├── remote-manager.js      # 远程服务管理（局域网+中继）
│   │   ├── history-manager.js     # 对话历史管理
│   │   ├── stats-manager.js       # 使用统计
│   │   ├── rules-manager.js       # AI 规则文件生成
│   │   └── ide-detector.js        # IDE 类型检测
│   └── remote/                    # 局域网远程服务
│       ├── server.js              # 内嵌 HTTP + WebSocket 服务器
│       └── static/                # 局域网手机端前端
│
├── relay-server/                  # 公网中继服务器（独立部署）
│   ├── server.js                  # 中继服务器主程序
│   ├── static/                    # 手机端 Web 界面
│   │   ├── index.html
│   │   ├── app.js
│   │   └── style.css
│   ├── package.json
│   ├── Dockerfile                 # Docker 部署支持
│   └── .env.example               # 环境变量示例
│
└── README.md
```

## 工作原理

```
┌─────────────────────────────────────────────────────────────┐
│                        完整交互流程                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  AI 执行任务完成                                              │
│       ↓                                                     │
│  AI 调用 dialog-trigger.js（写入 dialog_request 文件）         │
│       ↓                                                     │
│  扩展检测到请求 → 弹出确认弹窗                                  │
│       ↓                            ↓                        │
│  [电脑端] 用户点击弹窗       [手机端] 推送到手机                  │
│       ↓                            ↓                        │
│  写入 dialog_response 文件    用户在手机上回复                   │
│       ↓                            ↓                        │
│  dialog-trigger.js 读取       通过 WebSocket 写入响应文件       │
│       ↓                            ↓                        │
│  返回给 AI（继续/停止 + 反馈内容）                               │
│       ↓                                                     │
│  AI 根据反馈继续执行任务                                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 两种远程模式

```
模式 1：局域网模式（默认）
┌──────────┐     WiFi      ┌───────────────┐
│  📱 手机  │ ◄──────────► │ 🖥️ Cursor 扩展 │
└──────────┘  HTTP+WS       │  (内嵌服务器)   │
               同一网络      └───────────────┘

模式 2：公网中继模式
┌──────────┐              ┌───────────────┐              ┌───────────────┐
│  📱 手机  │ ◄──── WS ──►│ 🌐 中继服务器   │◄──── WS ───►│ 🖥️ Cursor 扩展 │
└──────────┘   公网访问     │ (VPS/云服务器)  │   公网连接    └───────────────┘
                           └───────────────┘
```

## 快速开始

### 第一步：安装扩展

#### 方式 A：从 VSIX 安装（推荐）

```bash
# 进入扩展目录
cd ranjin-mode-src/extension

# 打包
npx --yes @vscode/vsce package

# 安装到 Cursor（或 VS Code / Windsurf）
# Cmd+Shift+P → "Extensions: Install from VSIX..." → 选择 ranjin-mode-7.0.1.vsix
```

#### 方式 B：直接复制到扩展目录

```bash
# Cursor 扩展目录
cp -r ranjin-mode-src/extension ~/.cursor/extensions/ranjin.ranjin-mode-7.0.1

# VS Code 扩展目录
cp -r ranjin-mode-src/extension ~/.vscode/extensions/ranjin.ranjin-mode-7.0.1
```

安装后重启 IDE，左侧活动栏会出现 🔥 图标。

### 第二步：使用扩展

1. 点击左侧栏 🔥 图标，打开燃尽模式控制面板
2. 扩展会自动：
   - 在项目根目录生成 `.cursorrules`（Cursor）或 `.windsurfrules`（Windsurf）
   - 将 `dialog-trigger.js` 复制到 `~/.ranjin-mode/`
   - 开始监听 AI 的弹窗请求
3. 正常使用 AI 编程，AI 完成任务时会自动弹窗让你确认

### 第三步：启用手机远程（可选）

#### 局域网模式

1. 在侧边栏控制面板中开启「📡 远程手机服务」
2. 复制显示的地址和 API Key
3. 在手机浏览器打开地址（确保手机和电脑在同一 WiFi）
4. 输入 API Key 即可开始使用

#### 公网中继模式（跨网络）

需要先部署中继服务器（见下方），然后：

1. 在侧边栏「🌐 公网中继服务」填写：
   - **中继服务器地址**：`ws://你的服务器IP:8800`
   - **API Key**：中继服务器配置的 API Key
2. 点击「🔗 连接」
3. 手机浏览器打开 `http://你的服务器IP:8800`
4. 输入 API Key → 选择 IDE 会话 → 开始远程对话

## 中继服务器部署

中继服务器是一个独立的 Node.js 应用，部署在公网服务器上，用于中转 IDE 和手机之间的 WebSocket 通信。

### 方式 A：直接部署

```bash
# 1. 将 relay-server 目录复制到服务器
scp -r relay-server/ user@your-server:/opt/ranjin-relay/

# 2. SSH 登录服务器
ssh user@your-server
cd /opt/ranjin-relay

# 3. 安装依赖
npm install --production

# 4. 配置环境变量
cp .env.example .env
nano .env  # 修改 API_KEY 等配置
```

`.env` 配置说明：

```env
PORT=8800                    # 服务端口
API_KEY=your-secret-key      # API 密钥（IDE 和手机端都需要）
ALLOWED_ORIGINS=*            # 允许的跨域来源
MAX_HISTORY=100              # 最大历史记录数
MAX_MESSAGE_LENGTH=4000      # 单条消息最大长度
HEARTBEAT_INTERVAL=30000     # WebSocket 心跳间隔 (ms)
CLIENT_TIMEOUT=90000         # 客户端超时时间 (ms)
```

```bash
# 5. 使用 PM2 启动（推荐）
npm install -g pm2
pm2 start server.js --name ranjin-relay
pm2 save
pm2 startup  # 设置开机自启
```

### 方式 B：Docker 部署

```bash
cd relay-server

# 构建镜像
docker build -t ranjin-relay .

# 运行
docker run -d \
  --name ranjin-relay \
  -p 8800:8800 \
  -e API_KEY=your-secret-key \
  --restart unless-stopped \
  ranjin-relay
```

### 验证部署

```bash
# 健康检查
curl http://your-server:8800/api/health

# 测试 API 认证
curl -H "X-API-Key: your-secret-key" http://your-server:8800/api/sessions
```

### 防火墙配置

确保服务器的 8800 端口（或你配置的端口）对外开放：

```bash
# Ubuntu/Debian
sudo ufw allow 8800/tcp

# CentOS
sudo firewall-cmd --add-port=8800/tcp --permanent
sudo firewall-cmd --reload

# 云服务器（如腾讯云/阿里云）还需要在安全组中放行端口
```

### 域名 + HTTPS 配置（推荐）

国内服务器 HTTP 端口可能被运营商拦截，推荐配置域名 + SSL：

```bash
# 1. 添加 DNS 解析：A 记录指向服务器 IP

# 2. Nginx 反向代理配置
# 在 nginx.conf 的 http block 中添加（如果没有）：
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

# 3. 创建站点配置 /etc/nginx/sites-enabled/your-domain
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:8800;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}

# 4. 使用 Certbot 获取 SSL 证书（DNS 验证方式，适合国内）
sudo certbot certonly --manual --preferred-challenges dns -d your-domain.com

# 5. 测试并重载 Nginx
sudo nginx -t && sudo systemctl reload nginx
```

配置完成后：
- 📱 手机访问：`https://your-domain.com`
- 🖥️ 插件中继地址改为：`wss://your-domain.com`（注意是 `wss://` 不是 `ws://`）

## 侧边栏功能说明

| 功能区域 | 说明 |
|---|---|
| 📊 使用统计 | 显示当前会话和总体的 AI 交互统计数据 |
| 📡 远程手机服务 | 局域网模式开关，显示连接地址和 API Key |
| 🌐 公网中继服务 | 公网中继模式，填写中继服务器地址和 API Key |
| 📝 对话历史 | 查看、导出、清空 AI 交互历史记录 |

## API 接口

### 中继服务器 API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/health` | GET | 健康检查（不需要认证） |
| `/api/sessions` | GET | 列出所有活跃的 IDE 会话 |
| `/api/cursor-status` | GET | 获取指定会话的 IDE 等待状态 |
| `/api/history` | GET | 获取会话历史记录 |
| `/api/history` | DELETE | 清空会话历史 |
| `/api/message` | POST | 发送消息到 IDE |
| `/api/notify` | POST | 通知手机端消息 |

所有 API（除 `/api/health`）需要 `X-API-Key` 请求头。多会话场景需要 `X-Session-Key` 请求头或 `?sessionKey=` 参数。

### WebSocket 连接

```
IDE 端：   ws://server:8800?apiKey=KEY&type=ide&sessionKey=SESSION
手机端：   ws://server:8800?apiKey=KEY&type=mobile&sessionKey=SESSION
```

### WebSocket 消息类型

| 类型 | 方向 | 说明 |
|---|---|---|
| `init` | 服务器→客户端 | 连接初始化（包含历史记录） |
| `dialog_request` | IDE→手机 | AI 等待用户输入 |
| `dialog_resolved` | IDE→手机 | AI 已收到反馈并继续 |
| `mobile_feedback` | 手机→IDE | 手机端发送的反馈指令 |
| `status_update` | 服务器→手机 | IDE 状态变更通知 |
| `cursor_message` | 服务器→手机 | IDE 消息转发 |
| `user_message` | 服务器→全部 | 用户消息广播 |

## 关键文件说明

### `dialog-trigger.js`

AI 直接调用的脚本。写入 `dialog_request_*.json` 文件并轮询等待 `dialog_response_*.json` 响应。

AI 调用方式（在 `.cursorrules` 中自动配置）：

```bash
node ~/.ranjin-mode/dialog-trigger.js "cursor" "项目ID" "AI想要结束的原因摘要"
```

### 规则文件

扩展自动在每个项目根目录生成规则文件：

- **Cursor** → `.cursorrules`
- **Windsurf** → `.windsurfrules`

规则文件告诉 AI 在完成任务时调用 `dialog-trigger.js`，实现弹窗拦截。

### 数据目录

所有运行时数据保存在 `~/.ranjin-mode/`：

```
~/.ranjin-mode/
├── dialog-trigger.js           # 触发脚本副本
├── dialog_request_*.json       # AI 写入的请求文件
├── dialog_response_*.json      # 用户/手机端写入的响应文件
├── stats.json                  # 使用统计
├── history/                    # 对话历史（按天保存）
├── images/                     # 用户上传的图片
├── relay_config.json           # 中继服务器配置
├── remote_enabled.txt          # 局域网远程开关
├── remote_port.txt             # 局域网服务端口
└── remote_api_key.txt          # 局域网 API Key
```

## 快捷键

| 快捷键 | 功能 |
|---|---|
| `Cmd+Shift+M` (Mac) | 手动触发反馈弹窗 |
| `Ctrl+Shift+M` (Win/Linux) | 手动触发反馈弹窗 |

## 常见问题

### 扩展安装后左侧栏没有 🔥 图标？

重启 IDE（`Cmd+Shift+P` → `Reload Window`）。如果仍然没有，检查扩展是否安装成功：`Cmd+Shift+P` → `Extensions: Show Installed Extensions` → 搜索 `ranjin`。

### 手机端局域网无法连接？

1. 确保手机和电脑在同一 WiFi 网络
2. 关闭电脑防火墙或允许端口（默认 3000）
3. 在侧边栏确认远程服务已开启（显示绿色状态）

### 公网中继一直显示"正在连接"？

1. 检查中继服务器是否正常运行：`curl http://服务器:8800/api/health`
2. 检查 API Key 是否正确
3. 确保 URL 格式为 `ws://服务器:8800`（不是 `http://`）
4. 查看 IDE 输出面板（`Cmd+Shift+U`）搜索 `[中继]` 相关日志

### 手机端打开中继页面一片黑？

页面使用深色主题（黑底白字）。如果看起来一片黑，请注意屏幕中央是否有 API Key 输入弹窗。如果真的没有内容，可能是 JavaScript 加载失败，检查浏览器控制台。

### 手机发送消息后 AI 没有反应？

1. 消息只有在 AI 正在"等待中"状态时才会被读取
2. 确认 IDE 状态显示为 ⏳ 等待中（而不是 🟢 空闲）
3. AI 需要先执行 `dialog-trigger.js` 并等待反馈

### 如何更换 API Key？

- **局域网模式**：编辑 `~/.ranjin-mode/remote_api_key.txt`，重启远程服务
- **中继模式**：修改中继服务器的 `.env` 文件中的 `API_KEY`，然后 `pm2 restart ranjin-relay`

## 安全建议

1. **修改默认 API Key** — 不要使用示例中的 API Key
2. **限制来源** — 生产环境中设置 `ALLOWED_ORIGINS` 为具体域名
3. **使用 HTTPS** — 如果中继服务器暴露在公网，建议配置 Nginx 反向代理 + SSL
4. **定期检查日志** — `pm2 logs ranjin-relay` 查看是否有异常访问

## 技术栈

- **扩展端**：VS Code Extension API, Node.js, WebSocket (`ws`)
- **中继服务器**：Node.js, Express-like HTTP, WebSocket (`ws`)
- **手机端**：原生 HTML/CSS/JS, WebSocket API
- **进程管理**：PM2
- **容器化**：Docker

## License

MIT

---

# 🔥 Ranjin Mode (English)

**AI Persistent Output Assistant** — Automatically intercepts when AI wants to end a conversation, supports mobile remote control of AI, compatible with Cursor / Windsurf / VS Code.

## Key Features

- 🔄 **AI Persistent Output** — Auto-popup when AI wants to end, letting you choose to continue or stop
- 📱 **Mobile Remote Control** — Send instructions to AI from your phone, no need to stay at your computer
- 🌐 **Public Relay Mode** — Remote control across networks via relay server (not limited to LAN)
- 🤖 **Multi-IDE Support** — Auto-detects Cursor / Windsurf / VS Code, generates corresponding rule files
- 📊 **Usage Statistics** — Records AI interaction counts, continue/end ratios
- 📝 **History** — Saves all interactions, supports export
- ⌨️ **Keyboard Shortcut** — `Cmd+Shift+M` / `Ctrl+Shift+M` to manually trigger feedback dialog

## Project Structure

```
mcursor/
├── ranjin-mode-src/extension/     # VS Code/Cursor Extension (core)
│   ├── extension.js               # Extension entry point
│   ├── dialog-trigger.js          # AI trigger script (called by AI directly)
│   ├── webview.html               # Sidebar control panel UI
│   ├── package.json               # Extension metadata
│   ├── lib/                       # Core modules
│   │   ├── config.js              # Configuration constants and utilities
│   │   ├── dialog-manager.js      # Dialog management (core interaction logic)
│   │   ├── remote-manager.js      # Remote service management (LAN + relay)
│   │   ├── history-manager.js     # Conversation history management
│   │   ├── stats-manager.js       # Usage statistics
│   │   ├── rules-manager.js       # AI rule file generation
│   │   └── ide-detector.js        # IDE type detection
│   └── remote/                    # LAN remote service
│       ├── server.js              # Embedded HTTP + WebSocket server
│       └── static/                # LAN mobile frontend
│
├── relay-server/                  # Public relay server (standalone deployment)
│   ├── server.js                  # Relay server main program
│   ├── static/                    # Mobile web interface
│   │   ├── index.html
│   │   ├── app.js
│   │   └── style.css
│   ├── package.json
│   ├── Dockerfile                 # Docker deployment support
│   └── .env.example               # Environment variable template
│
└── README.md
```

## How It Works

```
┌──────────────────────────────────────────────────────────────┐
│                     Complete Interaction Flow                 │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  AI completes a task                                         │
│       ↓                                                      │
│  AI calls dialog-trigger.js (writes dialog_request file)     │
│       ↓                                                      │
│  Extension detects request → Shows confirmation popup        │
│       ↓                              ↓                       │
│  [Desktop] User clicks popup    [Mobile] Push to phone       │
│       ↓                              ↓                       │
│  Writes dialog_response file    User replies on phone        │
│       ↓                              ↓                       │
│  dialog-trigger.js reads it     Via WebSocket writes response│
│       ↓                              ↓                       │
│  Returns to AI (continue/stop + feedback content)            │
│       ↓                                                      │
│  AI continues executing based on feedback                    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Two Remote Modes

```
Mode 1: LAN Mode (default)
┌──────────┐     WiFi      ┌─────────────────┐
│  📱 Phone │ ◄──────────► │ 🖥️ Cursor Ext.   │
└──────────┘  HTTP+WS       │  (embedded srv)  │
               same network └─────────────────┘

Mode 2: Public Relay Mode
┌──────────┐              ┌───────────────┐              ┌─────────────────┐
│  📱 Phone │ ◄──── WS ──►│ 🌐 Relay Server│◄──── WS ───►│ 🖥️ Cursor Ext.   │
└──────────┘   public net  │ (VPS/Cloud)   │   public net └─────────────────┘
                           └───────────────┘
```

## Quick Start

### Step 1: Install the Extension

#### Option A: Install from VSIX (Recommended)

```bash
# Enter the extension directory
cd ranjin-mode-src/extension

# Package
npx --yes @vscode/vsce package

# Install in Cursor (or VS Code / Windsurf)
# Cmd+Shift+P → "Extensions: Install from VSIX..." → select ranjin-mode-7.0.1.vsix
```

#### Option B: Copy directly to extensions directory

```bash
# Cursor extensions directory
cp -r ranjin-mode-src/extension ~/.cursor/extensions/ranjin.ranjin-mode-7.0.1

# VS Code extensions directory
cp -r ranjin-mode-src/extension ~/.vscode/extensions/ranjin.ranjin-mode-7.0.1
```

After installation, restart the IDE. A 🔥 icon will appear in the activity bar.

### Step 2: Use the Extension

1. Click the 🔥 icon in the sidebar to open the Ranjin Mode control panel
2. The extension will automatically:
   - Generate `.cursorrules` (Cursor) or `.windsurfrules` (Windsurf) in the project root
   - Copy `dialog-trigger.js` to `~/.ranjin-mode/`
   - Start monitoring AI popup requests
3. Use AI coding normally — the popup will appear automatically when AI completes a task

### Step 3: Enable Mobile Remote (Optional)

#### LAN Mode

1. Toggle on "📡 Remote Phone Service" in the sidebar control panel
2. Copy the displayed address and API Key
3. Open the address in your phone's browser (phone and computer must be on the same WiFi)
4. Enter the API Key to start using

#### Public Relay Mode (Cross-Network)

Deploy the relay server first (see below), then:

1. In the sidebar "🌐 Public Relay Service" section, enter:
   - **Relay Server URL**: `ws://your-server-ip:8800`
   - **API Key**: The API Key configured on the relay server
2. Click "🔗 Connect"
3. Open `http://your-server-ip:8800` in your phone's browser
4. Enter API Key → Select IDE session → Start remote chatting

## Relay Server Deployment

The relay server is a standalone Node.js application deployed on a public server to relay WebSocket communication between the IDE and mobile devices.

### Option A: Direct Deployment

```bash
# 1. Copy relay-server directory to your server
scp -r relay-server/ user@your-server:/opt/ranjin-relay/

# 2. SSH into the server
ssh user@your-server
cd /opt/ranjin-relay

# 3. Install dependencies
npm install --production

# 4. Configure environment variables
cp .env.example .env
nano .env  # Edit API_KEY and other settings
```

`.env` Configuration:

```env
PORT=8800                    # Server port
API_KEY=your-secret-key      # API key (required by both IDE and mobile)
ALLOWED_ORIGINS=*            # Allowed CORS origins
MAX_HISTORY=100              # Max history records
MAX_MESSAGE_LENGTH=4000      # Max message length
HEARTBEAT_INTERVAL=30000     # WebSocket heartbeat interval (ms)
CLIENT_TIMEOUT=90000         # Client timeout (ms)
```

```bash
# 5. Start with PM2 (recommended)
npm install -g pm2
pm2 start server.js --name ranjin-relay
pm2 save
pm2 startup  # Enable auto-start on boot
```

### Option B: Docker Deployment

```bash
cd relay-server

# Build image
docker build -t ranjin-relay .

# Run
docker run -d \
  --name ranjin-relay \
  -p 8800:8800 \
  -e API_KEY=your-secret-key \
  --restart unless-stopped \
  ranjin-relay
```

### Verify Deployment

```bash
# Health check
curl http://your-server:8800/api/health

# Test API authentication
curl -H "X-API-Key: your-secret-key" http://your-server:8800/api/sessions
```

### Firewall Configuration

Make sure port 8800 (or your configured port) is open:

```bash
# Ubuntu/Debian
sudo ufw allow 8800/tcp

# CentOS
sudo firewall-cmd --add-port=8800/tcp --permanent
sudo firewall-cmd --reload

# Cloud providers (AWS, GCP, Tencent Cloud, Alibaba Cloud):
# also open the port in the security group settings
```

### Domain + HTTPS Setup (Recommended)

For production use, set up a domain with SSL using Nginx as a reverse proxy:

```bash
# 1. Add DNS A record pointing to your server IP

# 2. Add to nginx.conf http block (if not already present):
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

# 3. Create site config /etc/nginx/sites-enabled/your-domain
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:8800;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}

# 4. Get SSL certificate with Certbot (DNS challenge for China servers)
sudo certbot certonly --manual --preferred-challenges dns -d your-domain.com

# 5. Test and reload Nginx
sudo nginx -t && sudo systemctl reload nginx
```

After setup:
- 📱 Mobile: `https://your-domain.com`
- 🖥️ Extension relay URL: `wss://your-domain.com` (note: `wss://` not `ws://`)

## Sidebar Features

| Section | Description |
|---|---|
| 📊 Usage Statistics | Shows current session and overall AI interaction statistics |
| 📡 Remote Phone Service | LAN mode toggle, displays connection address and API Key |
| 🌐 Public Relay Service | Public relay mode, enter relay server URL and API Key |
| 📝 Chat History | View, export, and clear AI interaction history |

## API Reference

### Relay Server HTTP API

| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | Health check (no auth required) |
| `/api/sessions` | GET | List all active IDE sessions |
| `/api/cursor-status` | GET | Get IDE waiting status for a session |
| `/api/history` | GET | Get session history |
| `/api/history` | DELETE | Clear session history |
| `/api/message` | POST | Send message to IDE |
| `/api/notify` | POST | Notify mobile clients |

All APIs (except `/api/health`) require the `X-API-Key` header. For multi-session scenarios, use the `X-Session-Key` header or `?sessionKey=` parameter.

### WebSocket Connection

```
IDE:    ws://server:8800?apiKey=KEY&type=ide&sessionKey=SESSION
Mobile: ws://server:8800?apiKey=KEY&type=mobile&sessionKey=SESSION
```

### WebSocket Message Types

| Type | Direction | Description |
|---|---|---|
| `init` | Server→Client | Connection init (includes history) |
| `dialog_request` | IDE→Mobile | AI waiting for user input |
| `dialog_resolved` | IDE→Mobile | AI received feedback and continues |
| `mobile_feedback` | Mobile→IDE | Feedback sent from mobile |
| `status_update` | Server→Mobile | IDE status change notification |
| `cursor_message` | Server→Mobile | IDE message forwarding |
| `user_message` | Server→All | User message broadcast |

## Key Files

### `dialog-trigger.js`

Script called directly by AI. Writes `dialog_request_*.json` and polls for `dialog_response_*.json`.

Usage (auto-configured in `.cursorrules`):

```bash
node ~/.ranjin-mode/dialog-trigger.js "cursor" "projectID" "AI summary of why it wants to end"
```

### Rule Files

The extension auto-generates rule files in each project root:

- **Cursor** → `.cursorrules`
- **Windsurf** → `.windsurfrules`

These rule files instruct AI to call `dialog-trigger.js` when completing tasks, enabling popup interception.

### Data Directory

All runtime data is stored in `~/.ranjin-mode/`:

```
~/.ranjin-mode/
├── dialog-trigger.js           # Trigger script copy
├── dialog_request_*.json       # Request files written by AI
├── dialog_response_*.json      # Response files written by user/mobile
├── stats.json                  # Usage statistics
├── history/                    # Chat history (daily files)
├── images/                     # User-uploaded images
├── relay_config.json           # Relay server configuration
├── remote_enabled.txt          # LAN remote toggle
├── remote_port.txt             # LAN service port
└── remote_api_key.txt          # LAN API Key
```

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Shift+M` (Mac) | Manually trigger feedback dialog |
| `Ctrl+Shift+M` (Win/Linux) | Manually trigger feedback dialog |

## FAQ

### Extension installed but no 🔥 icon in sidebar?

Restart the IDE (`Cmd+Shift+P` → `Reload Window`). If still missing, check if the extension is installed: `Cmd+Shift+P` → `Extensions: Show Installed Extensions` → search `ranjin`.

### Phone can't connect via LAN?

1. Ensure phone and computer are on the same WiFi network
2. Disable computer firewall or allow the port (default 3000)
3. Confirm remote service is enabled in the sidebar (green status)

### Public relay keeps showing "Connecting..."?

1. Check if relay server is running: `curl http://server:8800/api/health`
2. Verify API Key is correct
3. Ensure URL format is `ws://server:8800` (not `http://`)
4. Check IDE output panel (`Cmd+Shift+U`) for `[Relay]` related logs

### Phone page appears completely black?

The page uses a dark theme (dark background, light text). Look for the API Key input modal in the center of the screen. If truly empty, JavaScript may have failed to load — check browser console.

### Message sent but AI doesn't respond?

1. Messages are only read when AI is in "waiting" state
2. Confirm IDE status shows ⏳ Waiting (not 🟢 Idle)
3. AI must first execute `dialog-trigger.js` and wait for feedback

### How to change API Key?

- **LAN Mode**: Edit `~/.ranjin-mode/remote_api_key.txt`, restart remote service
- **Relay Mode**: Modify `API_KEY` in relay server's `.env` file, then `pm2 restart ranjin-relay`

## Security Recommendations

1. **Change default API Key** — Don't use example API Keys in production
2. **Restrict origins** — Set `ALLOWED_ORIGINS` to specific domains in production
3. **Use HTTPS** — Configure Nginx reverse proxy + SSL for public relay servers
4. **Check logs regularly** — `pm2 logs ranjin-relay` to monitor for suspicious access

## Tech Stack

- **Extension**: VS Code Extension API, Node.js, WebSocket (`ws`)
- **Relay Server**: Node.js, Express-like HTTP, WebSocket (`ws`)
- **Mobile Frontend**: Vanilla HTML/CSS/JS, WebSocket API
- **Process Management**: PM2
- **Containerization**: Docker

## License

MIT
