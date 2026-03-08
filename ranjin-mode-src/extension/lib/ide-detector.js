/**
 * 燃尽模式 - IDE 检测模块
 * 
 * 检测当前运行的 IDE 类型和项目信息
 */

const vscode = require('vscode');
const path = require('path');

/**
 * 检测当前 IDE 类型（支持 Cursor、Windsurf）
 * @returns {string} IDE 类型标识
 */
function detectIDE() {
  try {
    // 方法1: 检查 vscode.env.appName
    const appName = vscode.env.appName.toLowerCase();
    if (appName.includes('cursor')) return 'cursor';
    if (appName.includes('windsurf')) return 'windsurf';

    // 方法2: 检查扩展安装路径
    const extensionPath = __dirname;
    if (extensionPath.includes('.cursor')) return 'cursor';
    if (extensionPath.includes('.windsurf')) return 'windsurf';

    // 方法3: 检查 vscode.env.appRoot
    const appRoot = vscode.env.appRoot.toLowerCase();
    if (appRoot.includes('cursor')) return 'cursor';
    if (appRoot.includes('windsurf')) return 'windsurf';

    return 'vscode';
  } catch (e) {
    return 'unknown';
  }
}

/**
 * 获取项目唯一标识（基于项目路径的短哈希）
 * @returns {string} 项目 ID
 */
function getProjectId() {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const projectPath = workspaceFolders[0].uri.fsPath;
      let hash = 0;
      for (let i = 0; i < projectPath.length; i++) {
        hash = ((hash << 5) - hash) + projectPath.charCodeAt(i);
        hash = hash & hash; // 转换为32位整数
      }
      return Math.abs(hash).toString(36).substring(0, 8);
    }
  } catch (e) {}
  return 'default';
}

/**
 * 获取当前项目名称
 * @returns {string} 项目名称
 */
function getProjectName() {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      return path.basename(workspaceFolders[0].uri.fsPath);
    }
  } catch (e) {}
  return 'default';
}

/**
 * 生成会话唯一标识
 * @param {string} ideType - IDE 类型
 * @param {string} projectId - 项目 ID
 * @returns {string} 会话 Key
 */
function getSessionKey(ideType, projectId) {
  return `${ideType}_${projectId}`;
}

module.exports = {
  detectIDE,
  getProjectId,
  getProjectName,
  getSessionKey
};
