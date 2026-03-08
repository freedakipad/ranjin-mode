/**
 * 燃尽模式 - 历史记录管理模块
 * 
 * 管理交互历史的存储、查询、删除和导入导出
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { CONFIG, RANJIN_DIR, ensureDir, readTextFile, writeTextFile } = require('./config');

class HistoryManager {
  /**
   * @param {string} projectName - 项目名称
   * @param {import('vscode').OutputChannel} output - 输出通道
   */
  constructor(projectName, output) {
    this._output = output;
    this._projectName = projectName;
    
    // 历史目录
    this._historyBaseDir = path.join(RANJIN_DIR, 'history');
    const safeName = projectName.replace(/[<>:"/\\|?*]/g, '_');
    this._historyDir = path.join(this._historyBaseDir, safeName);
    
    // 加载开关状态
    this._enabled = this._loadEnabled();
    
    // 确保目录存在
    ensureDir(this._historyDir);
  }
  
  /** 历史功能是否启用 */
  get enabled() {
    return this._enabled;
  }
  
  /** 项目名称 */
  get projectName() {
    return this._projectName;
  }
  
  /** 加载历史存储开关状态 */
  _loadEnabled() {
    const enabledFile = path.join(RANJIN_DIR, 'history_enabled.txt');
    const value = readTextFile(enabledFile, '1');
    return value === '1';
  }
  
  /**
   * 切换历史存储
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    const enabledFile = path.join(RANJIN_DIR, 'history_enabled.txt');
    writeTextFile(enabledFile, enabled ? '1' : '0');
    this._enabled = enabled;
  }
  
  /** 获取今天的历史文件路径 */
  _getTodayFile() {
    const today = new Date().toISOString().split('T')[0];
    return path.join(this._historyDir, `${today}.md`);
  }
  
  /**
   * 保存交互记录
   * @param {number} round - 轮次
   * @param {string} summary - AI 摘要
   * @param {string} feedback - 用户反馈
   * @param {string} action - 用户选择
   * @param {number} imageCount - 图片数量
   */
  saveInteraction(round, summary, feedback, action, imageCount = 0) {
    if (!this._enabled) return;
    
    try {
      const filePath = this._getTodayFile();
      const timestamp = new Date().toLocaleTimeString('zh-CN');
      
      let content = '';
      if (!fs.existsSync(filePath)) {
        content = `# 燃尽模式历史记录 - ${new Date().toLocaleDateString('zh-CN')}\n\n`;
      }
      
      content += `## 轮次 ${round} (${timestamp})\n`;
      content += `- **AI摘要**: ${summary}\n`;
      if (feedback) {
        content += `- **用户反馈**: ${feedback}\n`;
      }
      if (imageCount > 0) {
        content += `- **用户图片**: [${imageCount}张] (AI分析见下一轮摘要)\n`;
      }
      content += `- **用户选择**: ${action === 'continue' ? '继续' : '结束'}\n\n`;
      
      fs.appendFileSync(filePath, content, 'utf8');
      this._output.appendLine(`[历史] 已保存轮次 ${round}`);
    } catch (e) {
      console.error('[燃尽模式] 保存历史失败:', e);
    }
  }
  
  /**
   * 获取历史文件列表（按轮次解析）
   * @returns {Array<object>}
   */
  getHistoryFiles() {
    try {
      if (!fs.existsSync(this._historyDir)) return [];
      const files = fs.readdirSync(this._historyDir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse()
        .slice(0, CONFIG.MAX_HISTORY_DAYS);
      
      const result = [];
      for (const f of files) {
        const filePath = path.join(this._historyDir, f);
        const content = fs.readFileSync(filePath, 'utf8');
        
        const rounds = content.split(/## 轮次 (\d+)/);
        for (let i = 1; i < rounds.length; i += 2) {
          const roundNum = rounds[i];
          const roundContent = rounds[i + 1] || '';
          const timeMatch = roundContent.match(/\((\d+:\d+:\d+)\)/);
          const summaryMatch = roundContent.match(/\*\*AI摘要\*\*: ([^\n]+)/);
          const feedbackMatch = roundContent.match(/\*\*用户反馈\*\*: ([^\n]+)/);
          const time = timeMatch ? timeMatch[1].substring(0, 5) : '';
          const summary = summaryMatch ? summaryMatch[1] : '';
          
          // 从摘要中提取文件名
          const fileMatches = summary.match(
            /[\w\-./\\]+\.(js|ts|tsx|jsx|vue|py|java|css|html|json|md|txt|yaml|yml|xml|sql|go|rs|c|cpp|h|hpp|cs|php|rb|swift|kt)/gi
          );
          let displayText = '';
          if (fileMatches && fileMatches.length > 0) {
            const fileNames = fileMatches.map(fn => fn.split(/[/\\]/).pop()).slice(0, 3);
            displayText = fileNames.join(', ');
          } else if (feedbackMatch && feedbackMatch[1].trim()) {
            displayText = feedbackMatch[1].substring(0, 35);
          } else {
            displayText = summary.substring(0, 35);
          }
          
          result.push({
            name: `${time} ${displayText}${displayText.length >= 35 ? '...' : ''}`,
            tooltip: summary.substring(0, 100),
            file: f,
            round: roundNum,
            fullContent: `## 轮次 ${roundNum}${roundContent}`
              .replace(/\\/g, '\\\\')
              .replace(/'/g, "\\'")
              .replace(/"/g, '\\"')
          });
        }
      }
      return result.slice(0, CONFIG.MAX_HISTORY_ITEMS);
    } catch (e) {
      return [];
    }
  }
  
  /**
   * 读取历史文件内容
   * @param {string} filePath
   * @returns {string|null}
   */
  readHistoryFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf8');
      }
    } catch (e) {}
    return null;
  }
  
  /**
   * 删除单条历史记录（按轮次）
   * @param {string} fileName
   * @param {string|number} round
   */
  deleteRound(fileName, round) {
    try {
      const filePath = path.join(this._historyDir, fileName);
      if (!fs.existsSync(filePath)) return;
      
      let content = fs.readFileSync(filePath, 'utf8');
      const pattern = new RegExp(`## 轮次 ${round}[\\s\\S]*?(?=## 轮次 \\d+|$)`, 'g');
      content = content.replace(pattern, '');
      
      if (content.trim().match(/^# 燃尽模式历史记录.*$/)) {
        fs.unlinkSync(filePath);
      } else {
        fs.writeFileSync(filePath, content, 'utf8');
      }
      this._output.appendLine(`[历史] 已删除 ${fileName} 轮次 ${round}`);
    } catch (e) {
      console.error('[燃尽模式] 删除历史记录失败:', e);
    }
  }
  
  /**
   * 清空所有历史记录
   */
  clearAll() {
    try {
      if (!fs.existsSync(this._historyDir)) return;
      
      const files = fs.readdirSync(this._historyDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        fs.unlinkSync(path.join(this._historyDir, file));
      }
      this._output.appendLine(`[历史] 已清空所有历史记录 (${files.length}个文件)`);
    } catch (e) {
      console.error('[燃尽模式] 清空历史记录失败:', e);
    }
  }
  
  /**
   * 显示历史记录面板（QuickPick）
   */
  async showPanel() {
    const files = this.getHistoryFiles();
    if (files.length === 0) {
      vscode.window.showInformationMessage('📚 暂无历史记录');
      return;
    }
    
    const items = files.map(f => ({
      label: `📅 ${f.name}`,
      description: '点击查看',
      file: f
    }));
    
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要查看的历史记录'
    });
    
    if (selected) {
      const filePath = path.join(this._historyDir, selected.file.file);
      const content = this.readHistoryFile(filePath);
      if (content) {
        const doc = await vscode.workspace.openTextDocument({
          content: content,
          language: 'markdown'
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    }
  }
  
  /**
   * 导出历史记录
   */
  async exportHistory() {
    const files = this.getHistoryFiles();
    if (files.length === 0) {
      vscode.window.showInformationMessage('📚 暂无可导出的历史记录');
      return;
    }
    
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), 'ranjin-history-export.md')),
      filters: { 'Markdown': ['md'] }
    });
    
    if (uri) {
      let content = '# 燃尽模式历史记录导出\n\n';
      for (const f of files) {
        const filePath = path.join(this._historyDir, f.file);
        const fileContent = this.readHistoryFile(filePath);
        if (fileContent) {
          content += `---\n\n${fileContent}\n\n`;
        }
      }
      fs.writeFileSync(uri.fsPath, content, 'utf8');
      vscode.window.showInformationMessage('✅ 历史记录已导出');
    }
  }
  
  /**
   * 导入历史记录
   */
  async importHistory() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'Markdown': ['md'] }
    });
    
    if (uris && uris[0]) {
      try {
        const content = fs.readFileSync(uris[0].fsPath, 'utf8');
        const today = new Date().toISOString().split('T')[0];
        const targetPath = path.join(this._historyDir, `${today}-imported.md`);
        fs.writeFileSync(targetPath, content, 'utf8');
        vscode.window.showInformationMessage('✅ 历史记录已导入');
      } catch (e) {
        vscode.window.showErrorMessage('❌ 导入失败: ' + e.message);
      }
    }
  }
  
  /**
   * 获取历史目录路径
   * @returns {string}
   */
  get historyDir() {
    return this._historyDir;
  }
}

module.exports = HistoryManager;
