/**
 * 燃尽模式 - 远程服务管理模块
 * 
 * 支持两种模式：
 * 1. 局域网模式（local）：在本机启动 HTTP + WebSocket 服务器
 * 2. 中继模式（relay）：连接到公网 Relay Server 作为 WebSocket 客户端
 */

const fs = require('fs');
const path = require('path');
const { CONFIG, RANJIN_DIR, ensureDir, readTextFile, writeTextFile } = require('./config');
const RemoteServer = require('../remote/server');

class RemoteManager {
  /**
   * @param {object} options
   * @param {string} options.ideType - IDE 类型
   * @param {string} options.projectId - 项目 ID
   * @param {string} options.sessionKey - 会话标识
   * @param {import('vscode').OutputChannel} options.output - 输出通道
   */
  constructor(options) {
    this._ideType = options.ideType;
    this._projectId = options.projectId;
    this._sessionKey = options.sessionKey;
    this._output = options.output;
    
    // 局域网模式
    this._server = null;
    this._enabled = this._loadEnabled();
    
    // 中继模式
    this._relayWs = null;
    this._relayEnabled = false;
    this._relayUrl = '';
    this._relayApiKey = '';
    this._relayReconnectTimer = null;
    this._relayReconnectAttempts = 0;
    this._relayMaxReconnect = 10;
    this._relayBaseDelay = 2000;
    
    // 加载中继配置
    this._loadRelayConfig();
    
    // 连接信息
    this._apiKey = '';
    this._port = CONFIG.DEFAULT_REMOTE_PORT;
    this._ip = '';
  }
  
  /** 远程服务是否启用 */
  get enabled() {
    return this._enabled;
  }
  
  /** 远程服务是否正在运行 */
  get running() {
    return !!this._server || this._relayConnected;
  }
  
  /** 中继是否已连接 */
  get _relayConnected() {
    return this._relayWs && this._relayWs.readyState === 1; // WebSocket.OPEN
  }
  
  /** API Key */
  get apiKey() {
    return this._apiKey;
  }
  
  /** 端口 */
  get port() {
    return this._port;
  }
  
  /** IP 地址 */
  get ip() {
    return this._ip;
  }
  
  /** 中继模式状态 */
  get relayEnabled() {
    return this._relayEnabled;
  }
  
  get relayConnected() {
    return this._relayConnected;
  }
  
  get relayUrl() {
    return this._relayUrl;
  }
  
  // ==================== 配置加载 ====================
  
  /** 加载远程服务开关状态 */
  _loadEnabled() {
    const enabledFile = path.join(RANJIN_DIR, 'remote_enabled.txt');
    const value = readTextFile(enabledFile, '1');
    return value === '1';
  }
  
  /** 加载远程端口 */
  _loadPort() {
    const portFile = path.join(RANJIN_DIR, 'remote_port.txt');
    const value = readTextFile(portFile, String(CONFIG.DEFAULT_REMOTE_PORT));
    return parseInt(value, 10) || CONFIG.DEFAULT_REMOTE_PORT;
  }
  
  /** 加载中继配置 */
  _loadRelayConfig() {
    try {
      const configFile = path.join(RANJIN_DIR, 'relay_config.json');
      if (fs.existsSync(configFile)) {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        this._relayEnabled = !!config.enabled;
        this._relayUrl = config.url || '';
        this._relayApiKey = config.apiKey || '';
      }
    } catch (e) {
      // 配置不存在或解析失败
    }
  }
  
  /** 保存中继配置 */
  _saveRelayConfig() {
    try {
      ensureDir(RANJIN_DIR);
      const configFile = path.join(RANJIN_DIR, 'relay_config.json');
      fs.writeFileSync(configFile, JSON.stringify({
        enabled: this._relayEnabled,
        url: this._relayUrl,
        apiKey: this._relayApiKey
      }, null, 2), 'utf8');
    } catch (e) {
      this._output.appendLine(`[中继] ⚠️ 保存配置失败: ${e.message}`);
    }
  }
  
  // ==================== 局域网模式 ====================
  
  /**
   * 启动局域网远程服务器
   */
  async start() {
    if (this._server) return; // 已运行
    
    try {
      const port = this._loadPort();
      
      // 确保 remote_enabled.txt 存在
      ensureDir(RANJIN_DIR);
      writeTextFile(path.join(RANJIN_DIR, 'remote_enabled.txt'), '1');
      
      this._server = new RemoteServer({
        port: port,
        ranjinDir: RANJIN_DIR,
        ideType: this._ideType,
        projectId: this._projectId,
        onLog: (msg) => this._output.appendLine(msg)
      });
      
      const info = await this._server.start();
      
      this._output.appendLine('[远程] ✅ 局域网服务已启动');
      this._output.appendLine(`[远程] 📱 手机访问: http://${info.ip}:${info.port}`);
      this._output.appendLine(`[远程] 🔑 API Key: ${info.apiKey}`);
      
      this._apiKey = info.apiKey;
      this._port = info.port;
      this._ip = info.ip;
      
      // 保存 API Key 和端口到文件
      this._saveApiKey(info.apiKey);
      writeTextFile(path.join(RANJIN_DIR, 'remote_port.txt'), String(info.port));
      
    } catch (e) {
      this._output.appendLine(`[远程] ❌ 启动失败: ${e.message}`);
    }
  }
  
  /**
   * 停止局域网远程服务器
   */
  stop() {
    if (this._server) {
      this._server.stop();
      this._server = null;
      this._output.appendLine('[远程] 局域网服务已停止');
    }
  }
  
  /**
   * 切换局域网远程服务开关
   * @param {boolean} enabled
   */
  async toggle(enabled) {
    ensureDir(RANJIN_DIR);
    writeTextFile(path.join(RANJIN_DIR, 'remote_enabled.txt'), enabled ? '1' : '0');
    this._enabled = enabled;
    
    if (enabled) {
      await this.start();
    } else {
      this.stop();
    }
  }
  
  // ==================== 中继模式 ====================
  
  /**
   * 配置并启动中继连接
   * @param {object} config
   * @param {string} config.url - 中继服务器地址，如 ws://your-server:8800 或 wss://your-server
   * @param {string} config.apiKey - 中继服务器 API Key
   */
  async startRelay(config) {
    // 保存配置
    this._relayUrl = config.url;
    this._relayApiKey = config.apiKey;
    this._relayEnabled = true;
    this._saveRelayConfig();
    
    // 连接
    this._connectRelay();
  }
  
  /**
   * 停止中继连接
   */
  stopRelay() {
    this._relayEnabled = false;
    this._saveRelayConfig();
    this._disconnectRelay();
    this._output.appendLine('[中继] 已断开');
  }
  
  /**
   * 连接到中继服务器
   */
  _connectRelay() {
    if (this._relayWs) {
      try { this._relayWs.close(); } catch (e) {}
      this._relayWs = null;
    }
    
    if (!this._relayUrl || !this._relayApiKey) {
      this._output.appendLine('[中继] ⚠️ 缺少 URL 或 API Key');
      return;
    }
    
    try {
      // 动态加载 ws 模块
      const WebSocket = require('ws');
      
      // 构造连接 URL
      const separator = this._relayUrl.includes('?') ? '&' : '?';
      const wsUrl = `${this._relayUrl}${separator}apiKey=${encodeURIComponent(this._relayApiKey)}&type=ide&sessionKey=${encodeURIComponent(this._sessionKey)}`;
      
      this._output.appendLine(`[中继] 正在连接: ${this._relayUrl}`);
      
      this._relayWs = new WebSocket(wsUrl);
      
      this._relayWs.on('open', () => {
        this._output.appendLine('[中继] ✅ 已连接到中继服务器');
        this._relayReconnectAttempts = 0;
        
        // 发送 IDE 信息
        this._relaySend({
          type: 'ide_info',
          data: {
            ideType: this._ideType,
            ideName: this._getIDEName(),
            projectId: this._projectId,
            sessionKey: this._sessionKey
          }
        });
      });
      
      this._relayWs.on('message', (rawData) => {
        try {
          const message = JSON.parse(rawData.toString());
          this._handleRelayMessage(message);
        } catch (e) {
          this._output.appendLine(`[中继] 消息解析错误: ${e.message}`);
        }
      });
      
      this._relayWs.on('close', (code, reason) => {
        this._output.appendLine(`[中继] 连接关闭 (${code}): ${reason || '未知原因'}`);
        this._relayWs = null;
        
        if (this._relayEnabled) {
          this._scheduleReconnect();
        }
      });
      
      this._relayWs.on('error', (err) => {
        this._output.appendLine(`[中继] ❌ 连接错误: ${err.message}`);
      });
      
      // 响应 ping
      this._relayWs.on('ping', () => {
        try { this._relayWs.pong(); } catch (e) {}
      });
      
    } catch (e) {
      this._output.appendLine(`[中继] ❌ 连接失败: ${e.message}`);
      if (this._relayEnabled) {
        this._scheduleReconnect();
      }
    }
  }
  
  /**
   * 断开中继连接
   */
  _disconnectRelay() {
    if (this._relayReconnectTimer) {
      clearTimeout(this._relayReconnectTimer);
      this._relayReconnectTimer = null;
    }
    this._relayReconnectAttempts = 0;
    
    if (this._relayWs) {
      try { this._relayWs.close(1000, 'Client closing'); } catch (e) {}
      this._relayWs = null;
    }
  }
  
  /**
   * 指数退避重连
   */
  _scheduleReconnect() {
    if (this._relayReconnectAttempts >= this._relayMaxReconnect) {
      this._output.appendLine('[中继] ❌ 达到最大重连次数，停止重连');
      return;
    }
    
    const delay = Math.min(
      this._relayBaseDelay * Math.pow(1.5, this._relayReconnectAttempts),
      60000
    );
    this._relayReconnectAttempts++;
    
    this._output.appendLine(`[中继] 将在 ${(delay / 1000).toFixed(1)}s 后重连 (第 ${this._relayReconnectAttempts} 次)`);
    
    this._relayReconnectTimer = setTimeout(() => {
      this._relayReconnectTimer = null;
      if (this._relayEnabled) {
        this._connectRelay();
      }
    }, delay);
  }
  
  /**
   * 处理中继服务器消息
   * @param {object} message
   */
  _handleRelayMessage(message) {
    if (message.type === 'mobile_feedback') {
      // 手机端通过中继发送了反馈
      const data = message.data || {};
      this._output.appendLine(`[中继] 📱 收到手机反馈: ${(data.feedback || '').substring(0, 50)}...`);
      
      // 写入 dialog_response 文件，让 dialog-trigger.js 和 DialogManager 能读取
      const responseFile = path.join(RANJIN_DIR, `dialog_response_${this._sessionKey}.json`);
      const responseData = {
        action: data.action || 'continue',
        feedback: data.feedback || '',
        timestamp: data.timestamp || Date.now(),
        source: 'mobile_remote',
        requestId: data.requestId || null,
        images: data.images || []
      };
      
      try {
        fs.writeFileSync(responseFile, JSON.stringify(responseData, null, 2), 'utf8');
        this._output.appendLine('[中继] ✅ 已写入响应文件');
      } catch (e) {
        this._output.appendLine(`[中继] ❌ 写入响应文件失败: ${e.message}`);
      }
    }
    
    if (message.type === 'init') {
      this._output.appendLine(`[中继] 会话初始化，历史记录 ${(message.data?.history || []).length} 条`);
    }
  }
  
  /**
   * 发送消息到中继服务器
   * @param {object} data
   * @returns {boolean}
   */
  _relaySend(data) {
    if (!this._relayConnected) return false;
    try {
      this._relayWs.send(JSON.stringify(data));
      return true;
    } catch (e) {
      this._output.appendLine(`[中继] 发送失败: ${e.message}`);
      return false;
    }
  }
  
  /**
   * 通过中继通知手机端（IDE 等待用户输入）
   * @param {string} summary - AI 摘要
   * @param {string} requestId - 请求 ID
   */
  relayNotifyWaiting(summary, requestId) {
    this._relaySend({
      type: 'dialog_request',
      data: {
        summary,
        requestId,
        timestamp: Date.now(),
        ideType: this._ideType,
        ideName: this._getIDEName()
      }
    });
  }
  
  /**
   * 通过中继通知手机端对话已结束
   */
  relayNotifyResolved() {
    this._relaySend({
      type: 'dialog_resolved',
      data: { timestamp: Date.now() }
    });
  }
  
  // ==================== 通用接口 ====================
  
  /**
   * 通知手机端客户端（同时支持局域网和中继模式）
   * @param {string} message - 消息内容
   * @param {boolean} waiting - 是否等待状态
   */
  notifyClients(message, waiting = true) {
    // 局域网模式
    if (this._server) {
      this._server._notifyClients(message, waiting);
    }
    
    // 中继模式
    if (this._relayConnected) {
      if (waiting) {
        this.relayNotifyWaiting(message, null);
      } else {
        this.relayNotifyResolved();
      }
    }
  }
  
  /**
   * 获取远程状态信息
   * @returns {object}
   */
  getStatus() {
    return {
      enabled: this._enabled,
      running: this.running,
      ip: this._ip,
      port: this._port,
      apiKey: this._apiKey,
      // 中继模式
      relayEnabled: this._relayEnabled,
      relayConnected: this._relayConnected,
      relayUrl: this._relayUrl
    };
  }
  
  /**
   * 获取远程信息文本（用于复制）
   * @returns {string}
   */
  getInfoText() {
    let text = '';
    
    if (this._server) {
      text += `📱 局域网访问: http://${this._ip}:${this._port}\n🔑 API Key: ${this._apiKey}`;
    }
    
    if (this._relayConnected) {
      if (text) text += '\n\n';
      const httpUrl = this._relayUrl.replace(/^ws(s?):\/\//, 'http$1://');
      text += `🌐 公网访问: ${httpUrl}?session=${encodeURIComponent(this._sessionKey)}\n🔑 Relay API Key: ${this._relayApiKey}`;
    }
    
    return text || '远程服务未启动';
  }
  
  /**
   * 释放所有资源
   */
  dispose() {
    this.stop();
    this._disconnectRelay();
  }
  
  // ==================== 工具方法 ====================
  
  _getIDEName() {
    const names = {
      'cursor': 'Cursor',
      'windsurf': 'Windsurf',
      'vscode': 'VS Code'
    };
    return names[this._ideType] || 'IDE';
  }
  
  /** 保存 API Key 到文件 */
  _saveApiKey(apiKey) {
    try {
      ensureDir(RANJIN_DIR);
      
      // 保存项目专属 API Key
      const keyFile = path.join(RANJIN_DIR, `remote_apikey_${this._sessionKey}.txt`);
      writeTextFile(keyFile, apiKey);
      
      // 保存通用 API Key
      const defaultKeyFile = path.join(RANJIN_DIR, 'remote_apikey.txt');
      writeTextFile(defaultKeyFile, apiKey);
      
      console.log('[燃尽模式] 远程 API Key 已保存');
    } catch (e) {
      console.error('[燃尽模式] 保存 API Key 失败:', e);
    }
  }
}

module.exports = RemoteManager;
