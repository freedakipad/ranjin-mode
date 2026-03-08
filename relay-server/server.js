#!/usr/bin/env node
/**
 * 燃尽模式 - 中继服务器 (Relay Server)
 * 
 * 部署在公网 VPS 上，在 IDE 扩展和手机端之间中继消息。
 * 
 * 架构：
 *   [IDE Extension] --WebSocket--> [Relay Server] <--WebSocket-- [Mobile Browser]
 * 
 * 连接类型：
 *   - IDE 客户端: type=ide, 通过 WebSocket 连接，转发 dialog 请求/响应
 *   - Mobile 客户端: type=mobile, 通过 WebSocket 连接或 HTTP API，发送反馈指令
 * 
 * 部署方式：
 *   1. VPS: node server.js
 *   2. Docker: docker build -t relay && docker run -p 8800:8800 relay
 *   3. PM2: pm2 start server.js --name relay
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

// 加载环境变量
try { require('dotenv').config(); } catch (e) { /* dotenv 可选 */ }

// ============================================
// 配置
// ============================================
const CONFIG = {
  PORT: parseInt(process.env.PORT, 10) || 8800,
  API_KEY: process.env.API_KEY || 'ranjin-relay-' + crypto.randomBytes(4).toString('hex'),
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()),
  MAX_HISTORY: parseInt(process.env.MAX_HISTORY, 10) || 100,
  MAX_MESSAGE_LENGTH: parseInt(process.env.MAX_MESSAGE_LENGTH, 10) || 4000,
  HEARTBEAT_INTERVAL: parseInt(process.env.HEARTBEAT_INTERVAL, 10) || 30000,
  CLIENT_TIMEOUT: parseInt(process.env.CLIENT_TIMEOUT, 10) || 90000
};

// ============================================
// 会话存储（内存）
// ============================================
class SessionStore {
  constructor(maxHistory) {
    this.sessions = new Map(); // sessionKey -> session
    this.maxHistory = maxHistory;
  }

  get(sessionKey) {
    if (!this.sessions.has(sessionKey)) {
      this.sessions.set(sessionKey, {
        sessionId: `session_${Date.now()}`,
        createdAt: new Date().toISOString(),
        history: [],
        ideWaiting: false,
        ideSummary: '',
        ideType: 'ide',
        ideName: 'IDE',
        requestId: null
      });
    }
    return this.sessions.get(sessionKey);
  }

  addHistory(sessionKey, role, content) {
    const session = this.get(sessionKey);
    session.history.push({
      role,
      content,
      timestamp: new Date().toISOString()
    });
    if (session.history.length > this.maxHistory) {
      session.history = session.history.slice(-this.maxHistory);
    }
    session.lastActivity = new Date().toISOString();
    return session;
  }

  clearHistory(sessionKey) {
    const session = this.get(sessionKey);
    session.history = [];
    session.sessionId = `session_${Date.now()}`;
    session.createdAt = new Date().toISOString();
    return session;
  }

  setIDEWaiting(sessionKey, waiting, summary, requestId, ideType, ideName) {
    const session = this.get(sessionKey);
    session.ideWaiting = waiting;
    session.ideSummary = summary || '';
    session.requestId = requestId || null;
    if (ideType) session.ideType = ideType;
    if (ideName) session.ideName = ideName;
    return session;
  }
}

// ============================================
// 客户端管理
// ============================================
class ClientManager {
  constructor() {
    this.clients = new Map(); // ws -> clientInfo
  }

  add(ws, type, sessionKey, info = {}) {
    this.clients.set(ws, {
      type,           // 'ide' 或 'mobile'
      sessionKey,
      alive: true,
      lastActivity: Date.now(),
      ...info
    });
  }

  remove(ws) {
    this.clients.delete(ws);
  }

  get(ws) {
    return this.clients.get(ws);
  }

  // 获取指定 session 的所有 IDE 客户端
  getIDEClients(sessionKey) {
    const result = [];
    this.clients.forEach((info, ws) => {
      if (info.type === 'ide' && info.sessionKey === sessionKey && ws.readyState === WebSocket.OPEN) {
        result.push({ ws, info });
      }
    });
    return result;
  }

  // 获取指定 session 的所有 Mobile 客户端
  getMobileClients(sessionKey) {
    const result = [];
    this.clients.forEach((info, ws) => {
      if (info.type === 'mobile' && info.sessionKey === sessionKey && ws.readyState === WebSocket.OPEN) {
        result.push({ ws, info });
      }
    });
    return result;
  }

  // 获取指定 session 的所有客户端
  getAllClients(sessionKey) {
    const result = [];
    this.clients.forEach((info, ws) => {
      if (info.sessionKey === sessionKey && ws.readyState === WebSocket.OPEN) {
        result.push({ ws, info });
      }
    });
    return result;
  }

  // 所有客户端
  getAll() {
    return this.clients;
  }
}

// ============================================
// 中继服务器
// ============================================
const store = new SessionStore(CONFIG.MAX_HISTORY);
const clientMgr = new ClientManager();
const staticDir = path.join(__dirname, 'static');

// HTTP 服务器
const server = http.createServer((req, res) => handleHTTP(req, res));

// WebSocket 服务器
const wss = new WebSocketServer({ server });

// ============================================
// HTTP 请求处理
// ============================================
function handleHTTP(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS
  const origin = req.headers.origin || '*';
  if (CONFIG.ALLOWED_ORIGINS.includes('*') || CONFIG.ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-Session-Key, X-Client-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API 路由
  if (pathname.startsWith('/api/')) {
    handleAPI(req, res, pathname, url);
    return;
  }

  // 静态文件
  serveStatic(req, res, pathname);
}

function handleAPI(req, res, pathname, url) {
  // 健康检查（无需认证）
  if (pathname === '/api/health') {
    json(res, {
      status: 'ok',
      timestamp: new Date().toISOString(),
      sessions: store.sessions.size,
      clients: clientMgr.getAll().size,
      version: '1.0.0'
    });
    return;
  }

  // 认证
  const apiKey = req.headers['x-api-key'] || url.searchParams.get('apiKey');
  if (apiKey !== CONFIG.API_KEY) {
    json(res, { error: '未授权访问' }, 401);
    return;
  }

  const sessionKey = req.headers['x-session-key'] || url.searchParams.get('sessionKey') || 'default';

  // 列出活跃会话
  if (pathname === '/api/sessions' && req.method === 'GET') {
    const sessions = [];
    store.sessions.forEach((session, key) => {
      const ideClients = clientMgr.getIDEClients(key);
      sessions.push({
        sessionKey: key,
        ideType: session.ideType || 'unknown',
        ideName: session.ideName || 'IDE',
        ideConnected: ideClients.length > 0,
        ideWaiting: session.ideWaiting,
        ideSummary: session.ideSummary || '',
        historyCount: session.history.length,
        lastActivity: session.lastActivity || session.createdAt
      });
    });
    // 优先显示有 IDE 连接的会话
    sessions.sort((a, b) => (b.ideConnected ? 1 : 0) - (a.ideConnected ? 1 : 0));
    json(res, { sessions });
    return;
  }

  // IDE 状态查询
  if (pathname === '/api/cursor-status' && req.method === 'GET') {
    const session = store.get(sessionKey);
    json(res, {
      waiting: session.ideWaiting,
      summary: session.ideSummary,
      requestId: session.requestId,
      sessionKey,
      ideType: session.ideType,
      ideName: session.ideName,
      projectId: sessionKey.split('_').slice(1).join('_') || 'default'
    });
    return;
  }

  // 会话历史
  if (pathname === '/api/history' && req.method === 'GET') {
    const session = store.get(sessionKey);
    json(res, {
      session_id: session.sessionId,
      created_at: session.createdAt,
      history: session.history
    });
    return;
  }

  if (pathname === '/api/history' && req.method === 'DELETE') {
    store.clearHistory(sessionKey);
    json(res, { success: true, message: '历史已清空' });
    return;
  }

  // 发送消息（手机 -> IDE）
  if (pathname === '/api/message' && req.method === 'POST') {
    readBody(req, (body, err) => {
      if (err) {
        json(res, { error: err }, 413);
        return;
      }
      try {
        const data = JSON.parse(body);
        const message = data.message?.trim();

        if (!message) {
          json(res, { error: '消息不能为空' }, 400);
          return;
        }

        if (message.length > CONFIG.MAX_MESSAGE_LENGTH) {
          json(res, { error: '消息过长', maxLength: CONFIG.MAX_MESSAGE_LENGTH }, 400);
          return;
        }

        log(`[${sessionKey}] 手机消息: ${message.substring(0, 50)}...`);

        // 添加到历史
        store.addHistory(sessionKey, 'user', message);

        // 广播用户消息给所有客户端
        broadcastToSession(sessionKey, {
          type: 'user_message',
          data: { content: message, timestamp: new Date().toISOString() }
        });

        // 转发给 IDE 客户端
        const ideClients = clientMgr.getIDEClients(sessionKey);
        ideClients.forEach(({ ws }) => {
          wsSend(ws, {
            type: 'mobile_feedback',
            data: {
              action: 'continue',
              feedback: message,
              timestamp: Date.now(),
              source: 'mobile_remote',
              requestId: store.get(sessionKey).requestId,
              images: []
            }
          });
        });

        // 确认
        broadcastToSession(sessionKey, {
          type: 'message_sent',
          data: { success: true, content: message.substring(0, 30), timestamp: Date.now() }
        });

        json(res, {
          success: true,
          message: ideClients.length > 0 ? '已转发到 IDE' : '消息已保存，等待 IDE 连接',
          ideConnected: ideClients.length > 0,
          id: `msg_${Date.now()}`
        });
      } catch (e) {
        json(res, { error: '请求格式错误' }, 400);
      }
    });
    return;
  }

  // IDE 通知（IDE -> 手机）
  if (pathname === '/api/notify' && req.method === 'POST') {
    readBody(req, (body, err) => {
      if (err) {
        json(res, { error: err }, 413);
        return;
      }
      try {
        const data = JSON.parse(body);
        const message = data.message;
        const waiting = data.waiting !== false;

        if (!message) {
          json(res, { error: '消息不能为空' }, 400);
          return;
        }

        log(`[${sessionKey}] IDE 通知: ${message.substring(0, 50)}...`);

        const session = store.get(sessionKey);
        if (data.context?.ide) {
          session.ideType = data.context.ide;
          session.ideName = getIDEName(data.context.ide);
        }

        store.addHistory(sessionKey, 'assistant', `[${session.ideName}] ${message}`);
        store.setIDEWaiting(sessionKey, waiting, message, data.context?.requestId, session.ideType, session.ideName);

        // 广播给手机端
        broadcastToMobile(sessionKey, {
          type: 'cursor_message',
          data: {
            summary: message,
            timestamp: Date.now(),
            waiting,
            ideType: session.ideType,
            ideName: session.ideName
          }
        });

        broadcastToMobile(sessionKey, {
          type: 'status_update',
          data: { waiting, summary: message, ideType: session.ideType, ideName: session.ideName }
        });

        const mobileCount = clientMgr.getMobileClients(sessionKey).length;
        json(res, { success: true, clients: mobileCount });
      } catch (e) {
        json(res, { error: '请求格式错误' }, 400);
      }
    });
    return;
  }

  json(res, { error: '未找到' }, 404);
}

// 服务静态文件
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.resolve(path.join(staticDir, pathname));

  // 路径遍历防护
  if (!filePath.startsWith(path.resolve(staticDir))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
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

// ============================================
// WebSocket 处理
// ============================================
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const apiKey = url.searchParams.get('apiKey');
  const clientType = url.searchParams.get('type') || 'mobile'; // 'ide' or 'mobile'
  const sessionKey = url.searchParams.get('sessionKey') || 'default';

  // 认证
  if (apiKey !== CONFIG.API_KEY) {
    log(`🚫 未授权 WebSocket 连接被拒绝 (type=${clientType})`);
    ws.close(4001, 'Unauthorized');
    return;
  }

  const clientIP = req.socket.remoteAddress;
  log(`✅ ${clientType.toUpperCase()} 连接: ${clientIP} [${sessionKey}]`);

  // 注册客户端
  clientMgr.add(ws, clientType, sessionKey, { ip: clientIP });

  // 发送初始化数据
  const session = store.get(sessionKey);
  wsSend(ws, {
    type: 'init',
    data: {
      session_id: session.sessionId,
      created_at: session.createdAt,
      history: session.history,
      ideType: session.ideType,
      ideName: session.ideName,
      ideWaiting: session.ideWaiting,
      ideSummary: session.ideSummary
    }
  });

  // 通知对端有新连接
  if (clientType === 'ide') {
    broadcastToMobile(sessionKey, {
      type: 'status_update',
      data: {
        waiting: session.ideWaiting,
        summary: session.ideSummary,
        ideType: session.ideType,
        ideName: session.ideName,
        ideConnected: true
      }
    });
  }

  // 消息处理
  ws.on('message', (rawData) => {
    try {
      const client = clientMgr.get(ws);
      if (client) client.lastActivity = Date.now();

      const message = JSON.parse(rawData.toString());
      handleWSMessage(ws, message, clientType, sessionKey);
    } catch (e) {
      log(`消息解析错误: ${e.message}`);
    }
  });

  ws.on('close', () => {
    const client = clientMgr.get(ws);
    log(`${clientType.toUpperCase()} 断开: ${clientIP} [${sessionKey}]`);
    clientMgr.remove(ws);

    // 通知对端连接断开
    if (clientType === 'ide') {
      broadcastToMobile(sessionKey, {
        type: 'status_update',
        data: {
          waiting: false,
          summary: 'IDE 已断开连接',
          ideConnected: false
        }
      });
    }
  });

  ws.on('error', (err) => {
    log(`WebSocket 错误 (${clientType}): ${err.message}`);
    clientMgr.remove(ws);
  });

  // 心跳 pong
  ws.on('pong', () => {
    const client = clientMgr.get(ws);
    if (client) client.alive = true;
  });
});

function handleWSMessage(ws, message, clientType, sessionKey) {
  const session = store.get(sessionKey);

  if (clientType === 'mobile') {
    // 手机端发送聊天消息
    if (message.type === 'chat' && message.content) {
      const content = message.content.trim();
      if (!content || content.length > CONFIG.MAX_MESSAGE_LENGTH) return;

      log(`[${sessionKey}] 手机 WS 消息: ${content.substring(0, 50)}...`);

      store.addHistory(sessionKey, 'user', content);

      // 广播给所有客户端
      broadcastToSession(sessionKey, {
        type: 'user_message',
        data: { content, timestamp: new Date().toISOString() }
      }, ws); // 排除发送者

      // 转发给 IDE
      const ideClients = clientMgr.getIDEClients(sessionKey);
      ideClients.forEach(({ ws: ideWs }) => {
        wsSend(ideWs, {
          type: 'mobile_feedback',
          data: {
            action: 'continue',
            feedback: content,
            timestamp: Date.now(),
            source: 'mobile_remote',
            requestId: session.requestId,
            images: []
          }
        });
      });

      // 发送确认
      broadcastToSession(sessionKey, {
        type: 'message_sent',
        data: { success: true, content: content.substring(0, 30), timestamp: Date.now() }
      });
    }
  } else if (clientType === 'ide') {
    // IDE 发送 dialog 请求（AI 等待用户输入）
    if (message.type === 'dialog_request') {
      const data = message.data || {};
      log(`[${sessionKey}] IDE dialog_request: ${(data.summary || '').substring(0, 50)}...`);

      store.setIDEWaiting(sessionKey, true, data.summary, data.requestId, data.ideType, data.ideName);
      store.addHistory(sessionKey, 'assistant', `[${session.ideName}] ${data.summary}`);

      // 通知手机端
      broadcastToMobile(sessionKey, {
        type: 'cursor_message',
        data: {
          summary: data.summary,
          timestamp: data.timestamp || Date.now(),
          requestId: data.requestId,
          waiting: true,
          ideType: session.ideType,
          ideName: session.ideName
        }
      });

      broadcastToMobile(sessionKey, {
        type: 'status_update',
        data: {
          waiting: true,
          summary: data.summary,
          ideType: session.ideType,
          ideName: session.ideName,
          ideConnected: true
        }
      });
    }

    // IDE 通知对话已结束（AI 收到反馈并继续）
    if (message.type === 'dialog_resolved') {
      log(`[${sessionKey}] IDE dialog_resolved`);
      store.setIDEWaiting(sessionKey, false, '', null);

      broadcastToMobile(sessionKey, {
        type: 'status_update',
        data: {
          waiting: false,
          summary: '',
          ideType: session.ideType,
          ideName: session.ideName,
          ideConnected: true
        }
      });
    }

    // IDE 发送 IDE 信息更新
    if (message.type === 'ide_info') {
      const data = message.data || {};
      session.ideType = data.ideType || session.ideType;
      session.ideName = data.ideName || getIDEName(session.ideType);

      broadcastToMobile(sessionKey, {
        type: 'ide_info',
        data: {
          ideType: session.ideType,
          ideName: session.ideName,
          ideConnected: true
        }
      });
    }
  }
}

// ============================================
// 广播工具
// ============================================
function broadcastToSession(sessionKey, data, excludeWs = null) {
  clientMgr.getAllClients(sessionKey).forEach(({ ws }) => {
    if (ws !== excludeWs) wsSend(ws, data);
  });
}

function broadcastToMobile(sessionKey, data) {
  clientMgr.getMobileClients(sessionKey).forEach(({ ws }) => {
    wsSend(ws, data);
  });
}

function broadcastToIDE(sessionKey, data) {
  clientMgr.getIDEClients(sessionKey).forEach(({ ws }) => {
    wsSend(ws, data);
  });
}

function wsSend(ws, data) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
      return true;
    }
  } catch (e) {
    log(`发送失败: ${e.message}`);
  }
  return false;
}

// ============================================
// 心跳检测
// ============================================
const heartbeatInterval = setInterval(() => {
  clientMgr.getAll().forEach((info, ws) => {
    if (!info.alive) {
      log(`心跳超时，断开: ${info.type} [${info.sessionKey}]`);
      ws.terminate();
      clientMgr.remove(ws);
      return;
    }
    info.alive = false;
    ws.ping();
  });
}, CONFIG.HEARTBEAT_INTERVAL);

// ============================================
// 工具函数
// ============================================
function json(res, data, statusCode = 200) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req, callback) {
  const MAX_BODY = 1024 * 1024;
  let body = '';
  let size = 0;
  let aborted = false;

  req.on('data', chunk => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BODY) {
      aborted = true;
      callback(null, '请求体过大');
      return;
    }
    body += chunk;
  });

  req.on('end', () => {
    if (!aborted) callback(body, null);
  });
}

function getIDEName(ideType) {
  const names = {
    'cursor': 'Cursor',
    'windsurf': 'Windsurf',
    'vscode': 'VS Code',
    'ide': 'IDE'
  };
  return names[ideType] || 'IDE';
}

function log(message) {
  const time = new Date().toLocaleTimeString('zh-CN');
  console.log(`[${time}] ${message}`);
}

// ============================================
// 启动
// ============================================
server.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log('');
  console.log('🚀 燃尽模式中继服务器已启动');
  console.log('─'.repeat(50));
  console.log(`  地址:     http://0.0.0.0:${CONFIG.PORT}`);
  console.log(`  API Key:  ${CONFIG.API_KEY}`);
  console.log(`  心跳:     ${CONFIG.HEARTBEAT_INTERVAL / 1000}s`);
  console.log(`  超时:     ${CONFIG.CLIENT_TIMEOUT / 1000}s`);
  console.log('─'.repeat(50));
  console.log('  WebSocket 连接参数:');
  console.log(`    IDE:    ws://host:${CONFIG.PORT}?apiKey=KEY&type=ide&sessionKey=SESSION`);
  console.log(`    Mobile: ws://host:${CONFIG.PORT}?apiKey=KEY&type=mobile&sessionKey=SESSION`);
  console.log('');
});

// 优雅关闭
function shutdown() {
  console.log('\n正在关闭...');
  clearInterval(heartbeatInterval);

  clientMgr.getAll().forEach((info, ws) => {
    try { ws.close(1001, 'Server shutting down'); } catch (e) {}
  });

  wss.close(() => {
    server.close(() => {
      console.log('服务器已关闭');
      process.exit(0);
    });
  });

  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
