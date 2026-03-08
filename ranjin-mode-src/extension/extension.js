/**
 * 燃尽模式 - AI持久输出助手
 * 
 * 功能:
 * 1. 通过 dialog-trigger.js 命令触发弹窗
 * 2. 文件监听方式响应弹窗请求
 * 3. 弹窗统计功能（IDE + 项目独立）
 * 4. 自动创建 .cursorrules / .windsurfrules
 * 5. 支持 Cursor、Windsurf IDE
 * 6. 手机端远程对话功能
 */

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");

// 模块导入
const { CONFIG, RANJIN_DIR, ensureDir } = require("./lib/config");
const { detectIDE, getProjectId, getProjectName, getSessionKey } = require("./lib/ide-detector");
const StatsManager = require("./lib/stats-manager");
const HistoryManager = require("./lib/history-manager");
const DialogManager = require("./lib/dialog-manager");
const RemoteManager = require("./lib/remote-manager");
const RulesManager = require("./lib/rules-manager");

/**
 * 燃尽模式面板 - 核心协调器
 * 
 * 负责组装各子模块并处理侧边栏 WebView 交互
 */
class RanjinPanel {
  constructor(context) {
    console.log(`${CONFIG.LOG_PREFIX} 构造函数调用`);
    this._context = context;
    this._view = null;
    
    // 输出通道
    this._output = vscode.window.createOutputChannel('燃尽模式');
    
    // IDE 与项目信息
    const ideType = detectIDE();
    const projectId = getProjectId();
    const projectName = getProjectName();
    const sessionKey = getSessionKey(ideType, projectId);
    this._output.appendLine(`[燃尽模式] IDE: ${ideType}, 项目: ${projectName} (${projectId})`);
    
    // 初始化子模块
    this._stats = new StatsManager(sessionKey, this._output);
    this._history = new HistoryManager(projectName, this._output);
    
    this._remote = new RemoteManager({
      ideType,
      projectId,
      sessionKey,
      output: this._output
    });
    
    this._dialog = new DialogManager({
      sessionKey,
      statsManager: this._stats,
      historyManager: this._history,
      output: this._output,
      onNotifyMobile: (msg, waiting) => this._remote.notifyClients(msg, waiting)
    });
    
    this._rules = new RulesManager({
      projectId,
      extensionPath: context.extensionPath,
      output: this._output
    });
    
    // 自动创建 AI 规则文件
    this._rules.ensureRules();
    
    // 启动远程服务（如果启用）
    if (this._remote.enabled) {
      this._remote.start();
    }
    
    // 自动连接中继服务器（如果已配置）
    if (this._remote.relayEnabled) {
      this._remote._connectRelay();
    }
    
    // 启动弹窗监听
    this._dialog.startWatcher();
    
    console.log("[燃尽模式] 本地版初始化完成");
  }
  
  // ==================== 侧边栏 WebView ====================
  
  resolveWebviewView(webviewView) {
    console.log("[燃尽模式] resolveWebviewView 被调用");
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri]
    };

    webviewView.webview.html = this._getHtml();

    // 处理来自 Webview 的消息
    webviewView.webview.onDidReceiveMessage(async (message) => {
      console.log("[燃尽模式] 收到消息:", message.type);
      try {
        await this._handleWebviewMessage(message);
      } catch (error) {
        console.error("[燃尽模式] 处理消息出错:", error);
        this._showMessage("error", "❌ " + error.message);
      }
    });

    this._loadUserData();
  }

  /**
   * 处理 Webview 消息
   */
  async _handleWebviewMessage(message) {
    switch (message.type) {
      case "init":
        await this._loadUserData();
        break;
      case "toggleRanjin":
        await this._toggleRanjin(message.enabled);
        break;
      case "copyText":
        await vscode.env.clipboard.writeText(message.text);
        this._showMessage("success", "✅ 已复制到剪贴板");
        break;
      case "openURL":
        if (message.url) {
          vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        break;
      case "getStats":
        this._updateSidebarStats();
        break;
      case "showHistory":
        await this._history.showPanel();
        break;
      case "exportHistory":
        await this._history.exportHistory();
        break;
      case "importHistory":
        await this._history.importHistory();
        break;
      case "toggleHistory":
        this._history.setEnabled(message.enabled);
        this._showMessage("success", message.enabled ? "✅ 上下文存储已开启" : "⏹️ 上下文存储已关闭");
        break;
      case "toggleRemote":
        await this._toggleRemote(message.enabled);
        break;
      case "getRemoteStatus":
        this._updateSidebarRemoteStatus();
        break;
      case "copyRemoteInfo":
        await vscode.env.clipboard.writeText(this._remote.getInfoText());
        this._showMessage("success", "✅ 远程信息已复制");
        break;
      
      // 中继模式
      case "startRelay":
        try {
          await this._remote.startRelay({
            url: message.url,
            apiKey: message.apiKey
          });
          this._showMessage("success", "✅ 正在连接中继服务器...");
          setTimeout(() => this._updateSidebarRemoteStatus(), 2000);
        } catch (e) {
          this._showMessage("error", "❌ 连接失败: " + e.message);
        }
        break;
      case "stopRelay":
        this._remote.stopRelay();
        this._showMessage("success", "⏹️ 中继连接已断开");
        this._updateSidebarRemoteStatus();
        break;
      case "getRelayStatus":
        this._updateSidebarRemoteStatus();
        break;
    }
  }
  
  // ==================== 侧边栏数据更新 ====================
  
  /** 加载用户数据 */
  async _loadUserData() {
    let isEnabled = true;
    try {
      const enabledFile = path.join(RANJIN_DIR, "enabled.txt");
      if (fs.existsSync(enabledFile)) {
        isEnabled = fs.readFileSync(enabledFile, "utf8").trim() !== "0";
      }
    } catch (error) {
      console.error("[燃尽模式] 读取开关状态失败:", error);
    }

    this._sendToWebview("updateData", {
      loggedIn: true,
      user: { name: "本地用户" },
      enabled: isEnabled,
      historyEnabled: this._history.enabled,
      stats: this._stats.stats,
      isLocalVersion: true,
      remoteEnabled: this._remote.enabled,
      remoteRunning: this._remote.running,
      remoteIP: this._remote.ip,
      remotePort: this._remote.port,
      remoteApiKey: this._remote.apiKey,
      // 中继模式
      relayEnabled: this._remote.relayEnabled,
      relayConnected: this._remote.relayConnected,
      relayUrl: this._remote.relayUrl
    });
  }
  
  /** 更新侧边栏统计 */
  _updateSidebarStats() {
    if (this._view && this._view.webview) {
      this._view.webview.postMessage({
        type: 'updateStats',
        stats: this._stats.getDisplayStats()
      });
    }
  }
  
  /** 更新侧边栏远程状态 */
  _updateSidebarRemoteStatus() {
    if (this._view && this._view.webview) {
      this._view.webview.postMessage({
        type: 'updateRemoteStatus',
        data: this._remote.getStatus()
      });
    }
  }
  
  // ==================== 切换操作 ====================
  
  /** 切换燃尽模式开关 */
  async _toggleRanjin(enabled) {
    try {
      ensureDir(RANJIN_DIR);
      const enabledFile = path.join(RANJIN_DIR, "enabled.txt");
      fs.writeFileSync(enabledFile, enabled ? "1" : "0", "utf8");
      this._showMessage("success", enabled ? "✅ 燃尽模式已开启" : "⏹️ 燃尽模式已关闭");
    } catch (error) {
      this._showMessage("error", "❌ 切换失败: " + error.message);
    }
  }
  
  /** 切换远程服务 */
  async _toggleRemote(enabled) {
    try {
      await this._remote.toggle(enabled);
      this._showMessage("success", enabled ? "✅ 远程服务已开启" : "⏹️ 远程服务已关闭");
      this._updateSidebarRemoteStatus();
    } catch (e) {
      this._showMessage("error", "❌ 切换失败: " + e.message);
    }
  }
  
  // ==================== 工具方法 ====================
  
  /** 发送消息到 Webview */
  _sendToWebview(type, data) {
    if (this._view && this._view.webview) {
      this._view.webview.postMessage({ type, ...data });
    }
  }

  /** 显示 Toast 消息 */
  _showMessage(type, message) {
    if (this._view && this._view.webview) {
      this._view.webview.postMessage({ type: "showToast", toastType: type, message });
    }
  }

  /** 获取侧边栏 HTML */
  _getHtml() {
    const htmlPath = path.join(this._context.extensionPath, "webview.html");
    return fs.readFileSync(htmlPath, "utf8");
  }

  /** 释放资源 */
  dispose() {
    this._dialog.dispose();
    this._remote.dispose();
    if (this._output) {
      this._output.dispose();
    }
  }
}

// ==================== 扩展入口 ====================

function activate(context) {
  console.log("[燃尽模式] ========================================");
  console.log("[燃尽模式] 🚀 燃尽模式扩展开始激活");

  try {
    const panel = new RanjinPanel(context);

    const provider = vscode.window.registerWebviewViewProvider(
      "ranjin.mainPanel",
      panel,
      { webviewOptions: { retainContextWhenHidden: true } }
    );

    context.subscriptions.push(provider);

    // 监听工作区变化，自动创建规则文件
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        panel._rules.ensureRules();
      })
    );

    console.log("[燃尽模式] 规则文件已创建/更新");

    // 注册命令：打开面板
    context.subscriptions.push(
      vscode.commands.registerCommand("ranjin.showPanel", () => {
        vscode.commands.executeCommand("workbench.view.extension.ranjin-panel");
      })
    );

    // 注册命令：快捷键触发反馈弹窗 (Ctrl+Shift+M)
    context.subscriptions.push(
      vscode.commands.registerCommand("ranjin.feedback", async () => {
        await panel._dialog.manualFeedback();
      })
    );

    // 清理时释放资源
    context.subscriptions.push({
      dispose: () => panel.dispose()
    });

    console.log("[燃尽模式] ✅ 扩展激活完成");
  } catch (error) {
    console.error("[燃尽模式] ❌ 激活失败:", error);
  }
}

function deactivate() {
  console.log("[燃尽模式] 扩展已停用");
}

module.exports = {
  activate,
  deactivate
};
