/**
 * 燃尽模式 - 弹窗/反馈管理模块
 * 
 * 管理弹窗请求文件监听、反馈弹窗显示和用户交互
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { CONFIG, RANJIN_DIR, ensureDir, escapeHtml } = require('./config');

class DialogManager {
  /**
   * @param {object} options
   * @param {string} options.sessionKey - 会话标识
   * @param {import('./stats-manager')} options.statsManager - 统计管理器
   * @param {import('./history-manager')} options.historyManager - 历史管理器
   * @param {import('vscode').OutputChannel} options.output - 输出通道
   * @param {Function} options.onNotifyMobile - 手机端通知回调 (message, waiting) => void
   */
  constructor(options) {
    this._sessionKey = options.sessionKey;
    this._stats = options.statsManager;
    this._history = options.historyManager;
    this._output = options.output;
    this._onNotifyMobile = options.onNotifyMobile || (() => {});
    
    this._dialogPanel = null;
    this._dialogWatcherInterval = null;
    this._lastProcessedFileKey = null;
    
    // 文件路径
    this._dialogRequestFile = path.join(RANJIN_DIR, `dialog_request_${this._sessionKey}.json`);
    this._dialogResponseFile = path.join(RANJIN_DIR, `dialog_response_${this._sessionKey}.json`);
  }
  
  /** 获取响应文件路径 */
  get responseFilePath() {
    return this._dialogResponseFile;
  }
  
  /**
   * 启动弹窗请求文件监听
   */
  startWatcher() {
    const watchDir = path.dirname(this._dialogRequestFile);
    ensureDir(watchDir);
    
    // 清理可能残留的请求文件
    try {
      if (fs.existsSync(this._dialogRequestFile)) {
        fs.unlinkSync(this._dialogRequestFile);
      }
    } catch (e) {}
    
    this._output.appendLine('[燃尽模式] 弹窗监听器启动中...');
    
    this._dialogWatcherInterval = setInterval(() => {
      try {
        if (fs.existsSync(this._dialogRequestFile)) {
          const stat = fs.statSync(this._dialogRequestFile);
          const fileKey = `${stat.mtime.getTime()}_${stat.size}`;
          
          if (this._lastProcessedFileKey === fileKey) return;
          this._lastProcessedFileKey = fileKey;
          
          const content = fs.readFileSync(this._dialogRequestFile, 'utf8').trim();
          if (!content) return;
          
          let summary = content;
          let requestId = fileKey;
          try {
            const json = JSON.parse(content);
            summary = json.summary || content;
            requestId = json.requestId || fileKey;
          } catch (e) {
            // 纯文本格式
          }
          
          console.log('[燃尽模式] 检测到弹窗请求:', summary.substring(0, 50));
          this._output.appendLine('[Dialog] 检测到请求: ' + summary);
          
          try {
            fs.unlinkSync(this._dialogRequestFile);
          } catch (e) {}
          
          this._lastProcessedFileKey = null;
          this._handleRequest({ summary, requestId });
        }
      } catch (e) {
        if (e.code !== 'ENOENT') {
          console.error('[燃尽模式] 监听器错误:', e.message);
        }
      }
    }, CONFIG.DIALOG_POLL_INTERVAL);
    
    console.log(`${CONFIG.LOG_PREFIX} 弹窗监听器已启动 (${CONFIG.DIALOG_POLL_INTERVAL}ms 轮询)`);
    this._output.appendLine('[燃尽模式] ✅ 弹窗监听器已启动');
  }
  
  /**
   * 停止弹窗监听
   */
  stopWatcher() {
    if (this._dialogWatcherInterval) {
      clearInterval(this._dialogWatcherInterval);
      this._dialogWatcherInterval = null;
    }
  }
  
  /**
   * 处理弹窗请求
   * @param {object} request - { summary, requestId }
   */
  async _handleRequest(request) {
    try {
      // 记录统计
      this._stats.recordCall();
      
      // 通知手机端：AI 正在等待用户输入
      const waitMsg = `AI 想要结束对话\n摘要: ${request.summary}\n\n请在下方输入反馈指令...`;
      this._onNotifyMobile(waitMsg, true);
      
      // 显示弹窗并等待用户反馈
      const result = await this._collectFeedback(request.summary, this._stats.currentSessionCalls);
      
      // 保存图片
      const savedImagePaths = this._saveImages(result.images);
      
      // 保存历史记录
      if (this._history.enabled) {
        this._history.saveInteraction(
          this._stats.currentSessionCalls,
          request.summary,
          result.feedback,
          result.action,
          savedImagePaths.length
        );
      }
      
      // 更新统计
      if (result.action === 'continue') {
        this._stats.recordContinue();
      } else {
        this._stats.recordEnd();
      }
      
      // 写入响应文件
      const response = {
        requestId: request.requestId,
        timestamp: Date.now(),
        action: result.action,
        feedback: result.feedback || '',
        images: savedImagePaths
      };
      
      fs.writeFileSync(this._dialogResponseFile, JSON.stringify(response, null, 2), 'utf8');
      console.log('[燃尽模式] 响应已写入:', response.action);
      this._output.appendLine('[Dialog] Response written: ' + response.action);
      
      // 通知手机端（如果非手机端来源）
      if (!result.fromMobile) {
        let mobileMsg;
        if (result.action === 'continue') {
          mobileMsg = `用户选择继续${result.feedback ? '\n反馈: ' + result.feedback : ''}`;
        } else {
          mobileMsg = `用户选择结束对话\nAI摘要: ${request.summary}`;
        }
        this._onNotifyMobile(mobileMsg, result.action === 'continue');
      }
      
      return result;
    } catch (e) {
      console.error('[燃尽模式] 处理弹窗请求失败:', e);
    }
  }
  
  /**
   * 保存 base64 图片为文件
   * @param {string[]} images - base64 图片数组
   * @returns {string[]} 保存后的文件路径数组
   */
  _saveImages(images) {
    if (!images || images.length === 0) return [];
    
    const imgDir = path.join(RANJIN_DIR, 'images');
    ensureDir(imgDir);
    
    const savedPaths = [];
    for (let i = 0; i < images.length; i++) {
      const match = images[i].match(/^data:image\/(\w+);base64,(.+)$/);
      if (match) {
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const fileName = `img_${Date.now()}_${i}.${ext}`;
        const filePath = path.join(imgDir, fileName);
        fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
        savedPaths.push(filePath);
        console.log('[燃尽模式] 图片已保存:', filePath);
      }
    }
    return savedPaths;
  }
  
  /**
   * 收集用户反馈（显示弹窗）
   * @param {string} summary - AI 摘要
   * @param {number} callCount - 弹窗次数
   * @returns {Promise<object>} { feedback, action, images, fromMobile? }
   */
  async _collectFeedback(summary, callCount = 1) {
    return new Promise((resolve) => {
      let resolved = false;
      let mobileResponseWatcher = null;
      
      const clearMobileWatcher = () => {
        if (mobileResponseWatcher) {
          clearInterval(mobileResponseWatcher);
          mobileResponseWatcher = null;
        }
      };
      
      // 关闭已存在的弹窗
      if (this._dialogPanel) {
        try { this._dialogPanel.dispose(); } catch {}
        this._dialogPanel = null;
      }
      
      try {
        this._output.appendLine('[燃尽] 显示反馈弹窗 - ' + summary.substring(0, 30));
        
        const panel = vscode.window.createWebviewPanel(
          'ranjinFeedback',
          `🔥 燃尽模式 (第${callCount}次)`,
          { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
          { enableScripts: true, retainContextWhenHidden: true }
        );
        
        this._dialogPanel = panel;
        panel.webview.html = this._buildFeedbackHtml(summary, callCount);
        panel.reveal(vscode.ViewColumn.Active, false);
        
        // 播放提示音
        this._playNotificationSound();
        
        // 状态栏提醒
        const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        statusBarItem.text = "$(bell) 🔥 AI想结束了，请查看弹窗！";
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusBarItem.show();
        
        // 通知提醒
        vscode.window.showInformationMessage(
          '🔥 燃尽模式：AI 想要结束对话，请查看弹窗！', '查看'
        ).then(selection => {
          if (selection === '查看') {
            panel.reveal(vscode.ViewColumn.Active, false);
          }
        });
        
        // 监听手机端响应
        mobileResponseWatcher = setInterval(() => {
          if (resolved) {
            clearMobileWatcher();
            return;
          }
          try {
            if (fs.existsSync(this._dialogResponseFile)) {
              const content = fs.readFileSync(this._dialogResponseFile, 'utf8');
              const response = JSON.parse(content);
              if (response.source === 'mobile_remote') {
                resolved = true;
                clearMobileWatcher();
                statusBarItem.dispose();
                panel.dispose();
                this._dialogPanel = null;
                resolve({
                  feedback: response.feedback || '',
                  action: response.action || 'continue',
                  images: response.images || [],
                  fromMobile: true
                });
              }
            }
          } catch (e) {}
        }, CONFIG.MOBILE_POLL_INTERVAL);
        
        // 处理 Webview 消息
        const messageDisposable = panel.webview.onDidReceiveMessage((message) => {
          if (message.type === 'submit' && !resolved) {
            // 先检查手机端响应
            try {
              if (fs.existsSync(this._dialogResponseFile)) {
                const content = fs.readFileSync(this._dialogResponseFile, 'utf8');
                const response = JSON.parse(content);
                if (response.source === 'mobile_remote') {
                  resolved = true;
                  clearMobileWatcher();
                  messageDisposable.dispose();
                  statusBarItem.dispose();
                  panel.dispose();
                  this._dialogPanel = null;
                  resolve({
                    feedback: response.feedback || '',
                    action: response.action || 'continue',
                    images: response.images || [],
                    fromMobile: true
                  });
                  return;
                }
              }
            } catch (e) {}
            
            resolved = true;
            clearMobileWatcher();
            
            const result = {
              feedback: message.feedback || '',
              action: message.action || 'continue',
              images: message.images || [],
              imageDesc: message.imageDesc || '',
            };
            
            // 注意：历史记录在 _handleRequest 中统一保存，此处不重复保存
            
            messageDisposable.dispose();
            statusBarItem.dispose();
            panel.dispose();
            this._dialogPanel = null;
            resolve(result);
          } else if (message.type === 'loadHistory') {
            const filePath = path.join(this._history.historyDir, `${message.name}.md`);
            const content = this._history.readHistoryFile(filePath);
            if (content) {
              panel.webview.postMessage({ type: 'historyContent', content });
            }
          } else if (message.type === 'deleteHistory') {
            this._history.deleteRound(message.file, message.round);
          } else if (message.type === 'clearAllHistory') {
            this._history.clearAll();
          }
        });
        
        panel.onDidDispose(() => {
          this._dialogPanel = null;
          statusBarItem.dispose();
          clearMobileWatcher();
          if (!resolved) {
            resolved = true;
            messageDisposable.dispose();
            
            // 最后检查手机端响应
            try {
              if (fs.existsSync(this._dialogResponseFile)) {
                const content = fs.readFileSync(this._dialogResponseFile, 'utf8');
                const response = JSON.parse(content);
                if (response.source === 'mobile_remote') {
                  resolve({
                    feedback: response.feedback || '',
                    action: response.action || 'continue',
                    images: response.images || [],
                    fromMobile: true
                  });
                  return;
                }
              }
            } catch (e) {}
            
            resolve({ feedback: '', action: 'stop', images: [] });
          }
        });
        
      } catch (err) {
        this._output.appendLine('[燃尽] 弹窗错误: ' + err.message);
        clearMobileWatcher();
        resolve({ feedback: '', action: 'continue', images: [] });
      }
    });
  }
  
  /**
   * 手动触发反馈弹窗 (快捷键)
   */
  async manualFeedback() {
    let summary = '';
    try {
      summary = await vscode.env.clipboard.readText();
      if (summary && summary.length > CONFIG.MAX_SUMMARY_LENGTH) {
        summary = summary.substring(0, CONFIG.MAX_SUMMARY_LENGTH) + '...';
      }
    } catch (e) {}
    
    if (!summary) {
      summary = '请在此输入 AI 的工作摘要，或先复制 AI 回复再按快捷键';
    }
    
    const result = await this._collectFeedback(summary, this._stats.currentSessionCalls);
    
    if (result.action === 'continue' && result.feedback) {
      await vscode.env.clipboard.writeText(result.feedback);
      vscode.window.showInformationMessage("✅ 反馈已复制到剪贴板，可粘贴给 AI");
    } else if (result.action === 'end') {
      vscode.window.showInformationMessage("对话已结束");
    }
  }
  
  /** 播放提示音 */
  _playNotificationSound() {
    if (process.platform === 'win32') {
      exec(`powershell -c "(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\Windows Notify.wav').PlaySync()"`, () => {});
    } else if (process.platform === 'darwin') {
      exec('afplay /System/Library/Sounds/Glass.aiff', () => {});
    }
  }
  
  /**
   * 构建反馈弹窗 HTML
   * @param {string} summary - AI 摘要
   * @param {number} callCount - 调用次数
   * @returns {string} HTML 内容
   */
  _buildFeedbackHtml(summary, callCount) {
    const saved = this._stats.currentSessionCalls || 0;
    const historyFiles = this._history.getHistoryFiles();
    const projectName = this._history.projectName || 'default';
    
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI 反馈 (第${callCount}次)</title>
    <style>
        :root {
            --bg0: #0a0b0e;
            --bg1: #10121a;
            --fg0: rgba(255,255,255,0.95);
            --fg1: rgba(255,255,255,0.75);
            --fg2: rgba(255,255,255,0.45);
            --stroke: rgba(255,255,255,0.15);
            --accent: #4da3ff;
            --success: #3ecf8e;
            --danger: #ff5a5f;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #0a0b0e 0%, #10121a 50%, #0d0e14 100%);
            color: var(--fg0);
            padding: 20px;
            min-height: 100vh;
        }
        .container { max-width: 800px; margin: 0 auto; }
        .header {
            background: rgba(18, 20, 28, 0.75);
            border: 1px solid var(--stroke);
            border-radius: 16px;
            padding: 20px;
            margin-bottom: 16px;
        }
        .title { font-size: 18px; font-weight: 700; margin-bottom: 8px; }
        .subtitle { font-size: 12px; color: var(--fg2); }
        .summary {
            margin-top: 16px;
            padding: 16px;
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 12px;
            font-size: 14px;
            color: var(--fg1);
            line-height: 1.6;
            white-space: pre-wrap;
            max-height: 300px;
            overflow-y: auto;
        }
        .panel {
            background: rgba(18, 20, 28, 0.75);
            border: 1px solid var(--stroke);
            border-radius: 16px;
            padding: 20px;
        }
        .section-title { font-size: 12px; color: var(--fg2); margin-bottom: 10px; font-weight: 600; }
        #feedback {
            width: 100%;
            min-height: 100px;
            border-radius: 12px;
            border: 2px solid rgba(255,255,255,0.08);
            background: rgba(255,255,255,0.03);
            padding: 14px;
            color: var(--fg0);
            font-size: 14px;
            line-height: 1.6;
            resize: vertical;
            outline: none;
            font-family: inherit;
        }
        #feedback:focus { border-color: rgba(77,163,255,0.5); }
        .main-actions { display: flex; gap: 12px; margin-top: 16px; }
        .main-btn {
            padding: 16px 24px;
            border-radius: 12px;
            border: none;
            font-size: 15px;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
        .btn-continue {
            flex: 1;
            background: linear-gradient(135deg, rgba(62,207,142,0.9), rgba(46,160,110,0.9));
            color: #fff;
        }
        .btn-continue:hover { transform: translateY(-2px); }
        .btn-end {
            padding: 16px 20px;
            background: rgba(255,90,95,0.15);
            border: 1px solid rgba(255,90,95,0.3);
            color: var(--danger);
        }
        .btn-end:hover { background: rgba(255,90,95,0.25); }
        .shortcuts {
            text-align: center;
            margin-top: 14px;
            font-size: 12px;
            color: var(--fg2);
        }
        .shortcuts kbd {
            padding: 3px 8px;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 6px;
        }
        .img-section { display: none; margin-top: 12px; }
        .img-section.show { display: block; }
        .img-title { font-size: 12px; color: var(--fg2); margin-bottom: 8px; }
        .img-grid { display: flex; flex-wrap: wrap; gap: 8px; }
        .img-item { position: relative; width: 50px; height: 50px; border-radius: 6px; overflow: hidden; border: 1px solid var(--stroke); }
        .img-item img { width: 100%; height: 100%; object-fit: cover; }
        .img-del { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; background: rgba(255,90,95,0.9); border: none; border-radius: 50%; color: #fff; font-size: 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
        .upload-hint { font-size: 11px; color: var(--fg2); margin-left: 8px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="title">🔥 AI 反馈 <span style="color:var(--accent);font-weight:normal;font-size:14px;">(本次对话第${callCount}次)</span></div>
            <div class="subtitle">AI 想结束对话了，请选择继续或结束</div>
            <div class="summary">${escapeHtml(summary)}</div>
        </div>
        
        <div class="panel">
            <div class="section-title">✏️ 反馈内容（可选）<span class="upload-hint">Ctrl+V 粘贴图片 | Ctrl+U 上传</span></div>
            <textarea id="feedback" placeholder="输入反馈或指令..."></textarea>
            <input type="file" id="fileInput" accept="image/*" multiple style="display:none">
            
            <div class="img-section" id="imgSection">
                <div class="img-title">🖼️ 已上传图片 <button onclick="clearImages()" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:11px;">清空</button></div>
                <div class="img-grid" id="imgGrid"></div>
            </div>
            
            <div class="history-section" id="historySection" style="display:none;margin-top:12px;padding:10px;background:rgba(77,163,255,0.1);border:1px solid rgba(77,163,255,0.3);border-radius:8px;">
                <div style="font-size:11px;color:var(--accent);margin-bottom:8px;">📚 选择要加载的历史记录：</div>
                <div id="historyList" style="max-height:120px;overflow-y:auto;"></div>
            </div>
            
            <div class="main-actions">
                <button class="main-btn btn-history" id="btnHistory" onclick="toggleHistory()" style="padding:12px 16px;background:rgba(77,163,255,0.15);border:1px solid rgba(77,163,255,0.3);color:var(--accent);font-size:13px;">📂 加载历史</button>
                <button class="main-btn btn-continue" id="btnContinue">✅ 继续</button>
                <button class="main-btn btn-end" id="btnEnd">🛑 结束</button>
            </div>
        </div>
        
        <div class="stats-box" style="margin-top:12px;padding:10px 14px;background:linear-gradient(135deg,rgba(62,207,142,0.15),rgba(77,163,255,0.1));border:1px solid rgba(62,207,142,0.3);border-radius:10px;display:flex;align-items:center;justify-content:center;gap:8px;">
            <span style="font-size:12px;color:rgba(255,255,255,0.7);">💡 燃尽帮你多获得了</span>
            <span style="font-size:18px;font-weight:700;color:#3ecf8e;">${saved}</span>
            <span style="font-size:12px;color:rgba(255,255,255,0.7);">次交互</span>
        </div>
        
        <div class="shortcuts">
            <kbd>Ctrl+Enter</kbd> 继续 | <kbd>Ctrl+U</kbd> 上传图片 | <kbd>Ctrl+V</kbd> 粘贴图片 | <kbd>Esc</kbd> 结束
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        const feedbackEl = document.getElementById('feedback');
        const fileInput = document.getElementById('fileInput');
        let uploadedImages = [];
        
        function submit(action) {
            const imgDescEl = document.getElementById('imgDesc');
            vscode.postMessage({
                type: 'submit',
                action: action,
                feedback: feedbackEl.value,
                images: uploadedImages,
                imageDesc: imgDescEl ? imgDescEl.value : ''
            });
        }
        
        function renderImages() {
            const section = document.getElementById('imgSection');
            const grid = document.getElementById('imgGrid');
            if (uploadedImages.length === 0) {
                section.classList.remove('show');
                return;
            }
            grid.innerHTML = uploadedImages.map((img, i) => 
                '<div class="img-item"><img src="' + img + '"><button class="img-del" onclick="removeImage(' + i + ')">✕</button></div>'
            ).join('');
            section.classList.add('show');
        }
        
        function removeImage(i) {
            uploadedImages.splice(i, 1);
            renderImages();
        }
        
        function clearImages() {
            uploadedImages = [];
            renderImages();
        }
        
        function processFile(file) {
            if (!file.type.startsWith('image/')) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                uploadedImages.push(e.target.result);
                renderImages();
            };
            reader.readAsDataURL(file);
        }
        
        document.addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (items) {
                for (let i = 0; i < items.length; i++) {
                    if (items[i].type.indexOf('image') !== -1) {
                        e.preventDefault();
                        processFile(items[i].getAsFile());
                        return;
                    }
                }
            }
        });
        
        fileInput.onchange = (e) => {
            for (const file of e.target.files) processFile(file);
            fileInput.value = '';
        };
        
        document.getElementById('btnContinue').onclick = () => submit('continue');
        document.getElementById('btnEnd').onclick = () => submit('end');
        
        // 历史记录功能
        let historyVisible = false;
        const historyData = ${JSON.stringify(historyFiles).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')};
        const projectName = ${JSON.stringify(projectName)};
        
        function toggleHistory() {
            const section = document.getElementById('historySection');
            historyVisible = !historyVisible;
            section.style.display = historyVisible ? 'block' : 'none';
            if (historyVisible && historyData.length > 0) {
                renderHistoryList();
            } else if (historyData.length === 0) {
                document.getElementById('historyList').innerHTML = '<div style="color:var(--fg2);font-size:11px;">当前项目暂无历史记录</div>';
            }
        }
        
        function renderHistoryList() {
            const list = document.getElementById('historyList');
            let html = '<div style="padding:6px 10px;margin-bottom:8px;background:linear-gradient(135deg,rgba(77,163,255,0.2),rgba(62,207,142,0.1));border-radius:6px;font-size:12px;font-weight:600;color:#4da3ff;display:flex;justify-content:space-between;align-items:center;">📁 ' + projectName + '<button onclick="clearAllHistory(event)" style="background:rgba(255,90,95,0.2);border:1px solid rgba(255,90,95,0.4);color:#ff5a5f;padding:2px 8px;border-radius:4px;font-size:10px;cursor:pointer;">🗑️ 清空全部</button></div>';
            html += historyData.map((h, i) => 
                '<div style="padding:6px 10px;margin:4px 0;background:rgba(255,255,255,0.05);border-radius:6px;font-size:11px;line-height:1.4;display:flex;justify-content:space-between;align-items:center;" title="' + (h.tooltip || '').replace(/"/g, '&quot;') + '"><span onclick="loadHistory(' + i + ')" style="cursor:pointer;flex:1;">📋 ' + h.name + '</span><button onclick="deleteHistory(event,' + i + ')" style="background:none;border:none;color:#ff5a5f;cursor:pointer;font-size:12px;padding:2px 6px;">✕</button></div>'
            ).join('');
            list.innerHTML = html;
        }
        
        function loadHistory(index) {
            const h = historyData[index];
            if (h && h.fullContent) {
                feedbackEl.value = '请参考以下历史上下文继续工作：\\n\\n' + h.fullContent;
                document.getElementById('historySection').style.display = 'none';
                historyVisible = false;
            }
        }
        
        function deleteHistory(event, index) {
            event.stopPropagation();
            const h = historyData[index];
            if (h && confirm('确定删除这条历史记录吗？')) {
                vscode.postMessage({ type: 'deleteHistory', file: h.file, round: h.round });
                historyData.splice(index, 1);
                renderHistoryList();
            }
        }
        
        function clearAllHistory(event) {
            event.stopPropagation();
            if (confirm('确定清空当前项目的所有历史记录吗？')) {
                vscode.postMessage({ type: 'clearAllHistory' });
                historyData.length = 0;
                renderHistoryList();
            }
        }
        
        window.addEventListener('message', (e) => {
            if (e.data.type === 'historyContent') {
                feedbackEl.value = '请参考以下历史上下文继续工作：\\n\\n' + e.data.content;
                document.getElementById('historySection').style.display = 'none';
                historyVisible = false;
            }
        });
        
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'Enter') {
                e.preventDefault();
                submit('continue');
            } else if (e.key === 'Escape') {
                e.preventDefault();
                submit('end');
            } else if (e.ctrlKey && e.key === 'u') {
                e.preventDefault();
                fileInput.click();
            }
        });
        
        feedbackEl.focus();
    </script>
</body>
</html>`;
  }
  
  /** 关闭弹窗 */
  dispose() {
    this.stopWatcher();
    if (this._dialogPanel) {
      this._dialogPanel.dispose();
      this._dialogPanel = null;
    }
  }
}

module.exports = DialogManager;
