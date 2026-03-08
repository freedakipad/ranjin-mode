/**
 * 燃尽模式 - 远程对话服务器
 * 
 * 允许通过手机浏览器远程继续 Cursor/Windsurf IDE 中的 AI 对话
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// 共享工具函数
const { ensureDir, readJsonFile } = require('../lib/config');

class RemoteServer {
  constructor(options = {}) {
    this.port = options.port || 3000;
    this.apiKey = options.apiKey || this._generateApiKey();
    this.ranjinDir = options.ranjinDir || path.join(os.homedir(), '.ranjin-mode');
    this.ideType = options.ideType || 'ide';
    this.projectId = options.projectId || 'default';
    this.onLog = options.onLog || console.log;
    
    this.sessionKey = `${this.ideType}_${this.projectId}`;
    this.server = null;
    this.wsClients = new Set();
    this.sessionFile = path.join(this.ranjinDir, `mobile_session_${this.sessionKey}.json`);
    this.pollInterval = null;
    this.heartbeatInterval = null;
    this.lastRequestId = null;
    this._fileWatcher = null;
    
    // 内存缓存 session（避免每次操作都读写磁盘）
    this._sessionCache = null;
    this._sessionDirty = false;
    this._sessionFlushInterval = null;
    
    // 静态文件目录
    this.staticDir = path.join(__dirname, 'static');
    
    // 稳定性配置
    this.HEARTBEAT_INTERVAL = options.heartbeatInterval || 15000;   // 15秒心跳
    this.CLIENT_TIMEOUT = options.clientTimeout || 45000;           // 45秒无响应断开
    this.MAX_HISTORY = options.maxHistory || 50;                    // 最大历史条目
    this.MAX_MESSAGE_LENGTH = options.maxMessageLength || 10000;    // 最大消息长度
    this.POLL_INTERVAL = options.pollInterval || 300;               // 回退轮询间隔
  }
  
  _generateApiKey() {
    return 'ranjin-' + crypto.randomBytes(8).toString('hex');
  }
  
  _log(message) {
    this.onLog(`[Remote] ${message}`);
  }
  
  // 获取本机 IP
  getLocalIP() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }
    return '127.0.0.1';
  }
  
  // 启动服务器
  start() {
    return new Promise((resolve, reject) => {
      try {
        this.server = http.createServer((req, res) => this._handleRequest(req, res));
        
        // WebSocket 升级
        this.server.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));
        
        this.server.listen(this.port, '0.0.0.0', () => {
          const ip = this.getLocalIP();
          this._log(`服务已启动: http://${ip}:${this.port}`);
          this._log(`API Key: ${this.apiKey}`);
          
          // 开始文件轮询
          this._startPolling();
          
          // 开始心跳检测
          this._startHeartbeat();
          
          resolve({ ip, port: this.port, apiKey: this.apiKey });
        });
        
        this.server.on('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            this._log(`端口 ${this.port} 已被占用，尝试 ${this.port + 1}`);
            this.port++;
            this.server.listen(this.port, '0.0.0.0');
          } else {
            reject(err);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }
  
  // 停止服务器
  stop() {
    // 停止文件监听
    if (this._fileWatcher) {
      this._fileWatcher.close();
      this._fileWatcher = null;
    }
    
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    // 刷新缓存的 session 到磁盘
    if (this._sessionFlushInterval) {
      clearTimeout(this._sessionFlushInterval);
      this._sessionFlushInterval = null;
    }
    if (this._sessionDirty) {
      this._flushSession();
    }
    
    this.wsClients.forEach(client => {
      try { client.socket.destroy(); } catch (e) {}
    });
    this.wsClients.clear();
    
    if (this.server) {
      this.server.close();
      this.server = null;
      this._log('服务已停止');
    }
  }
  
  // 心跳检测
  _startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      const deadClients = [];
      
      this.wsClients.forEach(client => {
        if (!client.alive) {
          // 上次心跳未响应，标记为死亡
          deadClients.push(client);
        } else {
          // 发送 ping
          client.alive = false;
          this._sendPing(client.socket);
        }
      });
      
      // 清理死亡连接
      deadClients.forEach(client => {
        this._log('心跳超时，断开连接');
        try { client.socket.destroy(); } catch (e) {}
        this.wsClients.delete(client);
      });
      
      if (deadClients.length > 0) {
        this._log(`清理 ${deadClients.length} 个超时连接，剩余: ${this.wsClients.size}`);
      }
    }, this.HEARTBEAT_INTERVAL);
  }
  
  // 发送 Ping 帧
  _sendPing(socket) {
    try {
      const frame = Buffer.alloc(2);
      frame[0] = 0x89; // Ping opcode
      frame[1] = 0;
      socket.write(frame);
    } catch (e) {
      // 发送失败，连接可能已断开
    }
  }
  
  // 处理 HTTP 请求
  _handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    
    // CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    
    // API 路由
    if (pathname.startsWith('/api/')) {
      this._handleAPI(req, res, pathname);
      return;
    }
    
    // 静态文件
    this._serveStatic(req, res, pathname);
  }
  
  // 处理 API 请求
  _handleAPI(req, res, pathname) {
    // 健康检查（无需认证）
    if (pathname === '/api/health') {
      this._json(res, {
        status: 'ok',
        timestamp: new Date().toISOString(),
        ip: this.getLocalIP(),
        port: this.port,
        clients: this.wsClients.size
      });
      return;
    }
    
    // 其他 API 需要认证
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== this.apiKey) {
      res.writeHead(401);
      this._json(res, { error: '未授权访问' });
      return;
    }
    
    if (pathname === '/api/cursor-status' && req.method === 'GET') {
      const status = this._checkIDEWaiting();
      this._json(res, {
        ...status,
        sessionKey: this.sessionKey,
        ideType: this.ideType,
        projectId: this.projectId
      });
      return;
    }
    
    if (pathname === '/api/history' && req.method === 'GET') {
      this._json(res, this._getSession());
      return;
    }
    
    if (pathname === '/api/history' && req.method === 'DELETE') {
      this._clearSession();
      this._json(res, { success: true, message: '历史已清空' });
      return;
    }
    
    if (pathname === '/api/message' && req.method === 'POST') {
      this._readBody(req, (body, err) => {
        if (err) {
          res.writeHead(413);
          this._json(res, { error: err });
          return;
        }
        try {
          const data = JSON.parse(body);
          const message = data.message?.trim();
          
          if (!message) {
            res.writeHead(400);
            this._json(res, { error: '消息不能为空' });
            return;
          }
          
          if (message.length > this.MAX_MESSAGE_LENGTH) {
            res.writeHead(400);
            this._json(res, { error: '消息过长', maxLength: this.MAX_MESSAGE_LENGTH });
            return;
          }
          
          this._log(`收到消息: ${message.substring(0, 50)}...`);
          
          // 添加到历史
          this._addToHistory('user', message);
          
          // 广播用户消息
          this._broadcast({
            type: 'user_message',
            data: { content: message, timestamp: new Date().toISOString() }
          });
          
          // 发送到 IDE
          this._sendToIDE(message);
          
          this._json(res, { success: true, message: '已发送', id: `msg_${Date.now()}` });
        } catch (e) {
          res.writeHead(400);
          this._json(res, { error: '请求格式错误' });
        }
      });
      return;
    }
    
    if (pathname === '/api/notify' && req.method === 'POST') {
      this._readBody(req, (body, err) => {
        if (err) {
          res.writeHead(413);
          this._json(res, { error: err });
          return;
        }
        try {
          const data = JSON.parse(body);
          const message = data.message;
          const waiting = data.waiting !== false;
          
          if (!message) {
            res.writeHead(400);
            this._json(res, { error: '消息不能为空' });
            return;
          }
          
          this._log(`通知: ${message.substring(0, 50)}...`);
          this._notifyClients(message, waiting);
          
          this._json(res, { success: true, clients: this.wsClients.size });
        } catch (e) {
          res.writeHead(400);
          this._json(res, { error: '请求格式错误' });
        }
      });
      return;
    }
    
    res.writeHead(404);
    this._json(res, { error: '未找到' });
  }
  
  // 服务静态文件（含路径遍历防护）
  _serveStatic(req, res, pathname) {
    if (pathname === '/') pathname = '/index.html';
    
    const filePath = path.resolve(path.join(this.staticDir, pathname));
    
    // 路径遍历防护：确保请求的文件在静态目录内
    if (!filePath.startsWith(path.resolve(this.staticDir))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    
    const ext = path.extname(filePath).toLowerCase();
    
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    };
    
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
      res.end(data);
    });
  }
  
  // 处理 WebSocket 升级
  _handleUpgrade(req, socket, _head) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    
    // 验证 API Key（从 URL 参数中获取）
    const url = new URL(req.url, `http://${req.headers.host}`);
    const wsApiKey = url.searchParams.get('apiKey');
    if (wsApiKey !== this.apiKey) {
      this._log('🚫 未授权 WebSocket 连接被拒绝');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    
    const acceptKey = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    
    const response = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '',
      ''
    ].join('\r\n');
    
    socket.write(response);
    
    const client = { socket, alive: true, lastActivity: Date.now(), buffer: Buffer.alloc(0) };
    this.wsClients.add(client);
    this._log(`WebSocket 连接 (总: ${this.wsClients.size})`);
    
    // 发送初始化数据（包含 IDE 类型信息）
    const initData = {
      ...this._getSession(),
      ideType: this.ideType,
      ideName: this._getIDEName()
    };
    this._wsSend(client, { type: 'init', data: initData });
    
    socket.on('data', (buffer) => {
      try {
        client.lastActivity = Date.now();
        
        // 合并缓冲区处理分片消息
        client.buffer = Buffer.concat([client.buffer, buffer]);
        
        // 尝试解析完整帧
        while (client.buffer.length >= 2) {
          const result = this._parseFrame(client.buffer);
          
          if (!result.complete) {
            // 帧不完整，等待更多数据
            break;
          }
          
          // 移除已处理的数据
          client.buffer = client.buffer.slice(result.consumed);
          
          if (result.opcode === 0x08) {
            // 关闭帧
            socket.destroy();
            return;
          } else if (result.opcode === 0x09) {
            // Ping，回复 Pong
            this._sendPong(socket);
          } else if (result.opcode === 0x0a) {
            // Pong，标记连接存活
            client.alive = true;
          } else if (result.data) {
            try {
              const message = JSON.parse(result.data);
              this._handleWSMessage(client, message);
            } catch (parseErr) {
              this._log(`消息解析错误: ${parseErr.message}`);
            }
          }
        }
      } catch (e) {
        this._log(`WebSocket 数据处理错误: ${e.message}`);
      }
    });
    
    socket.on('close', () => {
      this.wsClients.delete(client);
      this._log(`WebSocket 断开 (剩: ${this.wsClients.size})`);
    });
    
    socket.on('error', () => {
      this.wsClients.delete(client);
    });
  }
  
  // 解析 WebSocket 帧（支持分片）
  _parseFrame(buffer) {
    if (buffer.length < 2) {
      return { complete: false };
    }
    
    const firstByte = buffer[0];
    const opcode = firstByte & 0x0f;
    const secondByte = buffer[1];
    const isMasked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let offset = 2;
    
    if (payloadLength === 126) {
      if (buffer.length < offset + 2) return { complete: false };
      payloadLength = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (buffer.length < offset + 8) return { complete: false };
      payloadLength = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    
    const maskLength = isMasked ? 4 : 0;
    const totalLength = offset + maskLength + payloadLength;
    
    if (buffer.length < totalLength) {
      return { complete: false };
    }
    
    let mask = null;
    if (isMasked) {
      mask = buffer.slice(offset, offset + 4);
      offset += 4;
    }
    
    const data = Buffer.from(buffer.slice(offset, offset + payloadLength));
    if (mask) {
      for (let i = 0; i < data.length; i++) {
        data[i] ^= mask[i % 4];
      }
    }
    
    return { 
      complete: true, 
      opcode, 
      data: data.toString('utf8'),
      consumed: totalLength
    };
  }
  
  // 发送 WebSocket 消息
  _wsSend(client, data) {
    try {
      if (!client.socket || client.socket.destroyed) {
        return false;
      }
      
      const payload = JSON.stringify(data);
      const payloadBuffer = Buffer.from(payload, 'utf8');
      const length = payloadBuffer.length;
      
      let header;
      if (length <= 125) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = length;
      } else if (length <= 65535) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
      }
      
      client.socket.write(Buffer.concat([header, payloadBuffer]));
      return true;
    } catch (e) {
      // 发送失败
      this._log(`发送失败: ${e.message}`);
      return false;
    }
  }
  
  _sendPong(socket) {
    const frame = Buffer.alloc(2);
    frame[0] = 0x8a;
    frame[1] = 0;
    socket.write(frame);
  }
  
  // 处理 WebSocket 消息
  _handleWSMessage(client, message) {
    if (message.type === 'chat' && message.content) {
      const content = message.content.trim();
      this._log(`WS 消息: ${content.substring(0, 50)}...`);
      
      this._addToHistory('user', content);
      this._broadcast({
        type: 'user_message',
        data: { content, timestamp: new Date().toISOString() }
      });
      
      this._sendToIDE(content);
      
      // 发送确认消息给客户端
      this._broadcast({
        type: 'message_sent',
        data: { success: true, content: content.substring(0, 30), timestamp: Date.now() }
      });
    }
  }
  
  // 广播到所有客户端
  _broadcast(data) {
    const deadClients = [];
    
    this.wsClients.forEach(client => {
      if (!this._wsSend(client, data)) {
        deadClients.push(client);
      }
    });
    
    // 清理发送失败的连接
    deadClients.forEach(client => {
      this.wsClients.delete(client);
    });
  }
  
  // 通知客户端
  _notifyClients(message, waiting = true) {
    const ideName = this._getIDEName();
    this._addToHistory('assistant', `[${ideName}] ${message}`);
    
    this._broadcast({
      type: 'cursor_message',
      data: { summary: message, timestamp: Date.now(), waiting, ideType: this.ideType, ideName }
    });
    
    this._broadcast({
      type: 'status_update',
      data: { waiting, summary: message, ideType: this.ideType, ideName }
    });
  }
  
  // 检查 IDE 等待状态
  _checkIDEWaiting() {
    const requestFile = path.join(this.ranjinDir, `dialog_request_${this.sessionKey}.json`);
    const data = readJsonFile(requestFile);
    if (data?.timestamp) {
      return {
        waiting: true,
        summary: data.summary || 'AI 正在等待',
        requestId: data.requestId,
        timestamp: data.timestamp
      };
    }
    return { waiting: false };
  }
  
  // 发送消息到 IDE
  _sendToIDE(message) {
    const status = this._checkIDEWaiting();
    const responseFile = path.join(this.ranjinDir, `dialog_response_${this.sessionKey}.json`);
    
    const response = {
      action: 'continue',
      feedback: message,
      timestamp: Date.now(),
      source: 'mobile_remote',
      requestId: status.requestId,
      images: []
    };
    
    try {
      fs.writeFileSync(responseFile, JSON.stringify(response, null, 2), 'utf8');
      this._log(`已发送到 IDE: ${message.substring(0, 30)}...`);
    } catch (e) {
      this._log(`发送失败: ${e.message}`);
    }
  }
  
  // 文件监听（替代轮询，更高效）
  _startPolling() {
    const requestFile = path.join(this.ranjinDir, `dialog_request_${this.sessionKey}.json`);
    const watchDir = this.ranjinDir;
    const targetFileName = path.basename(requestFile);
    
    ensureDir(watchDir);
    
    // 处理文件变化的核心逻辑（带防抖）
    let debounceTimer = null;
    const handleFileChange = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        try {
          if (!fs.existsSync(requestFile)) {
            if (this.lastRequestId !== null) {
              this.lastRequestId = null;
              this._broadcast({
                type: 'status_update',
                data: { waiting: false, summary: '' }
              });
            }
            return;
          }
          
          const content = fs.readFileSync(requestFile, 'utf8');
          if (!content.trim()) return;
          
          const data = JSON.parse(content);
          
          if (data?.requestId && data.requestId !== this.lastRequestId) {
            this.lastRequestId = data.requestId;
            this._handleDialogRequest(data);
          }
        } catch (e) {
          if (e.code !== 'ENOENT' && e.name !== 'SyntaxError') {
            this._log(`文件监听处理错误: ${e.message}`);
          }
        }
      }, 50); // 50ms 防抖
    };
    
    // 使用 fs.watch 监听目录（比 setInterval 轮询更高效）
    try {
      this._fileWatcher = fs.watch(watchDir, (eventType, filename) => {
        if (filename === targetFileName) {
          handleFileChange();
        }
      });
      
      this._fileWatcher.on('error', (err) => {
        this._log(`fs.watch 错误，回退到轮询模式: ${err.message}`);
        this._fileWatcher = null;
        // 回退到轮询
        this._startFallbackPolling(requestFile);
      });
      
      this._log('使用 fs.watch 文件监听模式');
    } catch (e) {
      this._log(`fs.watch 不可用，使用轮询模式: ${e.message}`);
      this._startFallbackPolling(requestFile);
    }
  }
  
  // 回退轮询方案（当 fs.watch 不可用时）
  _startFallbackPolling(requestFile) {
    this._log(`回退轮询模式 (${this.POLL_INTERVAL}ms)`);
    this.pollInterval = setInterval(() => {
      try {
        if (!fs.existsSync(requestFile)) {
          if (this.lastRequestId !== null) {
            this.lastRequestId = null;
            this._broadcast({
              type: 'status_update',
              data: { waiting: false, summary: '' }
            });
          }
          return;
        }
        
        const content = fs.readFileSync(requestFile, 'utf8');
        if (!content.trim()) return;
        
        const data = JSON.parse(content);
        
        if (data?.requestId && data.requestId !== this.lastRequestId) {
          this.lastRequestId = data.requestId;
          this._handleDialogRequest(data);
        }
      } catch (e) {
        if (e.code !== 'ENOENT' && e.name !== 'SyntaxError') {
          this._log(`轮询错误: ${e.message}`);
        }
      }
    }, this.POLL_INTERVAL);
  }
  
  // 处理弹窗请求
  _handleDialogRequest(request) {
    if (!request?.summary) return;
    
    const ideName = this._getIDEName();
    this._log(`IDE 消息: ${request.summary.substring(0, 50)}...`);
    this._addToHistory('assistant', `[${ideName}] ${request.summary}`);
    
    this._broadcast({
      type: 'cursor_message',
      data: {
        summary: request.summary,
        timestamp: request.timestamp,
        requestId: request.requestId,
        waiting: true,
        ideType: this.ideType,
        ideName
      }
    });
    
    this._broadcast({
      type: 'status_update',
      data: { waiting: true, summary: request.summary, ideType: this.ideType, ideName }
    });
  }
  
  // 会话管理（内存缓存 + 延迟写入）
  _getSession() {
    if (this._sessionCache) return this._sessionCache;
    
    try {
      if (fs.existsSync(this.sessionFile)) {
        this._sessionCache = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
        return this._sessionCache;
      }
    } catch (e) {}
    
    return this._createSession();
  }
  
  _createSession() {
    const session = {
      session_id: `session_${Date.now()}`,
      created_at: new Date().toISOString(),
      history: []
    };
    this._sessionCache = session;
    this._flushSession();
    return session;
  }
  
  _flushSession() {
    try {
      if (!this._sessionCache) return;
      ensureDir(this.ranjinDir);
      fs.writeFileSync(this.sessionFile, JSON.stringify(this._sessionCache, null, 2), 'utf8');
      this._sessionDirty = false;
    } catch (e) {}
  }
  
  _markSessionDirty() {
    this._sessionDirty = true;
    // 延迟 2 秒批量写入，避免频繁磁盘 I/O
    if (!this._sessionFlushInterval) {
      this._sessionFlushInterval = setTimeout(() => {
        this._sessionFlushInterval = null;
        if (this._sessionDirty) {
          this._flushSession();
        }
      }, 2000);
    }
  }
  
  _clearSession() {
    this._sessionCache = null;
    this._createSession();
  }
  
  _addToHistory(role, content) {
    const session = this._getSession();
    session.history.push({
      role,
      content,
      timestamp: new Date().toISOString()
    });
    
    if (session.history.length > this.MAX_HISTORY) {
      session.history = session.history.slice(-this.MAX_HISTORY);
    }
    
    this._markSessionDirty();
  }
  
  // 获取 IDE 显示名称
  _getIDEName() {
    const names = {
      'cursor': 'Cursor',
      'windsurf': 'Windsurf',
      'vscode': 'VS Code',
      'ide': 'IDE'
    };
    return names[this.ideType] || 'IDE';
  }
  
  // 工具函数
  _json(res, data) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  }
  
  _readBody(req, callback) {
    const MAX_BODY_SIZE = 1024 * 1024; // 1MB 限制
    let body = '';
    let size = 0;
    let aborted = false;
    
    req.on('data', chunk => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        aborted = true;
        callback(null, '请求体过大（超过 1MB）');
        return;
      }
      body += chunk;
    });
    
    req.on('end', () => {
      if (!aborted) callback(body, null);
    });
  }
}

module.exports = RemoteServer;
