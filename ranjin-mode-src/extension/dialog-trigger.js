#!/usr/bin/env node
/**
 * 燃尽模式 - 弹窗触发脚本
 * 跨平台：Windows/Mac/Linux
 * 支持 IDE：Cursor、Windsurf
 * 
 * 用法：node dialog-trigger.js <ide> <project_id> "AI想要结束的原因"
 *   - ide: cursor / windsurf（IDE 类型）
 *   - project_id: 项目唯一标识（8位哈希）
 *   - 摘要: AI 想要结束的原因
 * 
 * 示例：
 *   node dialog-trigger.js cursor abc12345 "代码已完成"
 *   node dialog-trigger.js windsurf xyz98765 "任务完成"
 * 
 * 流程：
 * 1. 写入请求文件，触发对应 IDE + 项目的扩展弹窗
 * 2. 同时通知手机端（如果远程服务开启）
 * 3. 等待用户响应
 * 4. 读取响应并输出
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ranjinDir = path.join(os.homedir(), '.ranjin-mode');

// 解析参数
// 支持多种格式：
// 格式1: node dialog-trigger.js <ide> <project_id> "摘要" (推荐)
// 格式2: node dialog-trigger.js <ide> "摘要" (兼容旧版，project_id 默认 default)
// 格式3: node dialog-trigger.js "摘要" (兼容最旧版，ide 默认 cursor，project_id 默认 default)

let ide = 'ide';
let projectId = 'default';
let summary = 'AI has completed the task.';

const validIDEs = ['ide', 'cursor', 'windsurf', 'vscode', 'unknown'];

if (process.argv.length >= 5) {
  // 新格式：ide + project_id + 摘要
  ide = process.argv[2].toLowerCase();
  projectId = process.argv[3];
  summary = process.argv[4];
} else if (process.argv.length >= 4) {
  // 中间格式：可能是 ide + 摘要，或 project_id + 摘要
  const arg2 = process.argv[2].toLowerCase();
  const arg3 = process.argv[3];
  
  if (validIDEs.includes(arg2)) {
    ide = arg2;
    summary = arg3;
  } else {
    // 假设是 project_id + 摘要
    projectId = arg2;
    summary = arg3;
  }
} else if (process.argv.length >= 3) {
  // 旧格式：只有摘要或 IDE
  const arg = process.argv[2].toLowerCase();
  if (validIDEs.includes(arg)) {
    ide = arg;
  } else {
    summary = process.argv[2];
  }
}

// 生成会话 key (IDE + 项目)
const sessionKey = `${ide}_${projectId}`;

// 根据 IDE + 项目 使用不同的请求/响应文件
const requestFile = path.join(ranjinDir, `dialog_request_${sessionKey}.json`);
const responseFile = path.join(ranjinDir, `dialog_response_${sessionKey}.json`);

// 确保目录存在
if (!fs.existsSync(ranjinDir)) {
  fs.mkdirSync(ranjinDir, { recursive: true });
}

// 生成请求 ID
const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

// 轮询配置（必须在 notifyMobile 调用之前定义）
const POLL_CONFIG = {
  MAX_WAIT: 3600000,      // 1小时超时
  POLL_INTERVAL: 300,     // 300ms 轮询间隔
  NOTIFY_TIMEOUT: 3000    // 手机端通知超时
};

console.log(`[燃尽模式] IDE: ${ide}, 项目: ${projectId}`);
console.log('[燃尽模式] 等待用户响应弹窗...');

// 删除旧的响应文件
try {
  if (fs.existsSync(responseFile)) {
    fs.unlinkSync(responseFile);
  }
} catch (e) { /* 忽略文件删除错误 */ }

// 尝试通知手机端（异步，不影响主流程）
notifyMobile(summary, sessionKey);

// 写入请求文件
const request = {
  timestamp: Date.now(),
  summary: summary,
  requestId: requestId,
  ide: ide,
  projectId: projectId,
  sessionKey: sessionKey
};

fs.writeFileSync(requestFile, JSON.stringify(request, null, 2), 'utf8');

let waited = 0;

const checkResponse = () => {
  waited += POLL_CONFIG.POLL_INTERVAL;
  
  try {
    if (fs.existsSync(responseFile)) {
      const content = fs.readFileSync(responseFile, 'utf8');
      const response = JSON.parse(content);
      
      // 验证是否是当前请求的响应
      if (response.requestId === requestId || !response.requestId) {
        // 输出响应（格式优化，确保AI能识别）
        const action = response.action || 'continue';
        const feedback = response.feedback || '';
        
        console.log('');
        console.log('='.repeat(50));
        console.log('ACTION:', action);
        console.log('='.repeat(50));
        
        if (feedback.trim()) {
          console.log('');
          console.log('⚠️⚠️⚠️ 用户指令（必须执行）⚠️⚠️⚠️');
          console.log('FEEDBACK:');
          console.log('-'.repeat(30));
          console.log(feedback);
          console.log('-'.repeat(30));
          console.log('');
          console.log('你必须按照上面FEEDBACK中的用户指令执行任务！');
        } else {
          console.log('FEEDBACK: (无)');
        }
        
        if (response.images && response.images.length > 0) {
          console.log('IMAGES:', response.images.join(','));
        }
        console.log('='.repeat(50));
        
        // 清理文件
        try {
          fs.unlinkSync(responseFile);
          fs.unlinkSync(requestFile);
        } catch (e) { /* 忽略清理错误 */ }
        
        process.exit(0);
      }
    }
  } catch (e) {
    // 文件可能还在写入中，继续等待
  }
  
  if (waited >= POLL_CONFIG.MAX_WAIT) {
    console.log('ACTION: timeout');
    console.log('FEEDBACK: No response received within 1 hour');
    process.exit(1);
  }
  
  setTimeout(checkResponse, POLL_CONFIG.POLL_INTERVAL);
};

// 开始轮询
setTimeout(checkResponse, POLL_CONFIG.POLL_INTERVAL);

// 通知手机端（如果远程服务开启）
function notifyMobile(message, sessionKey) {
  try {
    // 读取远程服务配置
    const remoteEnabledFile = path.join(ranjinDir, 'remote_enabled.txt');
    const portFile = path.join(ranjinDir, 'remote_port.txt');
    const apiKeyFile = path.join(ranjinDir, `remote_apikey_${sessionKey}.txt`);
    
    // 检查远程服务是否开启
    if (!fs.existsSync(remoteEnabledFile)) {
      console.log('[dialog-trigger] 远程服务未启用（文件不存在）');
      return;
    }
    if (fs.readFileSync(remoteEnabledFile, 'utf8').trim() !== '1') {
      console.log('[dialog-trigger] 远程服务未启用（值为0）');
      return;
    }
    
    // 获取端口
    let port = 3000;
    if (fs.existsSync(portFile)) {
      port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10) || 3000;
    }
    
    // 获取 API Key
    let apiKey = '';
    if (fs.existsSync(apiKeyFile)) {
      apiKey = fs.readFileSync(apiKeyFile, 'utf8').trim();
    }
    
    if (!apiKey) {
      // 尝试通用 API Key
      const defaultKeyFile = path.join(ranjinDir, 'remote_apikey.txt');
      if (fs.existsSync(defaultKeyFile)) {
        apiKey = fs.readFileSync(defaultKeyFile, 'utf8').trim();
      }
    }
    
    if (!apiKey) {
      console.log('[dialog-trigger] 未找到 API Key，无法通知手机端');
      return;
    }
    
    // 发送通知（包含完整上下文信息）
    const postData = JSON.stringify({ 
      message, 
      waiting: true,
      // 附加上下文信息
      context: {
        ide: ide,
        projectId: projectId,
        sessionKey: sessionKey,
        requestId: requestId,
        timestamp: Date.now(),
        source: 'dialog-trigger'
      }
    });
    
    console.log(`[dialog-trigger] 尝试通知手机端: http://127.0.0.1:${port}/api/notify`);
    
    const req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: '/api/notify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'X-API-Key': apiKey
      },
      timeout: POLL_CONFIG.NOTIFY_TIMEOUT
    }, (res) => {
      let responseData = '';
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(`[dialog-trigger] ✅ 手机端通知成功 (${res.statusCode}): ${responseData}`);
        } else {
          console.log(`[dialog-trigger] ⚠️ 手机端通知失败 (${res.statusCode}): ${responseData}`);
        }
      });
    });
    
    req.on('error', (err) => {
      console.log(`[dialog-trigger] ❌ 手机端通知错误: ${err.message}`);
    });
    
    req.write(postData);
    req.end();
  } catch (e) {
    // 忽略通知错误，不影响主流程
    console.log('[dialog-trigger] 通知处理异常:', e.message);
  }
}
