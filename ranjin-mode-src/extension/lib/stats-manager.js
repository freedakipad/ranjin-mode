/**
 * 燃尽模式 - 统计管理模块
 * 
 * 管理弹窗统计数据的加载、保存和更新
 */

const path = require('path');
const { RANJIN_DIR, readJsonFile, writeJsonFile } = require('./config');

class StatsManager {
  /**
   * @param {string} sessionKey - 会话标识 (ideType_projectId)
   * @param {import('vscode').OutputChannel} output - 输出通道
   */
  constructor(sessionKey, output) {
    this._output = output;
    this._statsFile = path.join(RANJIN_DIR, `stats_${sessionKey}.json`);
    this._currentSessionCalls = 0; // 本轮会话弹窗数（不持久化）
    
    // 默认统计
    this._stats = {
      totalCalls: 0,
      continueCount: 0,
      endCount: 0,
      sessionCount: 0,
      lastCallTime: null
    };
    
    this._load();
  }
  
  /** 获取统计数据 */
  get stats() {
    return { ...this._stats };
  }
  
  /** 获取本轮会话弹窗数 */
  get currentSessionCalls() {
    return this._currentSessionCalls;
  }
  
  /** 加载持久化统计 */
  _load() {
    const data = readJsonFile(this._statsFile);
    if (data) {
      this._stats = { ...this._stats, ...data };
      console.log('[燃尽模式] 已加载统计:', this._stats);
    }
  }
  
  /** 保存持久化统计 */
  _save() {
    try {
      writeJsonFile(this._statsFile, this._stats);
    } catch (e) {
      console.error('[燃尽模式] 保存统计失败:', e);
    }
  }
  
  /**
   * 记录一次弹窗调用
   */
  recordCall() {
    this._stats.totalCalls++;
    this._stats.lastCallTime = Date.now();
    this._currentSessionCalls++;
    this._save();
  }
  
  /**
   * 记录用户选择继续
   */
  recordContinue() {
    this._stats.continueCount++;
    this._save();
  }
  
  /**
   * 记录用户选择结束
   */
  recordEnd() {
    this._stats.endCount++;
    this._stats.sessionCount++;
    this._currentSessionCalls = 0;
    this._save();
  }
  
  /**
   * 获取用于侧边栏显示的统计数据
   * @returns {object}
   */
  getDisplayStats() {
    return {
      ...this._stats,
      currentSessionCalls: this._currentSessionCalls
    };
  }
}

module.exports = StatsManager;
