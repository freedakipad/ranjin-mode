/**
 * 燃尽模式 - 配置常量和工具函数
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// 配置常量
const CONFIG = {
  DIALOG_POLL_INTERVAL: 200,      // 弹窗请求轮询间隔 (ms)
  MOBILE_POLL_INTERVAL: 300,      // 手机端响应轮询间隔 (ms)
  DIALOG_TIMEOUT: 3600000,        // 弹窗超时时间 (1小时)
  MAX_SUMMARY_LENGTH: 500,        // 摘要最大长度
  DEFAULT_REMOTE_PORT: 3000,      // 默认远程端口
  MAX_HISTORY_DAYS: 5,            // 最多保留最近几天历史
  MAX_HISTORY_ITEMS: 20,          // 最多展示历史条目数
  LOG_PREFIX: '[燃尽模式]'
};

// 基础目录
const RANJIN_DIR = path.join(os.homedir(), '.ranjin-mode');

/**
 * 确保目录存在
 * @param {string} dirPath - 目录路径
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * HTML 转义
 * @param {string} text - 原始文本
 * @returns {string} 转义后的 HTML
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 安全读取 JSON 文件
 * @param {string} filePath - 文件路径
 * @param {*} defaultValue - 默认值
 * @returns {*} 解析后的对象或默认值
 */
function readJsonFile(filePath, defaultValue = null) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    // 文件可能损坏或正在写入
  }
  return defaultValue;
}

/**
 * 安全写入 JSON 文件
 * @param {string} filePath - 文件路径
 * @param {*} data - 要写入的数据
 */
function writeJsonFile(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * 安全读取文本文件
 * @param {string} filePath - 文件路径
 * @param {string} defaultValue - 默认值
 * @returns {string}
 */
function readTextFile(filePath, defaultValue = '') {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8').trim();
    }
  } catch (e) {}
  return defaultValue;
}

/**
 * 安全写入文本文件
 * @param {string} filePath - 文件路径
 * @param {string} content - 内容
 */
function writeTextFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

module.exports = {
  CONFIG,
  RANJIN_DIR,
  ensureDir,
  escapeHtml,
  readJsonFile,
  writeJsonFile,
  readTextFile,
  writeTextFile
};
