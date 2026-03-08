/**
 * IDE Remote Chat - 前端应用
 * 
 * 手机端远程控制 IDE 的 Web 界面
 */

class IDERemoteChat {
    constructor() {
        // 状态
        this.apiKey = localStorage.getItem('apiKey') || '';
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 2000;
        this.isThinking = false;
        this.ideWaiting = false;
        this.ideSummary = '';
        this.statusCheckInterval = null;
        this.ideType = 'ide'; // 默认值，会在 init 时更新
        this.ideName = 'IDE'; // 默认值，会在 init 时更新
        
        // 配置
        this.config = {
            statusCheckInterval: 2000,
            maxMessageLength: 4000,
            autoScrollDelay: 50
        };
        
        this.init();
    }
    
    // ============================================
    // 初始化
    // ============================================
    
    init() {
        this.cacheElements();
        this.bindEvents();
        
        if (this.apiKey) {
            this.hideApiKeyModal();
            this.connect();
        } else {
            this.showApiKeyModal();
        }
    }
    
    cacheElements() {
        this.elements = {
            chatContainer: document.getElementById('chatContainer'),
            messages: document.getElementById('messages'),
            welcomeScreen: document.getElementById('welcomeScreen'),
            messageInput: document.getElementById('messageInput'),
            sendButton: document.getElementById('sendButton'),
            clearButton: document.getElementById('clearButton'),
            statusIndicator: document.getElementById('statusIndicator'),
            ideStatus: document.getElementById('ideStatus'),
            thinkingIndicator: document.getElementById('thinkingIndicator'),
            charCount: document.getElementById('charCount'),
            apiKeyModal: document.getElementById('apiKeyModal'),
            apiKeyInput: document.getElementById('apiKeyInput'),
            apiKeySubmit: document.getElementById('apiKeySubmit')
        };
    }
    
    bindEvents() {
        // 发送
        this.elements.sendButton.addEventListener('click', () => this.sendMessage());
        
        // 输入框
        this.elements.messageInput.addEventListener('input', () => {
            this.updateCharCount();
            this.autoResize();
            this.updateSendButton();
        });
        
        this.elements.messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });
        
        // 清空
        this.elements.clearButton.addEventListener('click', () => {
            if (confirm('确定要清空所有对话吗？')) {
                this.clearHistory();
            }
        });
        
        // API Key
        this.elements.apiKeySubmit.addEventListener('click', () => this.submitApiKey());
        this.elements.apiKeyInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.submitApiKey();
        });
        
        // 页面可见性变化时重连
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && this.ws?.readyState !== WebSocket.OPEN) {
                this.connect();
            }
        });
    }
    
    // ============================================
    // API Key 管理
    // ============================================
    
    showApiKeyModal() {
        this.elements.apiKeyModal.classList.remove('hidden');
        this.elements.apiKeyInput.focus();
    }
    
    hideApiKeyModal() {
        this.elements.apiKeyModal.classList.add('hidden');
    }
    
    submitApiKey() {
        const key = this.elements.apiKeyInput.value.trim();
        if (key) {
            this.apiKey = key;
            localStorage.setItem('apiKey', key);
            this.hideApiKeyModal();
            this.connect();
        }
    }
    
    // ============================================
    // 连接管理
    // ============================================
    
    connect() {
        this.connectWebSocket();
        this.startStatusCheck();
    }
    
    connectWebSocket() {
        // 清理旧连接
        if (this.ws) {
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                return; // 已连接或正在连接
            }
            try { this.ws.close(); } catch (e) {}
            this.ws = null;
        }
        
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${location.host}?apiKey=${encodeURIComponent(this.apiKey)}`;
        
        this.updateStatus('connecting');
        console.log('[手机端] 正在连接 WebSocket:', wsUrl);
        
        try {
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                console.log('[手机端] WebSocket 已连接');
                this.updateStatus('connected');
                this.reconnectAttempts = 0;
                this.lastPong = Date.now();
            };
            
            this.ws.onmessage = (event) => {
                this.lastPong = Date.now(); // 收到任何消息都更新活动时间
                try {
                    const data = JSON.parse(event.data);
                    console.log('[手机端] 收到消息:', data.type);
                    this.handleMessage(data);
                } catch (e) {
                    console.error('[手机端] 消息解析失败:', e);
                }
            };
            
            this.ws.onclose = (event) => {
                console.log('[手机端] WebSocket 断开:', event.code, event.reason);
                this.updateStatus('disconnected');
                this.ws = null;
                this.tryReconnect();
            };
            
            this.ws.onerror = (error) => {
                console.error('[手机端] WebSocket 错误:', error);
                this.updateStatus('disconnected');
            };
        } catch (e) {
            console.error('[手机端] WebSocket 创建失败:', e);
            this.updateStatus('disconnected');
            this.tryReconnect();
        }
    }
    
    tryReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
        
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            // 指数退避，最大 30 秒
            const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
            console.log(`[手机端] ${delay}ms 后重连 (第 ${this.reconnectAttempts} 次)`);
            this.reconnectTimer = setTimeout(() => this.connectWebSocket(), delay);
        } else {
            console.log('[手机端] 达到最大重连次数，停止重连');
            // 60 秒后重置重连计数，允许再次尝试
            setTimeout(() => {
                this.reconnectAttempts = 0;
                this.connectWebSocket();
            }, 60000);
        }
    }
    
    startStatusCheck() {
        this.checkIDEStatus();
        
        if (this.statusCheckInterval) {
            clearInterval(this.statusCheckInterval);
        }
        
        this.statusCheckInterval = setInterval(
            () => this.checkIDEStatus(),
            this.config.statusCheckInterval
        );
    }
    
    async checkIDEStatus() {
        try {
            const response = await fetch('/api/cursor-status', {
                headers: { 'X-API-Key': this.apiKey }
            });
            
            if (response.ok) {
                const data = await response.json();
                this.ideWaiting = data.waiting;
                this.ideSummary = data.summary || '';
                
                // 更新 IDE 类型信息
                if (data.ideType) {
                    this.ideType = data.ideType;
                    this.ideName = this.getIDEName(data.ideType);
                    this.updateIDEInfo(this.ideName);
                }
                
                this.updateIDEStatus(data.waiting, data.summary);
            } else if (response.status === 401) {
                // 未授权，显示错误状态
                this.updateIDEStatusError('未授权');
            } else {
                // 其他错误
                this.updateIDEStatusError('请求失败');
            }
        } catch (e) {
            // 网络错误，显示离线状态
            this.updateIDEStatusError('连接失败');
        }
    }
    
    // 获取 IDE 显示名称
    getIDEName(ideType) {
        const names = {
            'cursor': 'Cursor',
            'windsurf': 'Windsurf',
            'vscode': 'VS Code',
            'ide': 'IDE'
        };
        return names[ideType] || 'IDE';
    }
    
    // ============================================
    // 消息处理
    // ============================================
    
    handleMessage(data) {
        switch (data.type) {
            case 'init':
                this.handleInit(data.data);
                break;
                
            case 'user_message':
                // 已在发送时添加，忽略
                break;
                
            case 'response':
                this.hideThinking();
                if (data.data?.content) {
                    this.addMessage('assistant', data.data.content, data.data.timestamp);
                }
                break;
                
            case 'cursor_message':
                this.handleIDEMessage(data.data);
                break;
                
            case 'status_update':
                if (data.data) {
                    this.ideWaiting = data.data.waiting;
                    this.updateIDEStatus(data.data.waiting, data.data.summary);
                    
                    // 更新 IDE 类型
                    if (data.data.ideType) {
                        this.ideType = data.data.ideType;
                        this.ideName = data.data.ideName || this.getIDEName(data.data.ideType);
                    }
                }
                break;
                
            case 'message_sent':
                this.hideThinking();
                if (data.data) {
                    console.log(`[手机端] 消息已发送到 ${this.ideName}`);
                    this.showToast('✅ 指令已发送');
                }
                break;
                
            case 'message_failed':
                this.hideThinking();
                if (data.data) {
                    console.error(`[手机端] 消息发送失败: ${data.data.error}`);
                    this.addMessage('assistant', `❌ 发送失败: ${data.data.error}`);
                }
                break;
                
            case 'error':
                this.hideThinking();
                this.addMessage('assistant', `❌ 错误: ${data.message || '未知错误'}`);
                break;
        }
    }
    
    handleInit(data) {
        // 更新 IDE 信息
        if (data?.ideType) {
            this.ideType = data.ideType;
            this.ideName = data.ideName || this.getIDEName(data.ideType);
            this.updateIDEInfo(this.ideName);
        }
        
        // 加载历史记录
        if (data?.history?.length > 0) {
            this.elements.welcomeScreen.classList.add('hidden');
            data.history.forEach(msg => {
                this.addMessage(msg.role, msg.content, msg.timestamp, false);
            });
            this.scrollToBottom();
        }
    }
    
    updateIDEInfo(ideName) {
        // 更新页面标题
        document.title = `${ideName} 远程对话`;
        
        // 更新 Logo 文本
        const logoText = document.querySelector('.logo-text');
        if (logoText) {
            logoText.textContent = `${ideName} Remote`;
        }
        
        // 更新欢迎文本
        const welcomeTitle = document.querySelector('.welcome-screen h2');
        if (welcomeTitle) {
            welcomeTitle.textContent = `欢迎使用 ${ideName} 远程对话`;
        }
        
        const welcomeDesc = document.querySelector('.welcome-screen p');
        if (welcomeDesc) {
            welcomeDesc.textContent = `在下方输入消息，${ideName} 会在电脑端处理并返回结果`;
        }
        
        // 更新提示文本
        const tips = document.querySelectorAll('.tip');
        tips.forEach(tip => {
            tip.textContent = tip.textContent.replace(/Cursor|IDE|Windsurf/g, ideName);
        });
    }
    
    handleIDEMessage(data) {
        console.log('[手机端] 收到 IDE 消息:', data);
        this.hideThinking();
        
        if (data?.summary) {
            this.elements.welcomeScreen.classList.add('hidden');
            const ideName = data.ideName || this.getIDEName(data.ideType) || this.ideName;
            this.addMessage('assistant', `🖥️ **${ideName}**: ${data.summary}`, data.timestamp);
            this.ideWaiting = data.waiting;
            this.updateIDEStatus(data.waiting, data.summary);
            this.scrollToBottom();
        } else {
            console.warn('[手机端] IDE 消息格式错误:', data);
        }
    }
    
    // ============================================
    // 发送消息
    // ============================================
    
    async sendMessage() {
        const content = this.elements.messageInput.value.trim();
        
        if (!content || this.isThinking) return;
        
        // UI 更新
        this.elements.welcomeScreen.classList.add('hidden');
        this.addMessage('user', content);
        this.elements.messageInput.value = '';
        this.updateCharCount();
        this.autoResize();
        this.updateSendButton();
        this.showThinking();
        
        try {
            const response = await fetch('/api/message', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': this.apiKey
                },
                body: JSON.stringify({ message: content })
            });
            
            if (!response.ok) {
                if (response.status === 401) {
                    this.handleAuthError();
                    return;
                }
                throw new Error(`请求失败 (${response.status})`);
            }
            
            await response.json(); // 确认响应成功
            this.addMessage('assistant', `✅ 指令已发送，等待 ${this.ideName} 响应...`);
            this.hideThinking();
            
            // 延迟刷新状态
            setTimeout(() => this.checkIDEStatus(), 500);
            
        } catch (error) {
            this.hideThinking();
            this.addMessage('assistant', `❌ 发送失败: ${error.message}`);
        }
    }
    
    handleAuthError() {
        this.hideThinking();
        this.apiKey = '';
        localStorage.removeItem('apiKey');
        this.showApiKeyModal();
    }
    
    // ============================================
    // 消息渲染
    // ============================================
    
    addMessage(role, content, timestamp = null, scroll = true) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}`;
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        contentDiv.innerHTML = this.formatContent(content);
        
        const timeDiv = document.createElement('div');
        timeDiv.className = 'message-time';
        timeDiv.textContent = this.formatTime(timestamp);
        
        messageDiv.appendChild(contentDiv);
        messageDiv.appendChild(timeDiv);
        this.elements.messages.appendChild(messageDiv);
        
        if (scroll) {
            this.scrollToBottom();
        }
    }
    
    formatContent(content) {
        if (!content) return '';
        
        // HTML 转义
        let html = content
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        
        // 代码块（安全处理语言标识符，只允许字母数字）
        html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
            const safeLang = (lang || 'text').replace(/[^a-zA-Z0-9]/g, '');
            return `<pre><code class="language-${safeLang}">${code.trim()}</code></pre>`;
        });
        
        // 行内代码
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        
        // 粗体
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        
        // 链接 - 安全验证 URL
        html = html.replace(
            /(https?:\/\/[^\s<]+)/g,
            (match) => {
                try {
                    const url = new URL(match);
                    // 只允许 http 和 https 协议
                    if (url.protocol === 'http:' || url.protocol === 'https:') {
                        const safeUrl = encodeURI(decodeURI(match));
                        return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${match}</a>`;
                    }
                } catch (e) {
                    // URL 解析失败，返回原文本
                }
                return match;
            }
        );
        
        // 换行
        html = html.replace(/\n/g, '<br>');
        
        return html;
    }
    
    formatTime(timestamp) {
        const date = timestamp ? new Date(timestamp) : new Date();
        return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    
    // ============================================
    // 历史管理
    // ============================================
    
    async clearHistory() {
        try {
            const response = await fetch('/api/history', {
                method: 'DELETE',
                headers: { 'X-API-Key': this.apiKey }
            });
            
            if (response.ok) {
                this.elements.messages.innerHTML = '';
                this.elements.welcomeScreen.classList.remove('hidden');
            }
        } catch (e) {
            console.error('清空历史失败:', e);
        }
    }
    
    // ============================================
    // UI 更新
    // ============================================
    
    updateStatus(status) {
        const indicator = this.elements.statusIndicator;
        const textEl = indicator.querySelector('.status-text');
        
        indicator.classList.remove('connected', 'disconnected');
        
        const statusMap = {
            connected: { class: 'connected', text: '已连接' },
            disconnected: { class: 'disconnected', text: '未连接' },
            connecting: { class: '', text: '连接中...' }
        };
        
        const config = statusMap[status] || statusMap.connecting;
        if (config.class) indicator.classList.add(config.class);
        textEl.textContent = config.text;
    }
    
    updateIDEStatus(waiting, summary) {
        const statusEl = this.elements.ideStatus;
        if (!statusEl) return;
        
        const textEl = statusEl.querySelector('.cursor-text');
        if (!textEl) return;
        
        statusEl.classList.remove('waiting', 'idle', 'error');
        
        if (waiting) {
            statusEl.classList.add('waiting');
            textEl.textContent = '等待输入';
            textEl.title = summary || `${this.ideName} AI 正在等待您的指令`;
        } else {
            statusEl.classList.add('idle');
            textEl.textContent = '可发送';
            textEl.title = `指令会发送到 ${this.ideName}`;
        }
    }
    
    updateIDEStatusError(errorText) {
        const statusEl = this.elements.ideStatus;
        if (!statusEl) return;
        
        const textEl = statusEl.querySelector('.cursor-text');
        if (!textEl) return;
        
        statusEl.classList.remove('waiting', 'idle');
        statusEl.classList.add('error');
        textEl.textContent = errorText;
        textEl.title = `状态检查失败: ${errorText}`;
    }
    
    showThinking() {
        this.isThinking = true;
        this.elements.thinkingIndicator.style.display = 'block';
        this.elements.sendButton.disabled = true;
        this.scrollToBottom();
    }
    
    hideThinking() {
        this.isThinking = false;
        this.elements.thinkingIndicator.style.display = 'none';
        this.updateSendButton();
    }
    
    // 显示 Toast 提示
    showToast(message, duration = 2000) {
        const existingToast = document.querySelector('.toast');
        if (existingToast) {
            existingToast.remove();
        }
        
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed;
            bottom: 100px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(34, 212, 136, 0.9);
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            z-index: 10000;
            animation: toastIn 0.3s ease-out;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        `;
        
        document.body.appendChild(toast);
        
        setTimeout(() => {
            toast.style.animation = 'toastOut 0.3s ease-out forwards';
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }
    
    updateCharCount() {
        const count = this.elements.messageInput.value.length;
        const max = this.config.maxMessageLength;
        this.elements.charCount.textContent = `${count} / ${max}`;
        this.elements.charCount.style.color = count > max * 0.9 ? 'var(--error)' : 'var(--text-secondary)';
    }
    
    updateSendButton() {
        const hasContent = this.elements.messageInput.value.trim().length > 0;
        this.elements.sendButton.disabled = !hasContent || this.isThinking;
    }
    
    autoResize() {
        const textarea = this.elements.messageInput;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }
    
    scrollToBottom() {
        requestAnimationFrame(() => {
            this.elements.chatContainer.scrollTop = this.elements.chatContainer.scrollHeight;
        });
    }
}

// 启动
document.addEventListener('DOMContentLoaded', () => {
    window.app = new IDERemoteChat();
});
