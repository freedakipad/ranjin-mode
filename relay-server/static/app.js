/**
 * IDE Remote Chat - 前端应用（优化版）
 * 
 * 手机端远程控制 IDE 的 Web 界面
 */

class IDERemoteChat {
    constructor() {
        // 状态
        this.apiKey = localStorage.getItem('apiKey') || '';
        this.sessionKey = localStorage.getItem('sessionKey') || '';
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 2000;
        this.isThinking = false;
        this.ideWaiting = false;
        this.ideSummary = '';
        this.statusCheckInterval = null;
        this.ideType = 'ide';
        this.ideName = 'IDE';
        this.isAtBottom = true;
        this.unreadCount = 0;
        
        // 从 URL 参数读取 session
        const urlParams = new URLSearchParams(location.search);
        if (urlParams.get('session')) {
            this.sessionKey = urlParams.get('session');
            localStorage.setItem('sessionKey', this.sessionKey);
        }
        
        // 配置
        this.config = {
            statusCheckInterval: 3000,
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
        
        if (this.apiKey && this.sessionKey) {
            this.hideApiKeyModal();
            this.connect();
        } else if (this.apiKey) {
            this.hideApiKeyModal();
            this.fetchAndSelectSession();
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
            apiKeySubmit: document.getElementById('apiKeySubmit'),
            sessionModal: document.getElementById('sessionModal'),
            sessionList: document.getElementById('sessionList'),
            sessionRefresh: document.getElementById('sessionRefresh'),
            toast: document.getElementById('toast'),
            logoText: document.getElementById('logoText'),
            logoSession: document.getElementById('logoSession'),
            waitingBanner: document.getElementById('waitingBanner'),
            waitingSummary: document.getElementById('waitingSummary'),
            scrollBottomBtn: document.getElementById('scrollBottomBtn'),
            newMsgBadge: document.getElementById('newMsgBadge')
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
        
        // Session 刷新
        if (this.elements.sessionRefresh) {
            this.elements.sessionRefresh.addEventListener('click', () => this.fetchSessions());
        }
        
        // 滚动检测
        this.elements.chatContainer.addEventListener('scroll', () => {
            this.checkScrollPosition();
        });
        
        // 页面可见性变化时重连
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                if (this.ws?.readyState !== WebSocket.OPEN) {
                    this.reconnectAttempts = 0;
                    this.connect();
                }
                this.checkIDEStatus();
            }
        });
    }
    
    // ============================================
    // 滚动管理
    // ============================================
    
    checkScrollPosition() {
        const el = this.elements.chatContainer;
        const threshold = 100;
        this.isAtBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < threshold;
        
        if (this.isAtBottom) {
            this.unreadCount = 0;
            this.hideScrollButton();
        } else {
            this.showScrollButton();
        }
    }
    
    showScrollButton() {
        this.elements.scrollBottomBtn?.classList.remove('hidden');
        if (this.unreadCount > 0 && this.elements.newMsgBadge) {
            this.elements.newMsgBadge.textContent = `${this.unreadCount} 条新消息`;
            this.elements.newMsgBadge.classList.remove('hidden');
        }
    }
    
    hideScrollButton() {
        this.elements.scrollBottomBtn?.classList.add('hidden');
        this.elements.newMsgBadge?.classList.add('hidden');
    }
    
    // ============================================
    // API Key 管理
    // ============================================
    
    showApiKeyModal() {
        this.elements.apiKeyModal.classList.remove('hidden');
        setTimeout(() => this.elements.apiKeyInput.focus(), 300);
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
            this.fetchAndSelectSession();
        }
    }
    
    // ============================================
    // Session 管理
    // ============================================
    
    async fetchAndSelectSession() {
        const sessions = await this.fetchSessions();
        if (!sessions) return;
        
        // 如果只有一个有 IDE 连接的会话，自动选择
        const activeSessions = sessions.filter(s => s.ideConnected);
        if (activeSessions.length === 1) {
            this.selectSession(activeSessions[0].sessionKey);
            return;
        }
        
        // 显示选择界面
        this.showSessionModal();
    }
    
    async fetchSessions() {
        try {
            const resp = await fetch('/api/sessions', {
                headers: { 'X-API-Key': this.apiKey }
            });
            if (resp.status === 401) {
                this.showToast('API Key 无效', 'error');
                this.apiKey = '';
                localStorage.removeItem('apiKey');
                this.showApiKeyModal();
                return null;
            }
            const data = await resp.json();
            this.renderSessionList(data.sessions || []);
            return data.sessions || [];
        } catch (e) {
            console.error('[会话] 获取失败:', e);
            this.showToast('无法连接服务器', 'error');
            return null;
        }
    }
    
    renderSessionList(sessions) {
        if (!this.elements.sessionList) return;
        
        if (sessions.length === 0) {
            this.elements.sessionList.innerHTML = `
                <div class="session-loading">
                    <svg class="icon" style="width:36px;height:36px;color:var(--text-muted)"><use href="#icon-plug"/></svg>
                    <div style="font-size: 14px; font-weight: 500;">暂无 IDE 会话</div>
                    <div style="font-size: 12px; color: var(--text-muted);">请确保 Cursor / IDE 已启用中继服务连接</div>
                </div>
            `;
            return;
        }
        
        this.elements.sessionList.innerHTML = sessions.map(s => {
            const statusBadge = s.ideConnected 
                ? (s.ideWaiting 
                    ? '<span class="session-badge waiting"><svg class="icon icon-sm"><use href="#icon-clock"/></svg> 等待输入</span>' 
                    : '<span class="session-badge online"><svg class="icon icon-sm"><use href="#icon-check-circle"/></svg> 在线</span>')
                : '<span class="session-badge offline"><svg class="icon icon-sm"><use href="#icon-alert-circle"/></svg> 离线</span>';
            
            const timeAgo = this.timeAgo(s.lastActivity);
            
            return `
                <div class="session-item ${s.ideConnected ? 'active' : ''}" 
                     onclick="window.app.selectSession('${s.sessionKey}')">
                    <div class="session-name">
                        ${statusBadge}
                        <span>${s.ideName || 'IDE'}</span>
                    </div>
                    <div class="session-info">
                        ${s.sessionKey}
                        ${s.historyCount > 0 ? ` · ${s.historyCount} 条消息` : ''}
                        ${timeAgo ? ` · ${timeAgo}` : ''}
                    </div>
                    ${s.ideSummary ? `<div class="session-info" style="margin-top: 4px; color: var(--text-secondary);">${this.truncate(s.ideSummary, 60)}</div>` : ''}
                </div>
            `;
        }).join('');
    }
    
    selectSession(sessionKey) {
        this.sessionKey = sessionKey;
        localStorage.setItem('sessionKey', sessionKey);
        this.hideSessionModal();
        
        // 断开旧连接
        if (this.ws) {
            try { this.ws.close(); } catch(e) {}
            this.ws = null;
        }
        
        // 清空旧消息
        this.elements.messages.innerHTML = '';
        this.elements.welcomeScreen.classList.remove('hidden');
        
        this.showToast(`已连接 ${sessionKey}`);
        this.updateLogoInfo();
        this.connect();
    }
    
    switchSession() {
        this.fetchAndSelectSession();
    }
    
    showSessionModal() {
        if (this.elements.sessionModal) {
            this.elements.sessionModal.classList.remove('hidden');
        }
    }
    
    hideSessionModal() {
        if (this.elements.sessionModal) {
            this.elements.sessionModal.classList.add('hidden');
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
        if (this.ws) {
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                return;
            }
            try { this.ws.close(); } catch (e) {}
            this.ws = null;
        }
        
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const sessionKey = this.sessionKey || 'default';
        const wsUrl = `${protocol}//${location.host}?apiKey=${encodeURIComponent(this.apiKey)}&type=mobile&sessionKey=${encodeURIComponent(sessionKey)}`;
        
        this.updateStatus('connecting');
        
        try {
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                console.log('[WS] 已连接');
                this.updateStatus('connected');
                this.reconnectAttempts = 0;
                this.updateLogoInfo();
            };
            
            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleMessage(data);
                } catch (e) {
                    console.error('[WS] 消息解析失败:', e);
                }
            };
            
            this.ws.onclose = (event) => {
                console.log('[WS] 断开:', event.code);
                this.updateStatus('disconnected');
                this.ws = null;
                if (event.code !== 1000) {
                    this.tryReconnect();
                }
            };
            
            this.ws.onerror = () => {
                this.updateStatus('disconnected');
            };
        } catch (e) {
            console.error('[WS] 创建失败:', e);
            this.updateStatus('disconnected');
            this.tryReconnect();
        }
    }
    
    tryReconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
            console.log(`[WS] ${Math.round(delay/1000)}s 后重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            this.reconnectTimer = setTimeout(() => this.connectWebSocket(), delay);
        } else {
            // 1 分钟后重置重连
            setTimeout(() => {
                this.reconnectAttempts = 0;
                this.connectWebSocket();
            }, 60000);
        }
    }
    
    startStatusCheck() {
        this.checkIDEStatus();
        if (this.statusCheckInterval) clearInterval(this.statusCheckInterval);
        this.statusCheckInterval = setInterval(
            () => this.checkIDEStatus(),
            this.config.statusCheckInterval
        );
    }
    
    async checkIDEStatus() {
        try {
            const sessionKey = this.sessionKey || 'default';
            const response = await fetch(`/api/cursor-status?sessionKey=${encodeURIComponent(sessionKey)}`, {
                headers: { 'X-API-Key': this.apiKey }
            });
            
            if (response.ok) {
                const data = await response.json();
                const wasWaiting = this.ideWaiting;
                this.ideWaiting = data.waiting;
                this.ideSummary = data.summary || '';
                
                if (data.ideType) {
                    this.ideType = data.ideType;
                    this.ideName = this.getIDEName(data.ideType);
                }
                
                this.updateIDEStatus(data.waiting, data.summary);
                this.updateWaitingBanner(data.waiting, data.summary);
                
                // 新的等待状态：振动提示
                if (data.waiting && !wasWaiting && navigator.vibrate) {
                    navigator.vibrate([100, 50, 100]);
                }
            } else if (response.status === 401) {
                this.updateIDEStatusError('未授权');
            }
        } catch (e) {
            // 静默处理，不频繁报错
        }
    }
    
    getIDEName(ideType) {
        const names = { 'cursor': 'Cursor', 'windsurf': 'Windsurf', 'vscode': 'VS Code' };
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
                break; // 已在发送时添加
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
                    this.updateWaitingBanner(data.data.waiting, data.data.summary);
                    if (data.data.ideType) {
                        this.ideType = data.data.ideType;
                        this.ideName = data.data.ideName || this.getIDEName(data.data.ideType);
                    }
                }
                break;
            case 'message_sent':
                this.hideThinking();
                if (data.data) {
                    this.showToast('指令已发送');
                }
                break;
            case 'message_failed':
                this.hideThinking();
                if (data.data) {
                    this.addMessage('assistant', `发送失败: ${data.data.error}`);
                }
                break;
            case 'error':
                this.hideThinking();
                this.addMessage('assistant', `错误: ${data.message || '未知错误'}`);
                break;
        }
    }
    
    handleInit(data) {
        if (data?.ideType) {
            this.ideType = data.ideType;
            this.ideName = data.ideName || this.getIDEName(data.ideType);
            this.updateLogoInfo();
        }
        
        if (data?.history?.length > 0) {
            this.elements.welcomeScreen.classList.add('hidden');
            data.history.forEach(msg => {
                this.addMessage(msg.role, msg.content, msg.timestamp, false);
            });
            this.scrollToBottom();
        }
        
        // 初始等待状态
        if (data?.ideWaiting) {
            this.ideWaiting = true;
            this.updateIDEStatus(true, data.ideSummary);
            this.updateWaitingBanner(true, data.ideSummary);
        }
    }
    
    handleIDEMessage(data) {
        this.hideThinking();
        
        if (data?.summary) {
            this.elements.welcomeScreen.classList.add('hidden');
            const ideName = data.ideName || this.getIDEName(data.ideType) || this.ideName;
            this.addMessage('assistant', `**${ideName}**: ${data.summary}`, data.timestamp);
            this.ideWaiting = data.waiting;
            this.updateIDEStatus(data.waiting, data.summary);
            this.updateWaitingBanner(data.waiting, data.summary);
        }
    }
    
    // ============================================
    // 发送消息
    // ============================================
    
    async sendMessage() {
        const content = this.elements.messageInput.value.trim();
        if (!content || this.isThinking) return;
        
        this.elements.welcomeScreen.classList.add('hidden');
        this.addMessage('user', content);
        this.elements.messageInput.value = '';
        this.updateCharCount();
        this.autoResize();
        this.updateSendButton();
        this.showThinking();
        
        try {
            const sessionKey = this.sessionKey || 'default';
            const response = await fetch('/api/message', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': this.apiKey,
                    'X-Session-Key': sessionKey
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
            
            this.hideThinking();
            this.addMessage('system', `指令已发送到 ${this.ideName}，等待响应...`);
            
            setTimeout(() => this.checkIDEStatus(), 500);
            
        } catch (error) {
            this.hideThinking();
            this.addMessage('assistant', `发送失败: ${error.message}`);
        }
    }
    
    handleAuthError() {
        this.hideThinking();
        this.apiKey = '';
        this.sessionKey = '';
        localStorage.removeItem('apiKey');
        localStorage.removeItem('sessionKey');
        this.showApiKeyModal();
        this.showToast('请重新输入 API Key', 'error');
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
        
        messageDiv.appendChild(contentDiv);
        
        // 系统消息不显示时间
        if (role !== 'system') {
            const timeDiv = document.createElement('div');
            timeDiv.className = 'message-time';
            timeDiv.textContent = this.formatTime(timestamp);
            messageDiv.appendChild(timeDiv);
        }
        
        // 长按复制
        let pressTimer = null;
        messageDiv.addEventListener('touchstart', () => {
            pressTimer = setTimeout(() => {
                this.copyToClipboard(content);
                this.showToast('已复制到剪贴板');
            }, 600);
        });
        messageDiv.addEventListener('touchend', () => clearTimeout(pressTimer));
        messageDiv.addEventListener('touchmove', () => clearTimeout(pressTimer));
        
        this.elements.messages.appendChild(messageDiv);
        
        if (scroll && this.isAtBottom) {
            this.scrollToBottom();
        } else if (scroll && !this.isAtBottom) {
            this.unreadCount++;
            this.showScrollButton();
        }
    }
    
    formatContent(content) {
        if (!content) return '';
        
        let html = content
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        
        // 代码块
        html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
            const safeLang = (lang || 'text').replace(/[^a-zA-Z0-9]/g, '');
            return `<pre><code class="language-${safeLang}">${code.trim()}</code></pre>`;
        });
        
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        
        // 安全链接
        html = html.replace(/(https?:\/\/[^\s<]+)/g, (match) => {
            try {
                const url = new URL(match);
                if (url.protocol === 'http:' || url.protocol === 'https:') {
                    return `<a href="${encodeURI(decodeURI(match))}" target="_blank" rel="noopener">${match}</a>`;
                }
            } catch (e) {}
            return match;
        });
        
        html = html.replace(/\n/g, '<br>');
        return html;
    }
    
    formatTime(timestamp) {
        const date = timestamp ? new Date(timestamp) : new Date();
        return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    
    async copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
        } catch (e) {
            // fallback
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.cssText = 'position:fixed;left:-999px';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        }
    }
    
    // ============================================
    // 历史管理
    // ============================================
    
    async clearHistory() {
        try {
            const sessionKey = this.sessionKey || 'default';
            const response = await fetch('/api/history', {
                method: 'DELETE',
                headers: { 'X-API-Key': this.apiKey, 'X-Session-Key': sessionKey }
            });
            
            if (response.ok) {
                this.elements.messages.innerHTML = '';
                this.elements.welcomeScreen.classList.remove('hidden');
                this.showToast('对话已清空');
            }
        } catch (e) {
            this.showToast('清空失败', 'error');
        }
    }
    
    // ============================================
    // UI 更新
    // ============================================
    
    updateLogoInfo() {
        if (this.elements.logoText) {
            this.elements.logoText.textContent = `${this.ideName} Remote`;
        }
        if (this.elements.logoSession && this.sessionKey) {
            this.elements.logoSession.textContent = this.sessionKey;
        }
    }
    
    updateStatus(status) {
        const indicator = this.elements.statusIndicator;
        if (!indicator) return;
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
        
        const textEl = statusEl.querySelector('.ide-text');
        if (!textEl) return;
        
        statusEl.classList.remove('waiting', 'idle', 'error');
        
        if (waiting) {
            statusEl.classList.add('waiting');
            textEl.textContent = '等待输入';
        } else {
            statusEl.classList.add('idle');
            textEl.textContent = '就绪';
        }
    }
    
    updateIDEStatusError(errorText) {
        const statusEl = this.elements.ideStatus;
        if (!statusEl) return;
        const textEl = statusEl.querySelector('.ide-text');
        if (!textEl) return;
        
        statusEl.classList.remove('waiting', 'idle');
        statusEl.classList.add('error');
        textEl.textContent = errorText;
    }
    
    updateWaitingBanner(waiting, summary) {
        const banner = this.elements.waitingBanner;
        if (!banner) return;
        
        if (waiting) {
            banner.classList.remove('hidden');
            if (this.elements.waitingSummary) {
                this.elements.waitingSummary.textContent = summary ? this.truncate(summary, 80) : '';
            }
        } else {
            banner.classList.add('hidden');
        }
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
    
    showToast(message, type = 'success') {
        const container = this.elements.toast;
        if (!container) return;
        
        const toast = document.createElement('div');
        toast.className = 'toast-item';
        toast.textContent = message;
        
        if (type === 'error') {
            toast.style.borderColor = 'rgba(248, 113, 113, 0.3)';
        }
        
        container.innerHTML = '';
        container.appendChild(toast);
        
        setTimeout(() => {
            toast.style.animation = 'toastOut 0.3s ease-out forwards';
            setTimeout(() => toast.remove(), 300);
        }, 2500);
    }
    
    updateCharCount() {
        const count = this.elements.messageInput.value.length;
        const max = this.config.maxMessageLength;
        this.elements.charCount.textContent = `${count} / ${max}`;
        this.elements.charCount.style.color = count > max * 0.9 ? 'var(--error)' : '';
    }
    
    updateSendButton() {
        const hasContent = this.elements.messageInput.value.trim().length > 0;
        this.elements.sendButton.disabled = !hasContent || this.isThinking;
    }
    
    autoResize() {
        const textarea = this.elements.messageInput;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 100) + 'px';
    }
    
    scrollToBottom() {
        requestAnimationFrame(() => {
            const el = this.elements.chatContainer;
            el.scrollTop = el.scrollHeight;
            this.isAtBottom = true;
            this.hideScrollButton();
        });
    }
    
    // ============================================
    // 工具方法
    // ============================================
    
    truncate(str, maxLen) {
        if (!str) return '';
        return str.length > maxLen ? str.substring(0, maxLen) + '...' : str;
    }
    
    timeAgo(dateStr) {
        if (!dateStr) return '';
        const now = Date.now();
        const then = new Date(dateStr).getTime();
        const diff = Math.floor((now - then) / 1000);
        
        if (diff < 60) return '刚刚';
        if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
        if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
        return `${Math.floor(diff / 86400)} 天前`;
    }
}

// 启动
document.addEventListener('DOMContentLoaded', () => {
    window.app = new IDERemoteChat();
});
