/**
 * StoryForgeAI - 小说AI写作软件 前端逻辑
 */

(function () {
    'use strict';

    // ==================== State ====================
    // Coze 平台参数类型
    const PARAM_TYPES = [
        { value: 'String', label: 'String 字符串' },
        { value: 'Integer', label: 'Integer 整数' },
        { value: 'Number', label: 'Number 数值' },
        { value: 'Boolean', label: 'Boolean 布尔' },
        { value: 'Time', label: 'Time 时间' },
        { value: 'Object', label: 'Object 对象' },
        { value: 'Array', label: 'Array 数组' },
        { value: 'File', label: 'File 文件' }
    ];

    const state = {
        currentView: 'home',       // home | work | admin
        currentWorkId: null,
        currentWork: null,
        works: [],
        adminToken: '',               // 内存态（不落 sessionStorage，避免明文 Token 持久化）
        accessTokens: {},          // { workId: token }
        conversationId: null,
        isStreaming: false,
        uploadedFile: null,        // { file_id, file_name }
        mixedUploadedFile: null,
        pendingAccessWorkId: null,
        botList: [],
        datasetList: [],
        workflowList: [],
        cachedBots: [],
        cachedWorkflows: [],
        currentResourceTab: 'all',
        adminWorks: [],
        // 流式/请求取消控制：切换页面或页面卸载时 abort，避免竞态与泄漏
        streamController: null
    };

    // ==================== API ====================
    const api = {
        async request(url, options = {}) {
            const headers = { 'Content-Type': 'application/json', ...options.headers };
            try {
                const resp = await fetch(url, { ...options, headers });
                const data = await resp.json();
                if (!resp.ok || data.code !== 0) {
                    throw new Error(data.message || data.error || '请求失败');
                }
                return data.data;
            } catch (e) {
                throw e;
            }
        },

        // 原始 Response 请求（流式 / FormData / 非 JSON 响应专用）。
        // 统一网络错误处理；不强制 Content-Type（FormData 场景由浏览器自设）。
        // signal 可传入 AbortController 用于取消。
        async requestRaw(url, options = {}) {
            try {
                return await fetch(url, options);
            } catch (e) {
                throw new Error('网络请求失败: ' + (e.message || '请求失败'));
            }
        },

        // 公开 API
        getWorks: () => api.request('/api/works'),
        getWork: (id) => api.request(`/api/works/${id}`),
        verifyAccess: (id, code) => api.request(`/api/works/${id}/verify`, {
            method: 'POST',
            body: JSON.stringify({ access_code: code })
        }),

        // 管理员 API
        adminLogin: (password) => api.request('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({ password }),
            noAuth: true
        }),
        getConfig: () => api.request('/api/admin/config'),
        updateConfig: (data) => api.request('/api/admin/config', {
            method: 'PUT',
            body: JSON.stringify(data)
        }),
        testPat: (pat, workspaceId) => api.request('/api/admin/coze/test', {
            method: 'POST',
            body: JSON.stringify({ pat_token: pat, workspace_id: workspaceId || '' })
        }),
        getBots: (pat, workspaceId) => api.request('/api/admin/coze/bots', {
            method: 'POST',
            body: JSON.stringify({ pat_token: pat, workspace_id: workspaceId || '' })
        }),
        getDatasets: (pat) => api.request('/api/admin/coze/datasets', {
            method: 'POST',
            body: JSON.stringify({ pat_token: pat })
        }),
        getWorkflows: (pat, workspaceId) => api.request('/api/admin/coze/workflows', {
            method: 'POST',
            body: JSON.stringify({ pat_token: pat, workspace_id: workspaceId || '' })
        }),
        importWorks: (pat, botIds, accessCode, workspaceId) => api.request('/api/admin/works/import', {
            method: 'POST',
            body: JSON.stringify({ pat_token: pat, bot_ids: botIds, access_code: accessCode, workspace_id: workspaceId || '' })
        }),
        importDataset: (pat, datasetId, accessCode) => api.request('/api/admin/works/import-dataset', {
            method: 'POST',
            body: JSON.stringify({ pat_token: pat, dataset_id: datasetId, access_code: accessCode })
        }),
        importWorkflow: (pat, workflowId, workspaceId, accessCode) => api.request('/api/admin/works/import-workflow', {
            method: 'POST',
            body: JSON.stringify({ pat_token: pat, workflow_id: workflowId, workspace_id: workspaceId || '', access_code: accessCode })
        }),
        getAdminWorks: () => api.request('/api/admin/works'),
        updateWork: (id, data) => api.request(`/api/admin/works/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        }),
        deleteWork: (id) => api.request(`/api/admin/works/${id}`, { method: 'DELETE' }),
        refreshWork: (id) => api.request(`/api/admin/works/${id}/refresh`, { method: 'POST' }),

        // 体验者 API（需要 access token）
        async chat(workId, message, conversationId, parameters, signal) {
            const token = state.accessTokens[workId] || '';
            const resp = await api.requestRaw(`/api/works/${workId}/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Access-Token': token
                },
                body: JSON.stringify({
                    message: message,
                    conversation_id: conversationId || '',
                    parameters: parameters || {}
                }),
                signal: signal
            });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.message || data.error || '对话请求失败');
            }
            return resp;
        },

        async uploadFile(workId, file) {
            const token = state.accessTokens[workId] || '';
            const formData = new FormData();
            formData.append('file', file);
            const resp = await api.requestRaw(`/api/works/${workId}/upload`, {
                method: 'POST',
                headers: { 'X-Access-Code': token },
                body: formData
            });
            const data = await resp.json();
            if (!resp.ok || data.code !== 0) {
                throw new Error(data.message || data.error || '文件上传失败');
            }
            return data.data;
        }
    };

    // ==================== Router ====================
    function abortActiveStream() {
        if (state.streamController) {
            state.streamController.abort();
            state.streamController = null;
        }
    }

    function navigate(hash) {
        // 切换页面时取消进行中的流式请求，避免竞态
        abortActiveStream();
        if (hash.startsWith('#work/')) {
            const workId = hash.replace('#work/', '');
            openWork(workId);
        } else if (hash === '#admin') {
            showAdmin();
        } else {
            showHome();
        }
    }

    function showPage(pageId) {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const page = document.getElementById(pageId);
        if (page) page.classList.add('active');
    }

    // ==================== Home Page ====================
    async function showHome() {
        state.currentView = 'home';
        state.currentWorkId = null;
        showPage('page-home');
        window.location.hash = '';

        try {
            const data = await api.getWorks();
            state.works = data.works || [];
            renderWorksGrid();
        } catch (e) {
            showToast('加载作品列表失败: ' + e.message, 'error');
        }

        // 加载站点信息
        try {
            const config = await api.getConfig().catch(() => null);
            if (config) {
                document.getElementById('site-title').textContent = config.site_name || 'StoryForgeAI';
                document.getElementById('site-desc').textContent = config.site_description || 'AI 作品展示平台';
            }
        } catch (e) { /* ignore */ }
    }

    function renderWorksGrid() {
        const grid = document.getElementById('works-grid');
        const empty = document.getElementById('empty-state');

        if (state.works.length === 0) {
            grid.style.display = 'none';
            empty.style.display = 'flex';
            return;
        }

        grid.style.display = 'grid';
        empty.style.display = 'none';

        grid.innerHTML = escapeHtml('') + state.works.map(work => {
            const iconHtml = work.icon_url
                ? `<img class="work-card-icon" src="${escapeHtml(work.icon_url)}" alt="" onerror="this.outerHTML='<div class=\\'work-card-icon-placeholder\\'>AI</div>'">`
                : `<div class="work-card-icon-placeholder">AI</div>`;

            const typeMap = { chat: '对话', form: '表单', mixed: '混合' };
            const badgeClass = `badge badge-${work.interaction_type || 'chat'}`;
            const isWorkflow = work.coze_meta && work.coze_meta.type === 'workflow';
            const badgeText = isWorkflow ? '工作流' : (typeMap[work.interaction_type] || '对话');
            const badgeCls = isWorkflow ? 'badge badge-workflow' : badgeClass;

            return `
                <div class="work-card" data-work-id="${escapeHtml(work.id)}">
                    <div class="work-card-header">
                        ${iconHtml}
                        <span class="work-card-title">${escapeHtml(work.name)}</span>
                    </div>
                    <div class="work-card-desc">${escapeHtml(work.description || '暂无描述')}</div>
                    <div class="work-card-footer">
                        <span class="${badgeCls}">${badgeText}</span>
                        <span class="work-card-model">${escapeHtml(work.model_name || '')}</span>
                    </div>
                </div>
            `;
        }).join('');

        // 绑定点击事件
        grid.querySelectorAll('.work-card').forEach(card => {
            card.addEventListener('click', () => {
                const workId = card.dataset.workId;
                window.location.hash = `#work/${workId}`;
            });
        });
    }

    // ==================== Access Code Modal ====================
    function showAccessCodeModal(workId) {
        state.pendingAccessWorkId = workId;
        const modal = document.getElementById('modal-access-code');
        const input = document.getElementById('access-code-input');
        const error = document.getElementById('access-code-error');
        modal.style.display = 'flex';
        input.value = '';
        error.classList.remove('visible');
        error.textContent = '';
        setTimeout(() => input.focus(), 100);
    }

    function hideAccessCodeModal() {
        document.getElementById('modal-access-code').style.display = 'none';
        state.pendingAccessWorkId = null;
    }

    async function submitAccessCode() {
        const input = document.getElementById('access-code-input');
        const error = document.getElementById('access-code-error');
        const code = input.value.trim();
        const workId = state.pendingAccessWorkId;

        if (!code) {
            error.textContent = '请输入访问码';
            error.classList.add('visible');
            return;
        }

        try {
            const data = await api.verifyAccess(workId, code);
            if (data.success) {
                state.accessTokens[workId] = data.token;
                hideAccessCodeModal();
                window.location.hash = `#work/${workId}`;
            }
        } catch (e) {
            error.textContent = e.message;
            error.classList.add('visible');
        }
    }

    // ==================== Work Page ====================
    async function openWork(workId) {
        state.currentView = 'work';
        state.currentWorkId = workId;
        state.conversationId = null;
        state.isStreaming = false;
        state.uploadedFile = null;
        state.mixedUploadedFile = null;
        showPage('page-work');

        try {
            const work = await api.getWork(workId);
            state.currentWork = work;
            renderWorkPage(work);
            // 通知入口组件（角色版图/剧情树）当前作品已加载，可读取绑定的 project_id
            document.dispatchEvent(new CustomEvent('storyforge:work-loaded', {
                detail: { workId: workId, work: work }
            }));
        } catch (e) {
            showToast('加载作品失败: ' + e.message, 'error');
            showHome();
        }
    }

    function renderWorkPage(work) {
        // Header
        const icon = document.getElementById('work-icon');
        if (work.icon_url) {
            icon.src = work.icon_url;
            icon.style.display = 'block';
            icon.onerror = function () { this.style.display = 'none'; };
        } else {
            icon.style.display = 'none';
        }

        document.getElementById('work-name').textContent = work.name || '未命名作品';
        document.getElementById('work-desc').textContent = work.description || '';

        const isWorkflow = work.coze_meta && work.coze_meta.type === 'workflow';

        if (isWorkflow) {
            // 工作流类型
            const badge = document.getElementById('work-type-badge');
            badge.textContent = '工作流';
            badge.className = 'badge badge-workflow';
            document.getElementById('work-model').textContent = '';

            // Hide all views
            document.getElementById('view-chat').style.display = 'none';
            document.getElementById('view-form').style.display = 'none';
            document.getElementById('view-mixed').style.display = 'none';

            // Render workflow form view
            renderWorkflowView(work);
            document.getElementById('view-form').style.display = 'block';
        } else {
            // 智能体类型（原有逻辑）
            const typeMap = { chat: '对话', form: '表单', mixed: '混合' };
            const badge = document.getElementById('work-type-badge');
            badge.textContent = typeMap[work.interaction_type] || '对话';
            badge.className = `badge badge-${work.interaction_type || 'chat'}`;

            document.getElementById('work-model').textContent = work.model_name || '';

            // Hide all views
            document.getElementById('view-chat').style.display = 'none';
            document.getElementById('view-form').style.display = 'none';
            document.getElementById('view-mixed').style.display = 'none';

            const type = work.interaction_type || 'chat';

            if (type === 'chat') {
                renderChatView(work, 'chat-messages', 'chat-input', 'btn-send',
                    'suggested-questions', 'file-input', 'btn-upload',
                    'file-preview-area', 'file-preview-name', 'file-preview-remove');
                document.getElementById('view-chat').style.display = 'flex';
            } else if (type === 'form') {
                renderFormView(work, 'work-form', 'form-result', 'result-content');
                document.getElementById('view-form').style.display = 'block';
            } else if (type === 'mixed') {
                renderChatView(work, 'mixed-chat-messages', 'mixed-chat-input', 'btn-mixed-send',
                    null, 'mixed-file-input', 'btn-mixed-upload', null, null, null);
                renderFormView(work, 'mixed-work-form', null, null);
                document.getElementById('view-mixed').style.display = 'flex';
            }
        }
    }

    // ==================== Chat View ====================
    // 保存对话历史到 localStorage
    function saveChatHistory(workId, messagesId) {
        const messagesEl = document.getElementById(messagesId);
        const msgs = messagesEl.querySelectorAll('.chat-message');
        const history = [];
        msgs.forEach(msg => {
            const role = msg.classList.contains('user') ? 'user' : 'ai';
            const contentEl = msg.querySelector('.chat-message-content');
            const attachmentEl = msg.querySelector('.chat-attachment');
            const entry = { role };
            if (contentEl) {
                entry.content = contentEl.textContent || '';
            }
            if (attachmentEl) {
                entry.attachment = attachmentEl.textContent.trim();
            }
            history.push(entry);
        });
        try {
            const trimmed = history.slice(-100);
            localStorage.setItem(`chat_history_${workId}`, JSON.stringify(trimmed));
        } catch(e) {
            console.warn('保存对话历史失败:', e);
        }
    }

    function renderChatView(work, messagesId, inputId, sendBtnId,
        questionsId, fileInputId, uploadBtnId,
        previewAreaId, previewNameId, previewRemoveId) {
        const messagesEl = document.getElementById(messagesId);
        messagesEl.innerHTML = escapeHtml('');

        // 加载历史消息
        const historyKey = `chat_history_${work.id}`;
        let chatHistory = [];
        try {
            chatHistory = JSON.parse(localStorage.getItem(historyKey) || '[]');
        } catch(e) { chatHistory = []; }

        // Show prologue
        if (work.prologue && chatHistory.length === 0) {
            addMessage(messagesId, 'ai', work.prologue);
        }

        // 恢复历史消息
        chatHistory.forEach(msg => {
            let attachment = null;
            if (msg.attachment) {
                // 从附件文本中提取图标和文件名
                const match = msg.attachment.match(/^(\S+)\s+(.+)$/);
                if (match) {
                    attachment = { icon: match[1], fileName: match[2] };
                } else {
                    attachment = { icon: '📎', fileName: msg.attachment };
                }
            }
            addMessage(messagesId, msg.role, msg.content || '', false, attachment);
        });

        // Show suggested questions
        if (questionsId && work.suggested_questions && work.suggested_questions.length > 0) {
            const questionsEl = document.getElementById(questionsId);
            questionsEl.style.display = 'flex';
            questionsEl.innerHTML = escapeHtml('') + work.suggested_questions.map(q =>
                `<button class="suggested-question" data-question="${escapeHtml(q)}">${escapeHtml(q)}</button>`
            ).join('');

            questionsEl.querySelectorAll('.suggested-question').forEach(btn => {
                btn.addEventListener('click', () => {
                    const input = document.getElementById(inputId);
                    input.value = btn.dataset.question;
                    sendChatMessage(work, messagesId, inputId, sendBtnId, fileInputId, previewAreaId);
                    questionsEl.style.display = 'none';
                });
            });
        }

        // Bind send
        const sendBtn = document.getElementById(sendBtnId);
        const input = document.getElementById(inputId);

        sendBtn.addEventListener('click', () => sendChatMessage(work, messagesId, inputId, sendBtnId, fileInputId, previewAreaId));

        input.onkeydown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage(work, messagesId, inputId, sendBtnId, fileInputId, previewAreaId);
            }
        };

        // Auto-resize textarea
        input.oninput = () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        };

        // File upload
        if (uploadBtnId && fileInputId) {
            const uploadBtn = document.getElementById(uploadBtnId);
            const fileInput = document.getElementById(fileInputId);
            uploadBtn.addEventListener('click', () => fileInput.click());

            fileInput.onchange = async () => {
                if (fileInput.files.length > 0) {
                    const file = fileInput.files[0];
                    try {
                        showToast('正在上传文件...', 'info');
                        const result = await api.uploadFile(work.id, file);
                        if (work.id === state.currentWorkId) {
                            state.uploadedFile = result;
                            if (previewAreaId && previewNameId) {
                                const area = document.getElementById(previewAreaId);
                                area.style.display = 'flex';
                                // 获取文件图标
                                const ext = (file.name.split('.').pop() || '').toLowerCase();
                                const iconMap = {
                                    pdf: '📄', doc: '📝', docx: '📝', txt: '📃',
                                    xlsx: '📊', csv: '📊', png: '🖼️', jpg: '🖼️',
                                    jpeg: '🖼️', gif: '🖼️', webp: '🖼️'
                                };
                                const icon = iconMap[ext] || '📎';
                                const item = document.getElementById(previewAreaId).querySelector('.file-preview-item');
                                if (item) {
                                    // 安全构建：createElement + textContent，杜绝用户文件名 dataURL/文件名注入
                                    item.textContent = '';
                                    const iconEl = document.createElement('span');
                                    iconEl.className = 'file-icon';
                                    iconEl.textContent = icon;
                                    const nameEl = document.createElement('span');
                                    nameEl.className = 'file-preview-name';
                                    nameEl.textContent = result.file_name || file.name;
                                    const removeEl = document.createElement('button');
                                    removeEl.className = 'file-preview-remove';
                                    removeEl.type = 'button';
                                    removeEl.setAttribute('aria-label', '移除文件');
                                    removeEl.textContent = '\u00d7';
                                    if (previewRemoveId) removeEl.id = previewRemoveId;
                                    item.appendChild(iconEl);
                                    item.appendChild(nameEl);
                                    item.appendChild(removeEl);
                                    // 重新绑定删除按钮
                                    if (previewRemoveId) {
                                        document.getElementById(previewRemoveId).addEventListener('click', () => {
                                            state.uploadedFile = null;
                                            area.style.display = 'none';
                                        });
                                    }
                                }
                            }
                            showToast('文件上传成功', 'success');
                        }
                    } catch (e) {
                        showToast('文件上传失败: ' + e.message, 'error');
                    }
                    fileInput.value = '';
                }
            };
        }

        // File preview remove
        if (previewRemoveId && previewAreaId) {
            document.getElementById(previewRemoveId).addEventListener('click', () => {
                state.uploadedFile = null;
                document.getElementById(previewAreaId).style.display = 'none';
            });
        }
    }

    async function sendChatMessage(work, messagesId, inputId, sendBtnId, fileInputId, previewAreaId) {
        const input = document.getElementById(inputId);
        const sendBtn = document.getElementById(sendBtnId);
        const message = input.value.trim();

        if (state.isStreaming) return;
        if (!message && !state.uploadedFile) return;

        // Build message content
        let messageContent = message;
        let uploadedFileInfo = null;
        if (state.uploadedFile) {
            uploadedFileInfo = { ...state.uploadedFile };
            messageContent = [
                { type: 'text', text: message || '请分析这个文件' },
                { type: 'file', file_id: state.uploadedFile.file_id }
            ];
            state.uploadedFile = null;
            if (previewAreaId) {
                document.getElementById(previewAreaId).style.display = 'none';
            }
        }

        // Add user message
        if (uploadedFileInfo) {
            const fileName = uploadedFileInfo.file_name || '附件';
            const ext = (fileName.split('.').pop() || '').toLowerCase();
            const iconMap = {
                pdf: '📄', doc: '📝', docx: '📝', txt: '📃',
                xlsx: '📊', csv: '📊', png: '🖼️', jpg: '🖼️',
                jpeg: '🖼️', gif: '🖼️', webp: '🖼️'
            };
            const icon = iconMap[ext] || '📎';
            addMessage(messagesId, 'user', message || '', false, { fileName, icon });
        } else {
            addMessage(messagesId, 'user', message);
        }
        saveChatHistory(work.id, messagesId);
        input.value = '';
        input.style.height = 'auto';

        // Disable input
        state.isStreaming = true;
        sendBtn.disabled = true;
        input.disabled = true;

        // Add typing indicator
        const typingEl = addTypingIndicator(messagesId);

        // 流式请求取消控制：切换页面/卸载时 abort，避免竞态与泄漏
        const controller = new AbortController();
        state.streamController = controller;

        try {
            const resp = await api.chat(work.id, messageContent, state.conversationId, null, controller.signal);
            if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

            // Remove typing indicator
            typingEl.remove();

            // Create AI message bubble
            const aiMsgEl = addMessage(messagesId, 'ai', '', true);
            const bubbleEl = aiMsgEl.querySelector('.chat-message-bubble');
            let fullContent = '';

            // Read SSE stream
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const event = JSON.parse(line.slice(6));
                        if (event.type === 'delta') {
                            fullContent += event.content;
                            bubbleEl.innerHTML = `<div class="chat-message-content">${renderMarkdown(fullContent)}</div>`;
                            scrollMessages(messagesId);
                        } else if (event.type === 'done') {
                            if (event.conversation_id) {
                                state.conversationId = event.conversation_id;
                            }
                        } else if (event.type === 'error') {
                            bubbleEl.innerHTML = `<div class="chat-message-content"><span style="color:var(--danger)">错误: ${escapeHtml(event.content)}</span></div>`;
                        }
                    } catch (e) { /* ignore parse errors */ }
                }
            }

            // Final render
            if (fullContent) {
                bubbleEl.innerHTML = `<div class="chat-message-content">${renderMarkdown(fullContent)}</div>`;
            }

        } catch (e) {
            typingEl.remove();
            // 主动取消（切换页面/卸载）不弹错误气泡，避免竞态残留提示
            if (e && e.name === 'AbortError') {
                // 静默：请求已被取消
            } else {
                addMessage(messagesId, 'ai', `请求失败: ${e.message}`);
            }
        } finally {
            // 仅当未被更晚的请求替换时才清空引用
            if (state.streamController === controller) state.streamController = null;
            state.isStreaming = false;
            sendBtn.disabled = false;
            input.disabled = false;
            input.focus();
            saveChatHistory(work.id, messagesId);
        }
    }

    function addMessage(messagesId, role, content, isStreaming = false, attachment = null) {
        const container = document.getElementById(messagesId);
        const msgEl = document.createElement('div');
        msgEl.className = `chat-message ${role}`;

        const avatarText = role === 'ai' ? 'AI' : 'U';
        const renderedContent = role === 'ai' && content ? renderMarkdown(content) : escapeHtml(content || '');

        // 安全构建消息结构：createElement + textContent，附件文件名用 textContent 杜绝注入
        const avatarEl = document.createElement('div');
        avatarEl.className = 'chat-message-avatar';
        avatarEl.textContent = avatarText;

        const bodyEl = document.createElement('div');
        bodyEl.className = 'chat-message-body';

        if (attachment && attachment.fileName) {
            const attEl = document.createElement('div');
            attEl.className = 'chat-attachment';
            const iconEl = document.createElement('span');
            iconEl.textContent = attachment.icon || '\ud83d\udcce';
            const nameEl = document.createElement('span');
            nameEl.textContent = attachment.fileName;
            attEl.appendChild(iconEl);
            attEl.appendChild(nameEl);
            bodyEl.appendChild(attEl);
        }

        const bubbleEl = document.createElement('div');
        bubbleEl.className = 'chat-message-bubble';
        const contentEl = document.createElement('div');
        contentEl.className = 'chat-message-content';
        // renderedContent 已由 renderMarkdown/escapeHtml 消毒，此处用 innerHTML 承载富文本
        contentEl.innerHTML = sanitizeHtml(renderedContent);
        bubbleEl.appendChild(contentEl);
        if (isStreaming) {
            const typingEl = document.createElement('div');
            typingEl.className = 'typing-indicator';
            typingEl.innerHTML = sanitizeHtml('<span></span><span></span><span></span>');
            bubbleEl.appendChild(typingEl);
        }
        bodyEl.appendChild(bubbleEl);

        msgEl.appendChild(avatarEl);
        msgEl.appendChild(bodyEl);

        container.appendChild(msgEl);
        scrollMessages(messagesId);
        return msgEl;
    }

    function addTypingIndicator(messagesId) {
        const container = document.getElementById(messagesId);
        const el = document.createElement('div');
        el.className = 'chat-message ai';
        el.innerHTML = sanitizeHtml(`
            <div class="chat-message-avatar">AI</div>
            <div class="chat-message-bubble"><div class="typing-indicator"><span></span><span></span><span></span></div></div>
        `);
        container.appendChild(el);
        scrollMessages(messagesId);
        return el;
    }

    function scrollMessages(messagesId) {
        const container = document.getElementById(messagesId);
        requestAnimationFrame(() => {
            container.scrollTop = container.scrollHeight;
        });
    }

    // ==================== Form View ====================
    function renderFormView(work, formId, resultId, resultContentId) {
        const form = document.getElementById(formId);
        form.innerHTML = escapeHtml('');

        const parameters = work.parameters || [];
        if (parameters.length === 0) {
            form.innerHTML = escapeHtml('') + '<p style="color:var(--text-tertiary);text-align:center;padding:20px;">该作品没有可填写的参数</p>';
            return;
        }

        parameters.forEach(param => {
            const group = document.createElement('div');
            group.className = 'form-group';

            const label = document.createElement('label');
            label.textContent = param.label || param.name;
            if (param.required) label.textContent += ' *';
            group.appendChild(label);

            const input = createFormInput(param, formId);
            group.appendChild(input);

            if (param.placeholder) {
                const hint = document.createElement('span');
                hint.className = 'form-hint';
                hint.textContent = param.placeholder;
                group.appendChild(hint);
            }

            form.appendChild(group);
        });

        // Submit button
        const submitBtn = document.createElement('button');
        submitBtn.type = 'button';
        submitBtn.className = 'btn-primary';
        submitBtn.textContent = '提交';
        submitBtn.style.marginTop = '8px';
        submitBtn.onclick = async () => {
            await submitForm(work, formId, resultId, resultContentId);
        };
        form.appendChild(submitBtn);
    }

    function createFormInput(param, formId) {
        const type = param.type || 'String';

        switch (type) {
            case 'String': {
                const el = document.createElement('input');
                el.type = 'text';
                el.className = 'form-input';
                el.name = param.name;
                el.placeholder = param.placeholder || '';
                el.value = param.default || '';
                if (param.required) el.required = true;
                return el;
            }
            case 'Integer': {
                const el = document.createElement('input');
                el.type = 'number';
                el.className = 'form-input';
                el.name = param.name;
                el.placeholder = param.placeholder || '';
                el.value = param.default || '';
                el.step = '1';
                if (param.required) el.required = true;
                return el;
            }
            case 'Number': {
                const el = document.createElement('input');
                el.type = 'number';
                el.className = 'form-input';
                el.name = param.name;
                el.placeholder = param.placeholder || '';
                el.value = param.default || '';
                el.step = 'any';
                if (param.required) el.required = true;
                return el;
            }
            case 'Boolean': {
                const container = document.createElement('div');
                container.className = 'boolean-toggle';
                const toggle = document.createElement('div');
                toggle.className = 'toggle-switch' + (param.default ? ' active' : '');
                toggle.dataset.name = param.name;
                toggle.dataset.value = param.default ? 'true' : 'false';

                toggle.addEventListener('click', () => {
                    const active = toggle.classList.toggle('active');
                    toggle.dataset.value = active ? 'true' : 'false';
                });

                const label = document.createElement('span');
                label.className = 'toggle-label';
                label.textContent = param.required ? '是' : '否';

                container.appendChild(toggle);
                container.appendChild(label);
                return container;
            }
            case 'Time': {
                const el = document.createElement('input');
                el.type = 'datetime-local';
                el.className = 'form-input';
                el.name = param.name;
                if (param.default) el.value = param.default;
                if (param.required) el.required = true;
                return el;
            }
            case 'Object': {
                // Object 类型：如果有子属性则递归渲染，否则显示 JSON 编辑器
                const childParams = (param.children || []).filter(c => c.group !== 'output');
                if (childParams.length > 0) {
                    const container = document.createElement('div');
                    container.className = 'object-children';
                    container.style.cssText = 'margin-left:16px;padding-left:12px;border-left:2px solid var(--border-color);';
                    childParams.forEach(child => {
                        const group = document.createElement('div');
                        group.className = 'form-group';
                        const label = document.createElement('label');
                        label.textContent = child.label || child.name;
                        if (child.required) label.textContent += ' *';
                        group.appendChild(label);
                        const input = createFormInput(child, formId);
                        group.appendChild(input);
                        container.appendChild(group);
                    });
                    return container;
                } else {
                    // JSON 编辑器
                    const el = document.createElement('textarea');
                    el.className = 'form-input';
                    el.name = param.name;
                    el.placeholder = param.placeholder || '请输入 JSON 对象，例如：{"key": "value"}';
                    el.style.fontFamily = 'monospace';
                    el.rows = 4;
                    try {
                        if (param.default) el.value = typeof param.default === 'string' ? param.default : JSON.stringify(param.default, null, 2);
                    } catch(e) {}
                    return el;
                }
            }
            case 'Array': {
                // Array 类型：可动态添加/删除项的列表
                const container = document.createElement('div');
                container.className = 'array-input-container';
                container.dataset.name = param.name;
                container.style.cssText = 'display:flex;flex-direction:column;gap:6px;';

                const items = Array.isArray(param.default) ? param.default : [''];
                items.forEach((item, i) => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex;gap:6px;align-items:center;';
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'form-input array-item-input';
                    input.style.flex = '1';
                    input.value = item || '';
                    input.placeholder = param.placeholder || `项目 ${i + 1}`;
                    row.appendChild(input);
                    const removeBtn = document.createElement('button');
                    removeBtn.type = 'button';
                    removeBtn.className = 'btn-sm danger';
                    removeBtn.textContent = '删除';
                    removeBtn.addEventListener('click', () => row.remove());
                    row.appendChild(removeBtn);
                    container.appendChild(row);
                });

                const addBtn = document.createElement('button');
                addBtn.type = 'button';
                addBtn.className = 'btn-sm btn-secondary';
                addBtn.textContent = '+ 添加项';
                addBtn.addEventListener('click', () => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex;gap:6px;align-items:center;';
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'form-input array-item-input';
                    input.style.flex = '1';
                    input.placeholder = `项目 ${container.querySelectorAll('.array-item-input').length + 1}`;
                    row.appendChild(input);
                    const removeBtn = document.createElement('button');
                    removeBtn.type = 'button';
                    removeBtn.className = 'btn-sm danger';
                    removeBtn.textContent = '删除';
                    removeBtn.addEventListener('click', () => row.remove());
                    row.appendChild(removeBtn);
                    container.appendChild(row);
                });
                container.appendChild(addBtn);
                return container;
            }
            case 'File': {
                const container = document.createElement('div');
                container.className = 'file-upload-area';
                // 安全构建：createElement + setAttribute，name 属性经 setAttribute 不会逃逸为 HTML
                const fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.setAttribute('name', param.name || '');
                fileInput.setAttribute('accept', 'image/*,.pdf,.doc,.docx,.txt,.xlsx,.csv');
                const textEl = document.createElement('div');
                textEl.className = 'file-upload-text';
                textEl.textContent = '点击或拖拽上传文件';
                const hintEl = document.createElement('div');
                hintEl.className = 'file-upload-hint';
                hintEl.textContent = '支持图片、PDF、文档等格式';
                const preview = document.createElement('div');
                preview.className = 'file-upload-preview';
                preview.style.display = 'none';
                container.appendChild(fileInput);
                container.appendChild(textEl);
                container.appendChild(hintEl);
                container.appendChild(preview);

                container.addEventListener('click', (e) => {
                    if (e.target !== fileInput) fileInput.click();
                });

                fileInput.addEventListener('change', async () => {
                    if (fileInput.files.length > 0) {
                        const file = fileInput.files[0];
                        try {
                            showToast('正在上传...', 'info');
                            const result = await api.uploadFile(state.currentWorkId, file);
                            container.dataset.fileId = result.file_id;
                            preview.style.display = 'flex';
                            preview.textContent = result.file_name;
                            showToast('上传成功', 'success');
                        } catch (e) {
                            showToast('上传失败: ' + e.message, 'error');
                        }
                    }
                });

                return container;
            }
            default: {
                const el = document.createElement('input');
                el.type = 'text';
                el.className = 'form-input';
                el.name = param.name;
                el.placeholder = param.placeholder || '';
                el.value = param.default || '';
                if (param.required) el.required = true;
                return el;
            }
        }
    }

    async function submitForm(work, formId, resultId, resultContentId) {
        const form = document.getElementById(formId);
        const parameters = {};
        let hasError = false;

        // Collect parameters
        (work.parameters || []).forEach(param => {
            const type = param.type || 'String';
            if (type === 'Array') {
                const container = form.querySelector(`.array-input-container[data-name="${param.name}"]`);
                if (container) {
                    const inputs = container.querySelectorAll('.array-item-input');
                    parameters[param.name] = Array.from(inputs).map(inp => inp.value).filter(v => v !== '');
                }
            } else if (type === 'Boolean') {
                const toggle = form.querySelector(`.toggle-switch[data-name="${param.name}"]`);
                if (toggle) parameters[param.name] = toggle.dataset.value === 'true';
            } else if (type === 'File') {
                const area = form.querySelector(`.file-upload-area[data-file-id]`);
                if (area) parameters[param.name] = area.dataset.fileId;
            } else if (type === 'Object') {
                const childParams = (param.children || []).filter(c => c.group !== 'output');
                if (childParams.length > 0) {
                    // 从子属性表单收集值
                    const obj = {};
                    childParams.forEach(child => {
                        const childType = child.type || 'String';
                        if (childType === 'Boolean') {
                            const toggle = form.querySelector(`.toggle-switch[data-name="${child.name}"]`);
                            if (toggle) obj[child.name] = toggle.dataset.value === 'true';
                        } else if (childType === 'File') {
                            const area = form.querySelector(`.file-upload-area[data-file-id]`);
                            if (area) obj[child.name] = area.dataset.fileId;
                        } else {
                            const input = form.querySelector(`[name="${child.name}"]`);
                            if (input) obj[child.name] = input.value;
                        }
                    });
                    parameters[param.name] = obj;
                } else {
                    // JSON 编辑器
                    const textarea = form.querySelector(`textarea[name="${param.name}"]`);
                    if (textarea && textarea.value.trim()) {
                        try {
                            parameters[param.name] = JSON.parse(textarea.value);
                        } catch (e) {
                            parameters[param.name] = textarea.value;
                        }
                    }
                }
            } else if (type === 'Integer') {
                const input = form.querySelector(`[name="${param.name}"]`);
                if (input && input.value !== '') parameters[param.name] = parseInt(input.value, 10) || 0;
            } else if (type === 'Number') {
                const input = form.querySelector(`[name="${param.name}"]`);
                if (input && input.value !== '') parameters[param.name] = parseFloat(input.value) || 0;
            } else {
                const input = form.querySelector(`[name="${param.name}"]`);
                if (input) parameters[param.name] = input.value;
            }

            if (param.required && !parameters[param.name] &&
                !(Array.isArray(parameters[param.name]) && parameters[param.name].length > 0) &&
                !(typeof parameters[param.name] === 'object' && parameters[param.name] !== null && Object.keys(parameters[param.name]).length > 0)) {
                hasError = true;
            }
        });

        if (hasError) {
            showToast('请填写所有必填项', 'warning');
            return;
        }

        if (!resultId || !resultContentId) {
            // Mixed mode: send as chat with parameters
            await sendFormAsChat(work, parameters);
            return;
        }

        // Show result area
        const resultEl = document.getElementById(resultId);
        const contentEl = document.getElementById(resultContentId);
        resultEl.style.display = 'block';
        contentEl.innerHTML = escapeHtml('') + '<div class="loading-spinner"></div> 正在处理...';

        try {
            const resp = await api.chat(work.id, '', '', parameters);
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let fullContent = '';
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const event = JSON.parse(line.slice(6));
                        if (event.type === 'delta') {
                            fullContent += event.content;
                            contentEl.innerHTML = renderMarkdown(fullContent);
                        } else if (event.type === 'done') {
                            // Coze 工作流 done 事件可能包含最终结果
                            if (event.content) {
                                fullContent = event.content;
                                contentEl.innerHTML = renderMarkdown(fullContent);
                            }
                        } else if (event.type === 'error') {
                            contentEl.innerHTML = `<span style="color:var(--danger)">错误: ${escapeHtml(event.content)}</span>`;
                        }
                    } catch (e) { /* ignore */ }
                }
            }

            if (fullContent) {
                contentEl.innerHTML = renderMarkdown(fullContent);
            }
        } catch (e) {
            contentEl.innerHTML = `<span style="color:var(--danger)">请求失败: ${escapeHtml(e.message)}</span>`;
        }
    }

    async function sendFormAsChat(work, parameters) {
        const messagesId = 'mixed-chat-messages';
        const inputId = 'mixed-chat-input';
        const sendBtnId = 'btn-mixed-send';

        state.isStreaming = true;
        document.getElementById(sendBtnId).disabled = true;
        document.getElementById(inputId).disabled = true;

        const typingEl = addTypingIndicator(messagesId);

        try {
            const resp = await api.chat(work.id, '', '', parameters);
            typingEl.remove();

            const aiMsgEl = addMessage(messagesId, 'ai', '', true);
            const bubbleEl = aiMsgEl.querySelector('.chat-message-bubble');
            let fullContent = '';

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const event = JSON.parse(line.slice(6));
                        if (event.type === 'delta') {
                            fullContent += event.content;
                            bubbleEl.innerHTML = renderMarkdown(fullContent);
                            scrollMessages(messagesId);
                        } else if (event.type === 'done') {
                            if (event.conversation_id) state.conversationId = event.conversation_id;
                        } else if (event.type === 'error') {
                            bubbleEl.innerHTML = `<span style="color:var(--danger)">错误: ${escapeHtml(event.content)}</span>`;
                        }
                    } catch (e) { /* ignore */ }
                }
            }

            if (fullContent) bubbleEl.innerHTML = renderMarkdown(fullContent);
        } catch (e) {
            typingEl.remove();
            addMessage(messagesId, 'ai', `请求失败: ${e.message}`);
        } finally {
            state.isStreaming = false;
            document.getElementById(sendBtnId).disabled = false;
            document.getElementById(inputId).disabled = false;
        }
    }

    // ==================== Admin Page ====================

    function showAdmin() {
        state.currentView = 'admin';
        showPage('page-admin');
        // 直接显示管理面板，无需登录
        document.getElementById('admin-login').style.display = 'none';
        document.getElementById('admin-panel').style.display = 'block';
        loadAdminData();
    }

    async function adminLogin() {
        const password = document.getElementById('admin-password').value.trim();
        if (!password) {
            showToast('请输入管理密码', 'warning');
            return;
        }

        try {
            const data = await api.adminLogin(password);
            state.adminToken = data.token;   // 仅内存，不落 sessionStorage
            showToast('登录成功', 'success');
            document.getElementById('admin-login').style.display = 'none';
            document.getElementById('admin-panel').style.display = 'block';
            loadAdminData();
        } catch (e) {
            showToast(e.message, 'error');
        }
    }

    function adminLogout() {
        showToast('已退出管理', 'info');
        navigate('home');
    }

    async function loadAdminData() {
        try {
            const [config, worksData] = await Promise.all([
                api.getConfig(),
                api.getAdminWorks()
            ]);

            // Fill settings
            document.getElementById('setting-name').value = config.site_name || '';
            document.getElementById('setting-desc').value = config.site_description || '';
            document.getElementById('setting-theme').value = config.theme || 'light';

            // Fill global LLM config
            const llmConfig = config.llm_config || {};
            document.getElementById('global-llm-base-url').value = llmConfig.base_url || '';
            document.getElementById('global-llm-api-key').value = llmConfig.api_key || '';
            document.getElementById('global-llm-model').value = llmConfig.model || '';

            // Apply theme
            document.body.dataset.theme = config.theme || 'light';

            // Render works list
            state.adminWorks = worksData.works || [];
            renderAdminWorks(state.adminWorks);
        } catch (e) {
            showToast('加载数据失败: ' + e.message, 'error');
        }
    }

    function renderAdminWorks(works) {
        const list = document.getElementById('admin-works-list');
        const selectAllCb = document.getElementById('select-all-admin-works');
        const batchBtn = document.getElementById('btn-batch-delete-works');
        const countSpan = document.getElementById('admin-works-selected-count');

        // 重置全选
        if (selectAllCb) selectAllCb.checked = false;
        if (batchBtn) batchBtn.style.display = 'none';
        if (countSpan) countSpan.textContent = '';

        if (works.length === 0) {
            list.innerHTML = escapeHtml('') + '<p style="color:var(--text-tertiary);text-align:center;padding:40px;">暂无已导入的作品，请前往"导入作品"页面</p>';
            return;
        }

        list.innerHTML = escapeHtml('') + works.map(work => {
            const iconHtml = work.icon_url
                ? `<img class="admin-work-icon" src="${escapeHtml(work.icon_url)}" alt="" onerror="this.style.display='none'">`
                : `<div class="admin-work-icon" style="background:linear-gradient(135deg,var(--brand-500,#4f46e5),var(--violet-500,#a855f7));display:flex;align-items:center;justify-content:center;color:var(--text-inverse,#fff);font-size:16px;border-radius:var(--radius-sm);">AI</div>`;

            const isWorkflow = work.coze_meta && work.coze_meta.type === 'workflow';
            const workflowBtns = isWorkflow ? `
                <button class="btn-sm btn-edit-params" data-id="${escapeHtml(work.id)}" title="编辑参数">编辑参数</button>
           ` : '';

            return `
                <div class="admin-work-item" data-work-id="${escapeHtml(work.id)}">
                    <input type="checkbox" class="admin-work-checkbox" data-id="${escapeHtml(work.id)}" style="margin-right:12px;cursor:pointer;flex-shrink:0">
                    ${iconHtml}
                    <div class="admin-work-info">
                        <div class="admin-work-name">${escapeHtml(work.name)}</div>
                        <div class="admin-work-meta">
                            <span>${isWorkflow ? '工作流' : (work.interaction_type || 'chat')}</span>
                            <span>${work.is_public !== false ? '已公开' : '未公开'}</span>
                        </div>
                    </div>
                    <div class="admin-work-actions">
                        ${workflowBtns}
                        <button class="btn-sm btn-refresh-work" data-id="${escapeHtml(work.id)}" title="刷新">刷新</button>
                        <button class="btn-sm danger btn-delete-work" data-id="${escapeHtml(work.id)}" title="删除">删除</button>
                    </div>
                </div>
            `;
        }).join('');

        // 同步选中状态
        function syncAdminSelection() {
            const allCbs = list.querySelectorAll('.admin-work-checkbox');
            const checkedCbs = list.querySelectorAll('.admin-work-checkbox:checked');
            const checkedCount = checkedCbs.length;
            if (selectAllCb) selectAllCb.checked = allCbs.length > 0 && checkedCount === allCbs.length;
            if (batchBtn) batchBtn.style.display = checkedCount > 0 ? '' : 'none';
            if (countSpan) countSpan.textContent = checkedCount > 0 ? `已选 ${checkedCount} 项` : '';
        }

        // 全选
        if (selectAllCb) {
            selectAllCb.onchange = function () {
                list.querySelectorAll('.admin-work-checkbox').forEach(cb => cb.checked = this.checked);
                syncAdminSelection();
            };
        }

        // 单选
        list.querySelectorAll('.admin-work-checkbox').forEach(cb => {
            cb.addEventListener('change', () => syncAdminSelection());
        });

        // Bind events
        list.querySelectorAll('.btn-edit-work').forEach(btn => {
            btn.addEventListener('click', () => editWorkDialog(btn.dataset.id, works));
        });
        list.querySelectorAll('.btn-refresh-work').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    showToast('正在刷新...', 'info');
                    await api.refreshWork(btn.dataset.id);
                    showToast('刷新成功', 'success');
                    loadAdminData();
                } catch (e) {
                    showToast('刷新失败: ' + e.message, 'error');
                }
            });
        });
        list.querySelectorAll('.btn-delete-work').forEach(btn => {
            btn.addEventListener('click', () => confirmDeleteWork(btn.dataset.id));
        });
        list.querySelectorAll('.btn-edit-params').forEach(btn => {
            btn.addEventListener('click', () => openEditParams(btn.dataset.id));
        });
    }

    async function batchDeleteWorks() {
        const checkedCbs = document.querySelectorAll('#admin-works-list .admin-work-checkbox:checked');
        if (checkedCbs.length === 0) return;

        const ids = Array.from(checkedCbs).map(cb => cb.dataset.id);
        if (!confirm(`确定要删除选中的 ${ids.length} 个作品吗？此操作不可撤销。`)) return;

        let successCount = 0;
        let failCount = 0;
        for (const id of ids) {
            try {
                await api.deleteWork(id);
                successCount++;
            } catch (e) {
                failCount++;
            }
        }

        if (failCount === 0) {
            showToast(`成功删除 ${successCount} 个作品`, 'success');
        } else {
            showToast(`删除完成：${successCount} 成功，${failCount} 失败`, 'warning');
        }
        loadAdminData();
    }
    window.batchDeleteWorks = batchDeleteWorks;

    function editWorkDialog(workId, works) {
        const work = works.find(w => w.id === workId);
        if (!work) return;

        const isPublic = confirm(`编辑作品: ${work.name}\n\n当前状态: ${work.is_public !== false ? '公开' : '未公开'}\n\n点击"确定"设为公开，点击"取消"设为不公开`);

        api.updateWork(workId, {
            is_public: isPublic
        }).then(() => {
            showToast('更新成功', 'success');
            loadAdminData();
        }).catch(e => {
            showToast('更新失败: ' + e.message, 'error');
        });
    }

    function confirmDeleteWork(workId) {
        showConfirm('确认删除', '删除后无法恢复，确定要删除该作品吗？', async () => {
            try {
                await api.deleteWork(workId);
                showToast('删除成功', 'success');
                loadAdminData();
            } catch (e) {
                showToast('删除失败: ' + e.message, 'error');
            }
        });
    }

    // ==================== Modal Helpers ====================
    function openModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.style.display = 'flex';
    }
    function closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.style.display = 'none';
    }

    // 暴露到全局作用域，供 HTML onclick 调用
    window.openModal = openModal;
    window.closeModal = closeModal;

    // ==================== 全局 LLM 配置 ====================
    function fillGlobalDoubaoPreset() {
        document.getElementById('global-llm-base-url').value = 'https://ark.cn-beijing.volces.com/api/v3';
        document.getElementById('global-llm-model').value = '';
        showToast('已填入豆包 Base URL，请补充 API Key 和模型名称', 'info');
    }
    window.fillGlobalDoubaoPreset = fillGlobalDoubaoPreset;

    async function saveGlobalLlmConfig() {
        const data = {
            base_url: document.getElementById('global-llm-base-url').value.trim(),
            api_key: document.getElementById('global-llm-api-key').value.trim(),
            model: document.getElementById('global-llm-model').value.trim()
        };
        if (!data.base_url || !data.api_key || !data.model) {
            showToast('请填写完整的 LLM 配置', 'warning');
            return;
        }
        try {
            await api.updateConfig({ llm_config: data });
            showToast('LLM 配置已保存', 'success');
        } catch (e) {
            showToast('保存失败: ' + e.message, 'error');
        }
    }
    window.saveGlobalLlmConfig = saveGlobalLlmConfig;

    // ==================== AI 生成参数（内联在编辑参数弹窗中） ====================
    // ==================== AI 生成参数（输入/输出分开） ====================
    const _genTasks = {};  // { input: { taskId, timer, controller }, output: { taskId, timer, controller } }

    // 中止某一组的轮询与上传请求（cancelGenInline / 页面卸载共用）
    function _stopGenTask(group) {
        const task = _genTasks[group];
        if (!task) return;
        if (task.controller) task.controller.abort();
        if (task.timer) clearInterval(task.timer);
        _genTasks[group] = null;
    }

    function openAiGenInline(group) {
        const area = document.getElementById(`ai-gen-${group}-area`);
        // 兼容 .hidden class 与内联 style.display 两种状态
        const isHidden = area.classList.contains('hidden') || area.style.display === 'none';
        if (isHidden) {
            area.classList.remove('hidden');
            area.style.display = '';
        } else {
            area.classList.add('hidden');
            area.style.display = 'none';
        }
    }

    async function generateParamsInline(group) {
        const workId = document.getElementById('edit-params-work-id').value;
        const fileInput = document.getElementById(`ai-gen-${group}-file`);
        if (!fileInput.files[0]) {
            showToast('请先选择截图', 'warning');
            return;
        }

        const btn = document.getElementById(`btn-ai-gen-${group}`);
        const cancelBtn = document.getElementById(`btn-cancel-ai-${group}`);
        const statusEl = document.getElementById(`ai-gen-${group}-status`);

        btn.disabled = true;
        btn.textContent = '上传中...';
        cancelBtn.style.display = '';
        statusEl.textContent = '';
        statusEl.style.color = '#888';

        try {
            const formData = new FormData();
            formData.append('image', fileInput.files[0]);
            formData.append('gen_group', group);  // 告诉后端只生成输入或输出
            const controller = new AbortController();
            _genTasks[group] = { taskId: null, timer: null, controller };
            const resp = await api.requestRaw(`/api/admin/works/${workId}/generate-params`, {
                method: 'POST', body: formData, signal: controller.signal
            });
            const body = await resp.json();
            const result = body.data || {};

            if (!resp.ok || body.code !== 0 || !result.success) {
                showToast('生成失败: ' + (body.message || result.error || '未知错误'), 'error');
                btn.disabled = false;
                btn.textContent = '识别';
                cancelBtn.style.display = 'none';
                return;
            }

            _genTasks[group].taskId = result.task_id;
            btn.textContent = '识别中...';
            statusEl.textContent = '⏱ AI 正在分析截图...';

            _genTasks[group].timer = setInterval(async () => {
                try {
                    const statusResp = await api.requestRaw(`/api/admin/works/${workId}/generate-params/status?task_id=${result.task_id}`, {
                        signal: _genTasks[group] ? _genTasks[group].controller.signal : undefined
                    });
                    const statusBody = await statusResp.json();
                    const statusResult = statusBody.data || {};

                    if (statusResult.status === 'done') {
                        clearInterval(_genTasks[group].timer);
                        _genTasks[group] = null;

                        const params = statusResult.result.parameters || [];
                        const containerId = group === 'input' ? 'input-params-editor' : 'output-params-editor';

                        params.forEach(p => {
                            const row = createParamRowWithData(containerId, p);
                            document.getElementById(containerId).appendChild(row);
                        });

                        statusEl.textContent = `✅ 识别完成：${params.length} 个${group === 'input' ? '输入' : '输出'}参数`;
                        statusEl.style.color = 'var(--success,#22c55e)';
                        btn.disabled = false;
                        btn.textContent = '识别';
                        cancelBtn.style.display = 'none';
                        showToast(`AI 识别完成：${params.length} 个${group === 'input' ? '输入' : '输出'}参数`, 'success');
                    } else if (statusResult.status === 'error') {
                        clearInterval(_genTasks[group].timer);
                        _genTasks[group] = null;
                        statusEl.textContent = '❌ ' + (statusResult.error || '生成失败');
                        statusEl.style.color = 'var(--danger,#ef4444)';
                        btn.disabled = false;
                        btn.textContent = '识别';
                        cancelBtn.style.display = 'none';
                    } else if (statusResult.status === 'cancelled') {
                        clearInterval(_genTasks[group].timer);
                        _genTasks[group] = null;
                        statusEl.textContent = '已中止';
                        statusEl.style.color = '#888';
                        btn.disabled = false;
                        btn.textContent = '识别';
                        cancelBtn.style.display = 'none';
                    }
                } catch (e) {
                    // 被取消（abort）时静默，避免重复中止提示
                    if (!(e && e.name === 'AbortError')) console.error('轮询错误:', e);
                }
            }, 3000);

        } catch (e) {
            // 被取消（abort）时静默，避免竞态残留提示
            if (!(e && e.name === 'AbortError')) {
                showToast('生成失败: ' + e.message, 'error');
            }
            btn.disabled = false;
            btn.textContent = '识别';
            cancelBtn.style.display = 'none';
            _genTasks[group] = null;
        }
    }

    async function cancelGenInline(group) {
        const task = _genTasks[group];
        if (!task) return;
        const workId = document.getElementById('edit-params-work-id').value;
        if (task.taskId) {
            await api.requestRaw(`/api/admin/works/${workId}/generate-params/cancel`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({task_id: task.taskId})
            }).catch(() => {});
        }
        _stopGenTask(group);

        const btn = document.getElementById(`btn-ai-gen-${group}`);
        const cancelBtn = document.getElementById(`btn-cancel-ai-${group}`);
        const statusEl = document.getElementById(`ai-gen-${group}-status`);
        btn.disabled = false;
        btn.textContent = '识别';
        cancelBtn.style.display = 'none';
        statusEl.textContent = '已中止';
        statusEl.style.color = '#888';
    }

    // ==================== 参数编辑器 ====================
    async function openEditParams(workId) {
        // 先刷新管理数据，确保拿到最新的作品配置
        await loadAdminData();
        const work = state.adminWorks.find(w => w.id === workId);
        if (!work) return;
        document.getElementById('edit-params-work-id').value = workId;
        renderParamsEditor(work.parameters || []);
        // 重置 AI 生成区域状态
        document.getElementById('ai-gen-input-area').style.display = 'none';
        document.getElementById('ai-gen-output-area').style.display = 'none';
        document.getElementById('ai-gen-input-status').textContent = '';
        document.getElementById('ai-gen-output-status').textContent = '';
        document.getElementById('ai-gen-input-preview').innerHTML = escapeHtml('');
        document.getElementById('ai-gen-output-preview').innerHTML = escapeHtml('');
        const inputFile = document.getElementById('ai-gen-input-file');
        const outputFile = document.getElementById('ai-gen-output-file');
        if (inputFile) inputFile.value = '';
        if (outputFile) outputFile.value = '';
        openModal('modal-edit-params');
    }

    function renderParamsEditor(params) {
        const inputContainer = document.getElementById('input-params-editor');
        const outputContainer = document.getElementById('output-params-editor');
        inputContainer.innerHTML = escapeHtml('');
        outputContainer.innerHTML = escapeHtml('');

        params.forEach((p, i) => {
            const group = p.group || 'input';
            const container = group === 'output' ? outputContainer : inputContainer;
            // 只渲染顶级参数（没有 parent 的）
            if (p.parent) return;
            const idx = container.children.length;
            const row = createParamRow(p, idx, group);
            container.appendChild(row);

            // 如果是 Object 类型且有子属性，渲染子属性容器
            if (p.type === 'Object' && p.children && p.children.length > 0) {
                const childContainer = document.createElement('div');
                childContainer.className = 'param-children-container';
                childContainer.style.cssText = 'margin-left:24px;padding-left:12px;border-left:2px solid var(--border-color);';
                p.children.forEach((child, ci) => {
                    const childRow = createParamRow(child, ci, group);
                    childRow.classList.add('param-child-row');
                    childRow.style.marginLeft = '24px';
                    childRow.dataset.parent = p.name;
                    childContainer.appendChild(childRow);
                });
                container.appendChild(childContainer);
            }

            // 如果是 Array(item_type=Object) 类型且有子属性，渲染子属性容器
            if (p.type === 'Array' && p.item_type === 'Object' && p.children && p.children.length > 0) {
                const childContainer = document.createElement('div');
                childContainer.className = 'param-children-container';
                childContainer.style.cssText = 'margin-left:24px;padding-left:12px;border-left:2px solid var(--border-color);';
                p.children.forEach((child, ci) => {
                    const childRow = createParamRow(child, ci, group);
                    childRow.classList.add('param-child-row');
                    childRow.style.marginLeft = '24px';
                    childRow.dataset.parent = p.name;
                    childContainer.appendChild(childRow);
                });
                container.appendChild(childContainer);
            }
        });
    }

    function createParamRow(p, idx, group) {
        const row = document.createElement('div');
        row.className = 'param-row';
        row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap';
        row.innerHTML = escapeHtml('') + `
            <input type="text" value="${escapeHtml(p.name || '')}" placeholder="参数名" style="width:100px" data-field="name" data-index="${idx}">
            <input type="text" value="${escapeHtml(p.label || '')}" placeholder="显示名" style="width:100px" data-field="label" data-index="${idx}">
            <select data-field="type" data-index="${idx}" style="width:120px">
                ${PARAM_TYPES.map(t =>
                    `<option value="${t.value}" ${(p.type || 'String') === t.value ? 'selected' : ''}>${t.label}</option>`
                ).join('')}
            </select>
            <label style="font-size:12px"><input type="checkbox" ${p.required ? 'checked' : ''} data-field="required" data-index="${idx}"> 必填</label>
            <input type="text" value="${escapeHtml(p.placeholder || '')}" placeholder="提示文字" style="width:120px" data-field="placeholder" data-index="${idx}">
            <button class="btn-sm danger" onclick="this.closest('.param-row').remove()">删除</button>
        `;
        row.dataset.group = group || 'input';

        // 如果类型是 Object，添加"添加子属性"按钮
        const typeSelect = row.querySelector('[data-field="type"]');
        const addChildrenBtn = document.createElement('button');
        addChildrenBtn.className = 'btn-sm btn-secondary';
        addChildrenBtn.textContent = '+ 子属性';
        addChildrenBtn.style.display = (p.type === 'Object') ? 'inline-block' : 'none';

        // 如果类型是 Array 且有 item_type，或者初始数据中已有 item_type，显示元素类型选择器
        if (p.type === 'Array') {
            const itemTypeDiv = document.createElement('div');
            itemTypeDiv.className = 'item-type-row';
            itemTypeDiv.style.cssText = 'display:flex;gap:8px;align-items:center;margin-left:20px;margin-bottom:4px';
            const savedItemType = p.item_type || 'String';
            itemTypeDiv.innerHTML = escapeHtml('') + `
                <span style="font-size:12px;color:#888">元素类型:</span>
                <select data-field="item_type" style="width:120px;padding:2px 6px;border:1px solid #ddd;border-radius:4px">
                    ${['String','Integer','Number','Boolean','Time','Object','File'].map(t =>
                        `<option value="${t}" ${savedItemType === t ? 'selected' : ''}>${t}</option>`
                    ).join('')}
                </select>
            `;
            row.insertBefore(itemTypeDiv, addChildrenBtn);
            // 元素类型变化时也要处理
            itemTypeDiv.querySelector('select').addEventListener('change', function() {
                const oldChildren2 = row.nextElementSibling;
                if (oldChildren2 && oldChildren2.classList.contains('param-children-container')) {
                    oldChildren2.remove();
                }
                addChildrenBtn.style.display = this.value === 'Object' ? 'inline-block' : 'none';
            });
            // 如果元素类型是 Object，显示子属性按钮
            if (savedItemType === 'Object') {
                addChildrenBtn.style.display = 'inline-block';
            }
        }
        addChildrenBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const parentName = row.querySelector('[data-field="name"]').value.trim() || 'parent';
            const childContainer = row.nextElementSibling;
            if (childContainer && childContainer.classList.contains('param-children-container')) {
                // 已有子属性容器，直接添加
                const childIdx = childContainer.children.length;
                const childRow = createParamRow({}, childIdx, group);
                childRow.classList.add('param-child-row');
                childRow.style.marginLeft = '24px';
                childRow.dataset.parent = parentName;
                childContainer.appendChild(childRow);
            } else {
                // 创建子属性容器
                const container = document.createElement('div');
                container.className = 'param-children-container';
                container.style.cssText = 'margin-left:24px;padding-left:12px;border-left:2px solid var(--border-color);';
                const childRow = createParamRow({}, 0, group);
                childRow.classList.add('param-child-row');
                childRow.dataset.parent = parentName;
                container.appendChild(childRow);
                row.after(container);
            }
        });
        row.appendChild(addChildrenBtn);

        // 类型切换时处理子参数和元素类型
        typeSelect.addEventListener('change', function() {
            const row = this.closest('.param-row');

            // 清理旧的子参数容器
            const oldChildren = row.nextElementSibling;
            if (oldChildren && oldChildren.classList.contains('param-children-container')) {
                oldChildren.remove();
            }

            const newType = this.value;

            // 处理 Array 类型的元素类型选择器
            if (newType === 'Array') {
                let itemTypeDiv = row.querySelector('.item-type-row');
                if (!itemTypeDiv) {
                    itemTypeDiv = document.createElement('div');
                    itemTypeDiv.className = 'item-type-row';
                    itemTypeDiv.style.cssText = 'display:flex;gap:8px;align-items:center;margin-left:20px;margin-bottom:4px';
                    itemTypeDiv.innerHTML = escapeHtml('') + `
                        <span style="font-size:12px;color:#888">元素类型:</span>
                        <select data-field="item_type" style="width:120px;padding:2px 6px;border:1px solid #ddd;border-radius:4px">
                            ${['String','Integer','Number','Boolean','Time','Object','File'].map(t =>
                                `<option value="${t}">${t}</option>`
                            ).join('')}
                        </select>
                    `;
                    // 插入到子属性按钮之前
                    row.insertBefore(itemTypeDiv, addChildrenBtn);
                    // 元素类型变化时也要处理
                    itemTypeDiv.querySelector('select').addEventListener('change', function() {
                        // 清理子参数
                        const oldChildren2 = row.nextElementSibling;
                        if (oldChildren2 && oldChildren2.classList.contains('param-children-container')) {
                            oldChildren2.remove();
                        }
                        // 只有元素类型是 Object 时才显示添加子属性按钮
                        addChildrenBtn.style.display = this.value === 'Object' ? 'inline-block' : 'none';
                    });
                }
                itemTypeDiv.style.display = '';
                // 默认元素类型是 String，不显示子属性按钮
                const currentItemType = itemTypeDiv.querySelector('[data-field="item_type"]').value;
                addChildrenBtn.style.display = currentItemType === 'Object' ? 'inline-block' : 'none';
            } else {
                // 隐藏元素类型选择器
                const itemTypeDiv = row.querySelector('.item-type-row');
                if (itemTypeDiv) itemTypeDiv.style.display = 'none';
                // Object 类型显示子属性按钮
                addChildrenBtn.style.display = newType === 'Object' ? 'inline-block' : 'none';
            }
        });

        return row;
    }

    function addParamRow(containerId) {
        const container = document.getElementById(containerId);
        const idx = container.children.length;
        const group = containerId === 'output-params-editor' ? 'output' : 'input';
        const row = createParamRow({}, idx, group);
        container.appendChild(row);
    }
    window.addParamRow = addParamRow;
    window.saveParams = saveParams;

    // ==================== 导入参数 JSON ====================
    function importParamsFromJson(group) {
        document.getElementById('import-json-target').value = group;
        document.getElementById('import-json-textarea').value = '';
        openModal('modal-import-json');
    }
    window.importParamsFromJson = importParamsFromJson;

    function createParamRowWithData(containerId, paramData) {
        const group = containerId === 'output-params-editor' ? 'output' : 'input';
        const container = document.getElementById(containerId);
        const idx = container.children.length;
        const row = createParamRow(paramData, idx, group);
        return row;
    }

    // 根据值推断 Coze 参数类型
    function inferParamType(value) {
        if (value === null || value === undefined) return 'String';
        if (typeof value === 'boolean') return 'Boolean';
        if (typeof value === 'number') return Number.isInteger(value) ? 'Integer' : 'Number';
        if (Array.isArray(value)) return 'Array';
        if (typeof value === 'object') return 'Object';
        return 'String';
    }

    // 从 JSON 值推断参数定义
    function inferParamFromValue(key, value, group) {
        const type = inferParamType(value);
        const param = {
            name: key,
            label: key,
            type: type,
            required: false,
            default: '',
            placeholder: '',
            item_type: '',
            children: [],
            group: group
        };

        if (type === 'Array' && value.length > 0) {
            // 推断数组元素类型
            const firstItem = value[0];
            if (typeof firstItem === 'object' && firstItem !== null && !Array.isArray(firstItem)) {
                param.item_type = 'Object';
                // 提取子属性
                param.children = Object.keys(firstItem).map(ck => {
                    return inferParamFromValue(ck, firstItem[ck], group);
                });
            } else {
                param.item_type = inferParamType(firstItem);
            }
            // 用示例值作为 placeholder
            param.placeholder = JSON.stringify(value[0]);
        } else if (type === 'Object') {
            // 提取子属性
            param.children = Object.keys(value).map(ck => {
                return inferParamFromValue(ck, value[ck], group);
            });
            param.placeholder = JSON.stringify(value);
        } else {
            param.placeholder = String(value);
        }

        return param;
    }

    function doImportParamsJson() {
        const group = document.getElementById('import-json-target').value;
        const textarea = document.getElementById('import-json-textarea');
        const containerId = group === 'input' ? 'input-params-editor' : 'output-params-editor';

        try {
            let parsed = JSON.parse(textarea.value);

            // 如果是已有的参数数组格式（带 name/type 等字段），直接使用
            if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].name && parsed[0].type) {
                const container = document.getElementById(containerId);
                parsed.forEach(p => {
                    p.group = group;
                    const row = createParamRowWithData(containerId, p);
                    container.appendChild(row);
                    if (p.children && p.children.length > 0) {
                        appendChildRows(container, row, p, group);
                    }
                });
                closeModal('modal-import-json');
                showToast(`成功导入 ${parsed.length} 个参数`, 'success');
                return;
            }

            // 如果是 input_parameters/output_parameters 格式
            if (parsed.input_parameters || parsed.output_parameters) {
                const targetParams = group === 'input' ? (parsed.input_parameters || []) : (parsed.output_parameters || []);
                const container = document.getElementById(containerId);
                targetParams.forEach(p => {
                    p.group = group;
                    const row = createParamRowWithData(containerId, p);
                    container.appendChild(row);
                    if (p.children && p.children.length > 0) {
                        appendChildRows(container, row, p, group);
                    }
                });
                closeModal('modal-import-json');
                showToast(`成功导入 ${targetParams.length} 个参数`, 'success');
                return;
            }

            // 智能推断：从 JSON 示例值推断参数
            let exampleObj = parsed;
            if (Array.isArray(exampleObj)) {
                // 如果是数组，取第一个元素
                if (exampleObj.length > 0 && typeof exampleObj[0] === 'object') {
                    exampleObj = exampleObj[0];
                } else {
                    // 简单值数组，创建单个参数
                    exampleObj = { items: parsed };
                }
            }

            if (typeof exampleObj !== 'object' || exampleObj === null) {
                showToast('JSON 格式不支持，请传入对象或数组', 'warning');
                return;
            }

            const params = Object.keys(exampleObj).map(key => {
                return inferParamFromValue(key, exampleObj[key], group);
            });

            const container = document.getElementById(containerId);
            params.forEach(p => {
                const row = createParamRowWithData(containerId, p);
                container.appendChild(row);
                if (p.children && p.children.length > 0) {
                    appendChildRows(container, row, p, group);
                }
            });

            closeModal('modal-import-json');
            showToast(`成功导入 ${params.length} 个参数`, 'success');
        } catch (e) {
            showToast('JSON 格式错误: ' + e.message, 'error');
        }
    }

    function appendChildRows(container, parentRow, param, group) {
        const childContainer = document.createElement('div');
        childContainer.className = 'param-children-container';
        childContainer.style.cssText = 'margin-left:24px;padding-left:12px;border-left:2px solid var(--border-color);';
        (param.children || []).forEach((child, ci) => {
            child.group = group;
            const childRow = createParamRow(child, ci, group);
            childRow.classList.add('param-child-row');
            childRow.style.marginLeft = '24px';
            childRow.dataset.parent = param.name;
            childContainer.appendChild(childRow);
        });
        container.appendChild(childContainer);
    }
    window.doImportParamsJson = doImportParamsJson;
    window.openAiGenInline = openAiGenInline;
    window.generateParamsInline = generateParamsInline;
    window.cancelGenInline = cancelGenInline;

    // 暴露当前作品上下文给创作端面板（F7 剧情树 / F8 角色版图）
    // 面板入口通过 getCurrentProjectId() 获取绑定的 novel_creation 项目 id
    window.StoryForgeApp = {
        getCurrentProjectId: function () {
            return (state.currentWork && state.currentWork.project_id) || '';
        },
        getCurrentWorkId: function () {
            return state.currentWorkId || '';
        }
    };

    function collectParamsFromContainer(containerId, group) {
        const container = document.getElementById(containerId);
        const rows = container.querySelectorAll(':scope > .param-row');
        const parameters = [];
        rows.forEach(row => {
            const name = row.querySelector('[data-field="name"]').value.trim();
            if (!name) return;
            const param = {
                name: name,
                label: row.querySelector('[data-field="label"]').value.trim() || name,
                type: row.querySelector('[data-field="type"]').value,
                required: row.querySelector('[data-field="required"]').checked,
                default: "",
                placeholder: row.querySelector('[data-field="placeholder"]').value.trim(),
                group: group
            };

            // 如果是 Object 类型，收集子属性
            if (param.type === 'Object') {
                const childContainer = row.nextElementSibling;
                if (childContainer && childContainer.classList.contains('param-children-container')) {
                    const childRows = childContainer.querySelectorAll('.param-child-row');
                    const children = [];
                    childRows.forEach(childRow => {
                        const childName = childRow.querySelector('[data-field="name"]').value.trim();
                        if (!childName) return;
                        children.push({
                            name: childName,
                            label: childRow.querySelector('[data-field="label"]').value.trim() || childName,
                            type: childRow.querySelector('[data-field="type"]').value,
                            required: childRow.querySelector('[data-field="required"]').checked,
                            default: "",
                            placeholder: childRow.querySelector('[data-field="placeholder"]').value.trim(),
                            group: group,
                            parent: name
                        });
                    });
                    if (children.length > 0) {
                        param.children = children;
                    }
                }
            }

            // 如果是 Array 类型，收集 item_type
            if (param.type === 'Array') {
                const itemTypeSelect = row.querySelector('[data-field="item_type"]');
                if (itemTypeSelect) {
                    param.item_type = itemTypeSelect.value;
                }
                // 如果 item_type 是 Object，也收集子属性
                if (param.item_type === 'Object') {
                    const childContainer = row.nextElementSibling;
                    if (childContainer && childContainer.classList.contains('param-children-container')) {
                        const childRows = childContainer.querySelectorAll('.param-child-row');
                        const children = [];
                        childRows.forEach(childRow => {
                            const childName = childRow.querySelector('[data-field="name"]').value.trim();
                            if (!childName) return;
                            children.push({
                                name: childName,
                                label: childRow.querySelector('[data-field="label"]').value.trim() || childName,
                                type: childRow.querySelector('[data-field="type"]').value,
                                required: childRow.querySelector('[data-field="required"]').checked,
                                default: "",
                                placeholder: childRow.querySelector('[data-field="placeholder"]').value.trim(),
                                group: group,
                                parent: name
                            });
                        });
                        if (children.length > 0) {
                            param.children = children;
                        }
                    }
                }
            }

            parameters.push(param);
        });
        return parameters;
    }

    async function saveParams() {
        const workId = document.getElementById('edit-params-work-id').value;
        const inputParams = collectParamsFromContainer('input-params-editor', 'input');
        const outputParams = collectParamsFromContainer('output-params-editor', 'output');
        const parameters = [...inputParams, ...outputParams];
        try {
            await api.request(`/api/admin/works/${workId}`, {
                method: 'PUT', body: JSON.stringify({ parameters })
            });
            showToast(`已保存 ${parameters.length} 个参数`, 'success');
            closeModal('modal-edit-params');
            await loadAdminData();
        } catch (e) {
            showToast('保存失败: ' + e.message, 'error');
        }
    }

    // ==================== Workflow View (体验页) ====================
    function renderWorkflowView(work) {
        const form = document.getElementById('work-form');
        const resultEl = document.getElementById('form-result');
        const contentEl = document.getElementById('result-content');
        form.innerHTML = escapeHtml('');
        if (resultEl) resultEl.style.display = 'none';

        // 只渲染输入参数
        const parameters = (work.parameters || []).filter(p => p.group !== 'output');
        if (parameters.length === 0) {
            form.innerHTML = escapeHtml('') + '<p style="color:var(--text-tertiary);text-align:center;padding:20px;">该工作流暂无参数配置，请联系管理员配置参数。</p>';
            return;
        }

        parameters.forEach(param => {
            const group = document.createElement('div');
            group.className = 'form-group';

            const label = document.createElement('label');
            label.textContent = param.label || param.name;
            if (param.required) label.textContent += ' *';
            group.appendChild(label);

            const input = createFormInput(param, 'work-form');
            group.appendChild(input);

            if (param.placeholder) {
                const hint = document.createElement('span');
                hint.className = 'form-hint';
                hint.textContent = param.placeholder;
                group.appendChild(hint);
            }

            form.appendChild(group);
        });

        // Submit button
        const submitBtn = document.createElement('button');
        submitBtn.type = 'button';
        submitBtn.className = 'btn-primary';
        submitBtn.textContent = '执行';
        submitBtn.style.marginTop = '8px';
        submitBtn.onclick = async () => {
            await executeWorkflowForm(work, form, resultEl, contentEl);
        };
        form.appendChild(submitBtn);
    }

    async function executeWorkflowForm(work, form, resultEl, contentEl) {
        const parameters = {};
        let hasError = false;

        (work.parameters || []).forEach(param => {
            const type = param.type || 'String';
            if (type === 'Array') {
                const container = form.querySelector(`.array-input-container[data-name="${param.name}"]`);
                if (container) {
                    const inputs = container.querySelectorAll('.array-item-input');
                    parameters[param.name] = Array.from(inputs).map(inp => inp.value).filter(v => v !== '');
                }
            } else if (type === 'Boolean') {
                const toggle = form.querySelector(`.toggle-switch[data-name="${param.name}"]`);
                if (toggle) parameters[param.name] = toggle.dataset.value === 'true';
            } else if (type === 'File') {
                const area = form.querySelector(`.file-upload-area[data-file-id]`);
                if (area) parameters[param.name] = area.dataset.fileId;
            } else if (type === 'Object') {
                const childParams = (param.children || []).filter(c => c.group !== 'output');
                if (childParams.length > 0) {
                    const obj = {};
                    childParams.forEach(child => {
                        const childType = child.type || 'String';
                        if (childType === 'Boolean') {
                            const toggle = form.querySelector(`.toggle-switch[data-name="${child.name}"]`);
                            if (toggle) obj[child.name] = toggle.dataset.value === 'true';
                        } else if (childType === 'File') {
                            const area = form.querySelector(`.file-upload-area[data-file-id]`);
                            if (area) obj[child.name] = area.dataset.fileId;
                        } else {
                            const input = form.querySelector(`[name="${child.name}"]`);
                            if (input) obj[child.name] = input.value;
                        }
                    });
                    parameters[param.name] = obj;
                } else {
                    const textarea = form.querySelector(`textarea[name="${param.name}"]`);
                    if (textarea && textarea.value.trim()) {
                        try {
                            parameters[param.name] = JSON.parse(textarea.value);
                        } catch (e) {
                            parameters[param.name] = textarea.value;
                        }
                    }
                }
            } else if (type === 'Integer') {
                const input = form.querySelector(`[name="${param.name}"]`);
                if (input && input.value !== '') parameters[param.name] = parseInt(input.value, 10) || 0;
            } else if (type === 'Number') {
                const input = form.querySelector(`[name="${param.name}"]`);
                if (input && input.value !== '') parameters[param.name] = parseFloat(input.value) || 0;
            } else {
                const input = form.querySelector(`[name="${param.name}"]`);
                if (input) parameters[param.name] = input.value;
            }

            if (param.required && !parameters[param.name] &&
                !(Array.isArray(parameters[param.name]) && parameters[param.name].length > 0) &&
                !(typeof parameters[param.name] === 'object' && parameters[param.name] !== null && Object.keys(parameters[param.name]).length > 0)) {
                hasError = true;
            }
        });

        if (hasError) {
            showToast('请填写所有必填项', 'warning');
            return;
        }

        if (!resultEl || !contentEl) return;

        resultEl.style.display = 'block';
        contentEl.innerHTML = escapeHtml('') + '<div class="loading-spinner"></div> 正在执行...';

        // 流式执行取消控制：切换页面/卸载时 abort，避免竞态与泄漏
        const controller = new AbortController();
        state.streamController = controller;

        try {
            const token = state.accessTokens[work.id] || '';
            const resp = await api.requestRaw(`/api/works/${work.id}/execute`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Access-Code': token
                },
                body: JSON.stringify({ inputs: parameters, stream: true }),
                signal: controller.signal
            });

            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                contentEl.innerHTML = `<span style="color:var(--danger)">错误: ${escapeHtml(data.message || data.error || '请求失败')}</span>`;
                return;
            }

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let fullContent = '';
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const event = JSON.parse(line.slice(6));
                        if (event.type === 'delta') {
                            fullContent += event.content;
                            contentEl.innerHTML = renderMarkdown(fullContent);
                        } else if (event.type === 'error') {
                            contentEl.innerHTML = `<span style="color:var(--danger)">错误: ${escapeHtml(event.content)}</span>`;
                        }
                    } catch (e) { /* ignore */ }
                }
            }

            if (fullContent) {
                contentEl.innerHTML = renderMarkdown(fullContent);
            }
        } catch (e) {
            // 主动取消（切换页面/卸载）不渲染错误，避免竞态残留
            if (!(e && e.name === 'AbortError')) {
                contentEl.innerHTML = `<span style="color:var(--danger)">请求失败: ${escapeHtml(e.message)}</span>`;
            }
        } finally {
            if (state.streamController === controller) state.streamController = null;
        }
    }

    // ==================== Import ====================
    function _getImportWorkspaceId() {
        return document.getElementById('import-workspace-id')?.value.trim() || '';
    }

    async function testPat() {
        const pat = document.getElementById('import-pat').value.trim();
        if (!pat) {
            showToast('请输入 PAT Token', 'warning');
            return;
        }
        const workspaceId = _getImportWorkspaceId();
        try {
            const result = await api.testPat(pat, workspaceId);
            if (result.success) {
                const count = result.bots ? result.bots.length : 0;
                showToast(`连接成功，找到 ${count} 个作品`, 'success');
            } else {
                showToast('连接失败: ' + (result.error || '未知错误'), 'error');
            }
        } catch (e) {
            showToast('测试失败: ' + e.message, 'error');
        }
    }

    async function fetchBots() {
        const pat = document.getElementById('import-pat').value.trim();
        if (!pat) {
            showToast('请输入 PAT Token', 'warning');
            return;
        }
        const workspaceId = _getImportWorkspaceId();

        try {
            showToast('正在获取作品列表...', 'info');
            const result = await api.getBots(pat, workspaceId);
            if (!result.success) {
                showToast('获取失败: ' + (result.error || '未知错误'), 'error');
                return;
            }
            const allItems = result.bots || [];
            if (allItems.length === 0) {
                showToast('该空间下没有作品', 'warning');
                return;
            }

            // 缓存分类
            state.cachedBots = allItems.filter(item => (item._source_type || 'bot') === 'bot');
            state.cachedWorkflows = allItems.filter(item => item._source_type === 'workflow');

            // 渲染当前 Tab
            renderResourceList();
            document.getElementById('resource-list').style.display = 'block';
            showToast(`找到 ${allItems.length} 个作品（${state.cachedBots.length} 个智能体，${state.cachedWorkflows.length} 个工作流）`, 'success');
        } catch (e) {
            showToast('获取失败: ' + e.message, 'error');
        }
    }

    function renderResourceList() {
        const tab = state.currentResourceTab;
        let items = [];
        if (tab === 'all') {
            items = [...state.cachedBots, ...state.cachedWorkflows];
        } else if (tab === 'bots') {
            items = state.cachedBots;
        } else if (tab === 'workflows') {
            items = state.cachedWorkflows;
        }

        // 切换 Tab 时重置全选状态
        const selectAllCb = document.getElementById('select-all-resources');
        if (selectAllCb) selectAllCb.checked = false;

        const container = document.getElementById('resource-items');
        container.innerHTML = escapeHtml('') + items.map(item => {
            const isWorkflow = (item._source_type || 'bot') === 'workflow';
            const itemId = isWorkflow ? (item.workflow_id || item.id) : (item.bot_id || item.id);
            const iconHtml = item.icon_url
                ? `<img class="bot-item-icon" src="${escapeHtml(item.icon_url)}" alt="" onerror="this.style.display='none'">`
                : '';
            const typeBadge = isWorkflow ? '<span style="font-size:11px;color:var(--primary);background:var(--primary-bg);padding:1px 6px;border-radius:4px;margin-left:4px">工作流</span>' : '';
            return `
                <div class="bot-item" data-item-id="${escapeHtml(String(itemId))}" data-source-type="${isWorkflow ? 'workflow' : 'bot'}">
                    <input type="checkbox" value="${escapeHtml(String(itemId))}" data-source-type="${isWorkflow ? 'workflow' : 'bot'}">
                    ${iconHtml}
                    <div class="bot-item-info">
                        <div class="bot-item-name">${escapeHtml(item.name)}${typeBadge}</div>
                        <div class="bot-item-desc">${escapeHtml(item.description || '暂无描述')}</div>
                    </div>
                </div>
            `;
        }).join('');

        // Bind click to toggle selection
        container.querySelectorAll('.bot-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.tagName === 'INPUT') return;
                const cb = item.querySelector('input[type="checkbox"]');
                cb.checked = !cb.checked;
                item.classList.toggle('selected', cb.checked);
                syncSelectAll();
            });
            item.querySelector('input[type="checkbox"]').addEventListener('change', () => {
                item.classList.toggle('selected', item.querySelector('input[type="checkbox"]').checked);
                syncSelectAll();
            });
        });

        // 同步全选状态
        function syncSelectAll() {
            const allCbs = container.querySelectorAll('.bot-item input[type="checkbox"]');
            const checkedCount = container.querySelectorAll('.bot-item input[type="checkbox"]:checked').length;
            selectAllCb.checked = allCbs.length > 0 && checkedCount === allCbs.length;
        }

        // Select all
        selectAllCb.onchange = function () {
            const checked = this.checked;
            container.querySelectorAll('.bot-item').forEach(item => {
                const cb = item.querySelector('input[type="checkbox"]');
                cb.checked = checked;
                item.classList.toggle('selected', checked);
            });
        };
    }

    async function importSelectedResources() {
        const pat = document.getElementById('import-pat').value.trim();
        const workspaceId = _getImportWorkspaceId();
        const selectedItems = [];

        document.querySelectorAll('#resource-items input:checked').forEach(cb => {
            const sourceType = cb.dataset.sourceType || 'bot';
            const itemId = cb.value;
            let item;
            if (sourceType === 'workflow') {
                item = state.cachedWorkflows.find(w => String(w.workflow_id || w.id) === itemId);
            } else {
                item = state.cachedBots.find(b => String(b.bot_id || b.id) === itemId);
            }
            if (item) {
                selectedItems.push({ ...item, _source_type: sourceType });
            }
        });

        if (!pat) {
            showToast('请输入 PAT Token', 'warning');
            return;
        }
        if (selectedItems.length === 0) {
            showToast('请选择要导入的作品', 'warning');
            return;
        }

        try {
            showToast(`正在导入 ${selectedItems.length} 个作品...`, 'info');
            const result = await api.importWorks(pat, selectedItems, '', workspaceId);
            if (result.success) {
                showToast(`导入完成: 成功 ${result.imported}/${result.total} 个`, result.imported === result.total ? 'success' : 'warning');
                // 部分失败时 result.results 已含错误原因，无需额外日志
                document.querySelectorAll('#resource-items input:checked').forEach(cb => {
                    cb.checked = false;
                    cb.closest('.bot-item').classList.remove('selected');
                });
                const selectAllCb = document.getElementById('select-all-resources');
                if (selectAllCb) selectAllCb.checked = false;
                await loadAdminData();
            }
        } catch (e) {
            showToast('导入失败: ' + e.message, 'error');
        }
    }

    function renderDatasetList() {
        const container = document.getElementById('dataset-items');
        container.innerHTML = escapeHtml('') + state.datasetList.map(ds => {
            const dsId = ds.id || ds.dataset_id;
            const iconHtml = ds.icon_url
                ? `<img class="bot-item-icon" src="${escapeHtml(ds.icon_url)}" alt="" onerror="this.style.display='none'">`
                : '';
            const fileInfo = ds.file_count != null ? ` · ${ds.file_count} 个文件` : '';
            return `
                <div class="bot-item" data-dataset-id="${escapeHtml(String(dsId))}">
                    <input type="checkbox" value="${escapeHtml(String(dsId))}">
                    ${iconHtml}
                    <div class="bot-item-info">
                        <div class="bot-item-name">${escapeHtml(ds.name)}</div>
                        <div class="bot-item-desc">${escapeHtml(ds.description || '暂无描述')}${fileInfo}</div>
                    </div>
                </div>
            `;
        }).join('');

        // Bind click to toggle selection
        container.querySelectorAll('.bot-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.tagName === 'INPUT') return;
                const cb = item.querySelector('input[type="checkbox"]');
                cb.checked = !cb.checked;
                item.classList.toggle('selected', cb.checked);
            });
            item.querySelector('input[type="checkbox"]').addEventListener('change', () => {
                item.classList.toggle('selected', item.querySelector('input[type="checkbox"]').checked);
            });
        });

        // Select all
        document.getElementById('select-all-datasets').onchange = function () {
            const checked = this.checked;
            container.querySelectorAll('.bot-item').forEach(item => {
                const cb = item.querySelector('input[type="checkbox"]');
                cb.checked = checked;
                item.classList.toggle('selected', checked);
            });
        };
    }

    async function importSelectedDatasets() {
        const pat = document.getElementById('import-pat').value.trim();
        const accessCode = document.getElementById('import-access-code').value.trim();
        const selected = Array.from(document.querySelectorAll('#dataset-items input:checked')).map(cb => cb.value);

        if (!pat) {
            showToast('请输入 PAT Token', 'warning');
            return;
        }
        if (selected.length === 0) {
            showToast('请选择要导入的知识库', 'warning');
            return;
        }

        let successCount = 0;
        let failCount = 0;

        for (const datasetId of selected) {
            try {
                const result = await api.importDataset(pat, datasetId, accessCode);
                if (result.success) {
                    successCount++;
                } else {
                    failCount++;
                }
            } catch (e) {
                failCount++;
            }
        }

        const total = selected.length;
        showToast(`知识库导入完成: 成功 ${successCount}/${total} 个`, successCount === total ? 'success' : 'warning');
        document.querySelectorAll('#dataset-items input:checked').forEach(cb => {
            cb.checked = false;
            cb.closest('.dataset-item')?.classList.remove('selected');
        });
        await loadAdminData();
    }

    // ==================== Settings ====================
    async function saveSettings() {
        const name = document.getElementById('setting-name').value.trim();
        const desc = document.getElementById('setting-desc').value.trim();
        const theme = document.getElementById('setting-theme').value;
        const password = document.getElementById('setting-password').value.trim();

        const updates = {
            site_name: name,
            site_description: desc,
            theme: theme
        };
        if (password) {
            updates.admin_password = password;
        }

        try {
            await api.updateConfig(updates);
            document.getElementById('setting-password').value = '';
            document.body.dataset.theme = theme;
            showToast('设置已保存', 'success');
        } catch (e) {
            showToast('保存失败: ' + e.message, 'error');
        }
    }

    // ==================== Confirm Modal ====================
    let confirmCallback = null;

    function showConfirm(title, message, callback) {
        document.getElementById('confirm-title').textContent = title;
        document.getElementById('confirm-message').textContent = message;
        document.getElementById('modal-confirm').style.display = 'flex';
        confirmCallback = callback;
    }

    function hideConfirm() {
        document.getElementById('modal-confirm').style.display = 'none';
        confirmCallback = null;
    }

    // ==================== Toast ====================
    function showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(20px)';
            toast.style.transition = 'all 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ==================== Markdown ====================
    // 白名单标签（marked/GFM 输出子集，含 hljs 高亮 span、任务列表 input）
    const SANITIZE_ALLOWED_TAGS = new Set([
        'p', 'br', 'hr', 'strong', 'em', 'b', 'i', 'u', 'del', 's',
        'ul', 'ol', 'li', 'code', 'pre', 'blockquote',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'a', 'img', 'span', 'div',
        'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
        'input'
    ]);

    // 各标签允许的属性白名单（on* 一律剥离；class 仅用于 hljs 高亮）
    const SANITIZE_ALLOWED_ATTRS = {
        a: new Set(['href', 'title', 'rel']),
        img: new Set(['src', 'alt', 'title']),
        span: new Set(['class']),
        code: new Set(['class']),
        pre: new Set(['class']),
        div: new Set(['class']),
        th: new Set(['align']),
        td: new Set(['align']),
        input: new Set(['type', 'checked', 'disabled'])
    };

    function sanitizeHtml(html) {
        if (!html) return '';
        const doc = new DOMParser().parseFromString(html, 'text/html');

        const stripNodes = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'form', 'svg', 'math']);

        const walk = (parent) => {
            [...parent.children].forEach((child) => {
                walk(child);
                const tag = child.tagName.toLowerCase();
                if (stripNodes.has(tag)) {
                    child.remove();
                    return;
                }
                if (!SANITIZE_ALLOWED_TAGS.has(tag)) {
                    // 未列出的标签：保留其子节点（展开），丢弃标签本身
                    while (child.firstChild) parent.insertBefore(child.firstChild, child);
                    child.remove();
                }
            });
        };
        walk(doc.body);

        // 属性过滤 + 协议校验
        doc.body.querySelectorAll('*').forEach((el) => {
            const tag = el.tagName.toLowerCase();
            const allowed = SANITIZE_ALLOWED_ATTRS[tag] || new Set();
            [...el.attributes].forEach((attr) => {
                const name = attr.name.toLowerCase();
                if (name.startsWith('on')) {
                    el.removeAttribute(attr.name);
                    return;
                }
                if (name === 'style') {
                    el.removeAttribute(attr.name);
                    return;
                }
                if (!allowed.has(name)) {
                    el.removeAttribute(attr.name);
                    return;
                }
                if (name === 'href' || name === 'src') {
                    const val = (attr.value || '').trim().toLowerCase();
                    if (val.startsWith('javascript:') || val.startsWith('vbscript:') ||
                        val.startsWith('data:text/html')) {
                        el.removeAttribute(attr.name);
                        return;
                    }
                    if (val.startsWith('data:') && !val.startsWith('data:image/')) {
                        el.removeAttribute(attr.name);
                        return;
                    }
                }
                if (name === 'rel') {
                    // 只保留 noreferrer/noopener
                    const safeRel = (attr.value || '').split(/\s+/).filter((t) => /^(noreferrer|noopener)$/.test(t)).join(' ');
                    el.setAttribute('rel', safeRel || 'noreferrer noopener');
                }
            });
            // a 标签强制 noopener（防 window.opener 劫持）
            if (tag === 'a') {
                el.setAttribute('rel', (el.getAttribute('rel') || 'noreferrer noopener'));
            }
        });

        return doc.body.innerHTML;
    }

    function renderMarkdown(text) {
        if (typeof marked !== 'undefined') {
            marked.setOptions({
                breaks: true,
                gfm: true,
                highlight: function (code, lang) {
                    if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
                        return hljs.highlight(code, { language: lang }).value;
                    }
                    return code;
                }
            });
            return sanitizeHtml(marked.parse(text));
        }
        return escapeHtml(text).replace(/\n/g, '<br>');
    }

    // ==================== Utilities ====================
    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ==================== Tab Switching ====================
    function initTabs() {
        document.querySelectorAll('.admin-tabs .tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.admin-tabs .tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                const tabId = btn.dataset.tab;
                document.getElementById(`tab-${tabId}`).classList.add('active');
            });
        });
    }

    // ==================== Import Resource Tabs ====================
    function initResourceTabs() {
        document.querySelectorAll('.import-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                // 切换 Tab 按钮样式
                document.querySelectorAll('.import-tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // 切换面板显示
                const tab = btn.dataset.resourceTab;
                state.currentResourceTab = tab;

                // 如果已有缓存数据，直接过滤渲染
                if (state.cachedBots.length > 0 || state.cachedWorkflows.length > 0) {
                    renderResourceList();
                    document.getElementById('resource-list').style.display = 'block';
                }
            });
        });
    }

    // ==================== Mixed Panel Collapse ====================
    function initMixedPanel() {
        const btn = document.getElementById('btn-collapse-panel');
        const panel = document.getElementById('mixed-panel');
        if (btn && panel) {
            btn.addEventListener('click', () => {
                panel.classList.toggle('collapsed');
            });
        }
    }

    // ==================== Event Bindings ====================
    // 将模板中原内联 onclick 的元素统一改为 addEventListener（P1 合规）
    function bindInlineHandlers() {
        const bind = (id, handler) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', handler);
        };

        // 作品管理
        bind('btn-batch-delete-works', batchDeleteWorks);

        // 站点设置 LLM 配置
        bind('btn-fill-doubao-preset', fillGlobalDoubaoPreset);
        bind('btn-save-llm-config', saveGlobalLlmConfig);

        // 参数编辑器模态框
        bind('btn-close-edit-params', () => closeModal('modal-edit-params'));
        bind('btn-cancel-edit-params', () => closeModal('modal-edit-params'));
        bind('btn-save-params', saveParams);
        bind('btn-add-input-param', () => addParamRow('input-params-editor'));
        bind('btn-import-input-json', () => importParamsFromJson('input'));
        bind('btn-ai-gen-input-open', () => openAiGenInline('input'));
        bind('btn-add-output-param', () => addParamRow('output-params-editor'));
        bind('btn-import-output-json', () => importParamsFromJson('output'));
        bind('btn-ai-gen-output-open', () => openAiGenInline('output'));
        bind('btn-ai-gen-input', () => generateParamsInline('input'));
        bind('btn-ai-gen-output', () => generateParamsInline('output'));
        bind('btn-cancel-ai-input', () => cancelGenInline('input'));
        bind('btn-cancel-ai-output', () => cancelGenInline('output'));

        // 导入 JSON 模态框
        bind('btn-close-import-json', () => closeModal('modal-import-json'));
        bind('btn-cancel-import-json', () => closeModal('modal-import-json'));
        bind('btn-do-import-json', doImportParamsJson);
    }

    function bindEvents() {
        // Navigation
        document.getElementById('btn-admin').addEventListener('click', () => {
            window.location.hash = '#admin';
        });

        document.getElementById('btn-back').addEventListener('click', () => {
            window.location.hash = '#home';
        });

        document.getElementById('btn-admin-back').addEventListener('click', () => {
            window.location.hash = '#home';
        });

        // Admin
        document.getElementById('btn-admin-login').addEventListener('click', adminLogin);
        document.getElementById('admin-password').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') adminLogin();
        });

        // Import
        document.getElementById('btn-test-pat').addEventListener('click', testPat);
        document.getElementById('btn-fetch-bots').addEventListener('click', fetchBots);
        const btnImportResources = document.getElementById('btn-import-selected-resources');
        if (btnImportResources) btnImportResources.addEventListener('click', importSelectedResources);

        // Settings
        document.getElementById('btn-save-settings').addEventListener('click', saveSettings);

        // 内联 onclick → addEventListener 绑定（P1：模板不写内联事件）
        bindInlineHandlers();

        // Access code modal
        document.getElementById('btn-submit-access').addEventListener('click', submitAccessCode);
        document.getElementById('access-code-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitAccessCode();
        });
        document.getElementById('btn-cancel-access').addEventListener('click', hideAccessCodeModal);
        document.querySelector('#modal-access-code .modal-overlay').addEventListener('click', hideAccessCodeModal);

        // Confirm modal
        document.getElementById('btn-confirm-ok').addEventListener('click', () => {
            if (confirmCallback) confirmCallback();
            hideConfirm();
        });
        document.getElementById('btn-confirm-cancel').addEventListener('click', hideConfirm);
        document.querySelector('#modal-confirm .modal-overlay').addEventListener('click', hideConfirm);

        // Hash change
        window.addEventListener('hashchange', () => navigate(window.location.hash));

        // Screenshot preview
        document.addEventListener('change', function(e) {
            if (e.target.id === 'workflow-screenshot-inline' && e.target.files[0]) {
                const reader = new FileReader();
                reader.onload = function(ev) {
                    // 安全渲染预览图：createElement + setAttribute，避免拼接 dataURL 注入
                    const preview = document.getElementById('screenshot-preview-inline');
                    if (!preview) return;
                    const img = document.createElement('img');
                    img.setAttribute('src', ev.target.result);
                    img.style.maxWidth = '100%';
                    img.style.maxHeight = '200px';
                    img.style.borderRadius = '8px';
                    img.style.marginTop = '4px';
                    preview.textContent = '';
                    preview.appendChild(img);
                };
                reader.readAsDataURL(e.target.files[0]);
            }
        });

        // Modal overlay close for edit params modal
        document.querySelectorAll('#modal-edit-params .modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', () => {
                const modal = overlay.closest('.modal');
                if (modal) modal.style.display = 'none';
            });
        });

        // ESC 键关闭所有弹窗
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal').forEach(m => {
                    // 兼容 .hidden class 与内联 style.display 两种状态
                    const isShown = !m.classList.contains('hidden') && m.style.display !== 'none';
                    if (isShown) {
                        m.classList.add('hidden');
                        m.style.display = 'none';
                    }
                });
            }
        });

        // 点击遮罩层关闭弹窗（通用）
        document.addEventListener('click', function(e) {
            if (e.target.classList.contains('modal-overlay')) {
                const modal = e.target.closest('.modal');
                if (modal) modal.style.display = 'none';
            }
        });
    }

    // ==================== Init ====================
    // ==================== 主题切换（UI 设计规范 §10 主题切换） ====================
    function initTheme() {
        const body = document.body;
        const toggle = document.getElementById('btn-theme-toggle');
        const STORAGE_KEY = 'storyforge-theme';

        // 恢复上次主题（默认浅色）
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved === 'dark') {
            body.setAttribute('data-theme', 'dark');
        } else {
            body.setAttribute('data-theme', 'light');
        }
        syncThemeToggle();

        if (toggle) {
            toggle.addEventListener('click', () => {
                const isDark = body.getAttribute('data-theme') === 'dark';
                const next = isDark ? 'light' : 'dark';
                body.setAttribute('data-theme', next);
                localStorage.setItem(STORAGE_KEY, next);
                syncThemeToggle();
            });
        }

        function syncThemeToggle() {
            if (!toggle) return;
            const isDark = body.getAttribute('data-theme') === 'dark';
            toggle.setAttribute('aria-pressed', String(isDark));
            toggle.setAttribute('title', isDark ? '切换到浅色主题' : '切换到深色主题');
            toggle.setAttribute('aria-label', isDark ? '切换到浅色主题' : '切换到深色主题');
        }
    }

    function init() {
        initTheme();
        bindEvents();
        initTabs();
        initResourceTabs();
        initMixedPanel();

        // 页面卸载时取消所有进行中的流式/轮询请求，避免泄漏与竞态
        window.addEventListener('beforeunload', () => {
            abortActiveStream();
            ['input', 'output'].forEach(g => _stopGenTask(g));
        });

        // Initial route
        const hash = window.location.hash;
        if (hash) {
            navigate(hash);
        } else {
            showHome();
        }
    }

    // Start
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
