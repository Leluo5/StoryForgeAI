// P5-T5b 命令面板：工具 / 导航 / 角色 / 工具 Agent 四类命令统一入口。
// 首屏零网络：静态命令清单 + 样式注入同步完成；角色与 Agent 数据异步预取。
// 用法：StoryForgeCommandPalette.createButton({ mountEl }); Ctrl/Cmd+K 切换。
(function (global) {
    'use strict';

    async function _request(url, options) {
        const opts = options || {};
        const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
        const resp = await fetch(url, Object.assign({}, opts, { headers }));
        let body = null;
        try { body = await resp.json(); } catch (e) { /* 非 JSON */ }
        if (!resp.ok) throw new Error((body && (body.message || body.error)) || ('HTTP ' + resp.status));
        if (body && typeof body === 'object' && typeof body.code === 'number') {
            if (body.code !== 0) throw new Error(body.message || ('业务错误 ' + body.code));
            return body.data;
        }
        return body;
    }

    function _toast(msg, type) {
        let box = document.getElementById('cp-toast-box');
        if (!box) {
            box = document.createElement('div');
            box.id = 'cp-toast-box';
            box.className = 'cp-toast-box';
            document.body.appendChild(box);
        }
        const el = document.createElement('div');
        el.className = 'cp-toast cp-toast-' + (type || 'info');
        el.textContent = msg;
        box.appendChild(el);
        setTimeout(function () { el.remove(); }, 3600);
    }

    function _el(tag, attrs, children) {
        const node = document.createElement(tag);
        if (tag === 'button') node.setAttribute('type', 'button');
        Object.keys(attrs || {}).forEach(function (k) {
            const v = attrs[k];
            if (k === 'class') node.className = v;
            else if (k === 'text') node.textContent = v;
            else if (k === 'onclick') node.onclick = v;
            else if (k === 'oninput') node.oninput = v;
            else if (k === 'onkeydown') node.onkeydown = v;
            else if (v !== null && v !== undefined) node.setAttribute(k, v);
        });
        (children || []).forEach(function (c) { if (c) node.appendChild(c); });
        return node;
    }

    let _styleInjected = false;
    function _ensureStyle() {
        if (_styleInjected) return;
        _styleInjected = true;
        const css = [
            '.cp-mask{position:fixed;inset:0;z-index:99980;background:rgba(15,23,42,.45);display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;}',
            '.cp-panel{width:min(640px,92vw);max-height:70vh;display:flex;flex-direction:column;background:var(--bg-card,#fff);color:var(--text-primary,#0f172a);border:1px solid var(--border-color,#e2e8f0);border-radius:var(--radius-md,12px);box-shadow:0 20px 50px rgba(0,0,0,.25);overflow:hidden;}',
            '.cp-head{display:flex;align-items:center;gap:var(--sp-2,8px);padding:var(--sp-3,12px) var(--sp-4,16px);border-bottom:1px solid var(--border-color,#e2e8f0);}',
            '.cp-input{flex:1;border:none;outline:none;background:transparent;color:inherit;font-size:var(--fs-body,15px);}',
            '.cp-role-chip{font-size:var(--fs-small,12px);color:var(--text-secondary,#475569);white-space:nowrap;}',
            '.cp-list{flex:1;overflow-y:auto;padding:var(--sp-2,8px);}',
            '.cp-group{padding:var(--sp-2,6px) var(--sp-2,8px);font-size:var(--fs-caption,11px);color:var(--text-tertiary,#64748b);}',
            '.cp-item{display:flex;align-items:center;gap:var(--sp-2,8px);width:100%;text-align:left;padding:var(--sp-2,8px) var(--sp-3,10px);border:none;border-radius:var(--radius-sm,6px);background:transparent;color:inherit;cursor:pointer;}',
            '.cp-item[aria-selected="true"]{background:var(--bg-hover,#f1f5f9);}',
            '.cp-item:disabled{opacity:.45;cursor:not-allowed;}',
            '.cp-item-title{flex:1;font-size:var(--fs-body,14px);}',
            '.cp-item-sub{font-size:var(--fs-caption,11px);color:var(--text-tertiary,#64748b);}',
            '.cp-item-action{border:1px solid var(--border-color,#cbd5e1);border-radius:var(--radius-sm,5px);background:transparent;color:inherit;font-size:var(--fs-caption,11px);padding:2px 8px;cursor:pointer;}',
            '.cp-form{padding:var(--sp-4,16px);display:flex;flex-direction:column;gap:var(--sp-3,10px);overflow-y:auto;}',
            '.cp-meta{font-size:var(--fs-small,12px);color:var(--text-secondary,#475569);}',
            '.cp-field{display:flex;flex-direction:column;gap:var(--sp-1,4px);font-size:var(--fs-small,13px);}',
            '.cp-field input,.cp-field select{padding:var(--sp-2,6px) var(--sp-3,8px);border:1px solid var(--border-color,#cbd5e1);border-radius:var(--radius-sm,6px);background:var(--bg-card,#fff);color:inherit;}',
            '.cp-actions{display:flex;gap:var(--sp-2,8px);justify-content:flex-end;}',
            '.cp-btn{padding:var(--sp-2,6px) var(--sp-4,14px);border:1px solid var(--border-color,#cbd5e1);border-radius:var(--radius-sm,6px);background:var(--bg-card,#fff);color:inherit;cursor:pointer;}',
            '.cp-btn.primary{background:var(--accent,#2563eb);border-color:var(--accent,#2563eb);color:var(--text-inverse,#fff);}',
            '.cp-result{padding:var(--sp-3,10px) var(--sp-4,16px);border-top:1px solid var(--border-color,#e2e8f0);font-size:var(--fs-small,12px);white-space:pre-wrap;word-break:break-all;max-height:120px;overflow-y:auto;}',
            '.cp-toast-box{position:fixed;top:var(--sp-4,16px);right:var(--sp-4,16px);z-index:99999;display:flex;flex-direction:column;gap:var(--sp-2,8px);}',
            '.cp-toast{padding:var(--sp-3,10px) var(--sp-4,16px);border-radius:var(--radius-md,8px);color:var(--text-inverse,#fff);background:var(--accent,#2563eb);font-size:var(--fs-body,14px);}',
            '.cp-toast-error{background:var(--danger,#dc2626);}',
            '.cp-toast-success{background:var(--success,#16a34a);}',
            '.cp-toast-warning{background:var(--warning,#d97706);}',
        ].join('\n');
        const style = document.createElement('style');
        style.id = 'cp-style';
        style.textContent = css;
        document.head.appendChild(style);
    }

    // 静态命令清单：14 工具 + 3 导航；角色与 Agent 命令异步生成。
    const TOOL_COMMANDS = [
        { id: 'gen_outline', title: '生成大纲', roleLink: true, longTask: false, params: [{ key: 'theme', label: '主题/题材', type: 'text' }] },
        { id: 'gen_chapter', title: '生成章节', roleLink: true, longTask: false, params: [{ key: 'chapter_title', label: '章节标题', type: 'text' }] },
        { id: 'gen_character_image', title: '生成角色形象', roleLink: true, needRole: true, longTask: false, params: [] },
        { id: 'gen_world_map', title: '生成世界地图', roleLink: false, longTask: false, params: [{ key: 'style', label: '风格', type: 'text' }] },
        { id: 'emotion_analysis', title: '情感分析', roleLink: true, longTask: false, params: [{ key: 'text', label: '待分析文本', type: 'text' }] },
        { id: 'consistency_check', title: '一致性检查', roleLink: true, longTask: false, params: [{ key: 'chapter_id', label: '章节 ID', type: 'text' }] },
        { id: 'create_version', title: '创建版本', roleLink: false, longTask: false, params: [{ key: 'version_name', label: '版本名称', type: 'text' }] },
        { id: 'gen_novel', title: '生成长篇小说', roleLink: true, longTask: true, params: [{ key: 'title', label: '书名', type: 'text' }] },
        { id: 'gen_audiobook', title: '生成有声书', roleLink: false, longTask: true, params: [{ key: 'voice', label: '音色', type: 'text' }] },
        { id: 'run_70_workflow', title: '运行 70 步工作流', roleLink: true, longTask: true, params: [{ key: 'start_step', label: '起始步骤', type: 'text' }] },
        { id: 'export_novel', title: '导出小说', roleLink: false, longTask: false, params: [{ key: 'format', label: '导出格式', type: 'select', options: ['markdown', 'txt'] }] },
        { id: 'new_project', title: '新建作品/项目', route: '#home', requiresProject: false },
        { id: 'open_project', title: '打开作品', route: '#home', requiresProject: false },
        { id: 'open_settings', title: '打开设置', route: '#admin', requiresProject: false },
    ];
    const NAV_COMMANDS = [
        { id: 'nav_plot_tree', title: '剧情树', keywords: ['plot', 'tree'] },
        { id: 'nav_role_map', title: '角色版图', keywords: ['role', 'map'] },
        { id: 'nav_kb_import', title: '知识库角色导入', keywords: ['kb', 'import'] },
    ];

    const state = {
        built: false, open: false, mask: null, list: null, input: null, chip: null,
        result: null, form: null, items: [], activeIndex: 0, lastRenderMs: 0,
        lastFocus: null, projectId: null, roles: null, agents: null,
        loadingRoles: false, loadingAgents: false, executing: false, mode: 'list',
    };

    function _projectId() {
        return (global.StoryForgeApp && global.StoryForgeApp.getCurrentProjectId()) || null;
    }

    function _build() {
        _ensureStyle();
        state.mask = _el('div', { class: 'cp-mask', onclick: function (ev) {
            if (ev.target === state.mask) factory.close();
        } });
        const panel = _el('div', { class: 'cp-panel', role: 'dialog', 'aria-label': '命令面板' });
        state.input = _el('input', { class: 'cp-input', placeholder: '搜索命令、角色或 Agent…', 'aria-label': '搜索命令' });
        state.input.addEventListener('input', function () { _renderList(); });
        state.chip = _el('span', { class: 'cp-role-chip', text: '' });
        state.list = _el('div', { class: 'cp-list', role: 'listbox' });
        state.result = _el('div', { class: 'cp-result', text: '' });
        state.result.style.display = 'none';
        const head = _el('div', { class: 'cp-head' }, [state.input, state.chip]);
        panel.appendChild(head);
        panel.appendChild(state.list);
        panel.appendChild(state.result);
        state.mask.appendChild(panel);
        document.body.appendChild(state.mask);
        state.built = true;
    }

    function _onKeydown(ev) {
        if (ev.isComposing) return;
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
            ev.preventDefault();
            factory.toggle();
            return;
        }
        if (!state.open) return;
        if (ev.key === 'Escape') {
            ev.preventDefault();
            if (state.mode === 'params') { _showList(); } else { factory.close(); }
        } else if (state.mode === 'list' && ev.key === 'ArrowDown') {
            ev.preventDefault(); _move(1);
        } else if (state.mode === 'list' && ev.key === 'ArrowUp') {
            ev.preventDefault(); _move(-1);
        } else if (state.mode === 'list' && ev.key === 'Enter') {
            const item = state.items[state.activeIndex];
            if (item && !item.disabled) { ev.preventDefault(); item.run(); }
        }
    }

    function _prefetch() {
        if (!state.projectId) return;
        _loadRoles();
        _loadAgents();
    }

    async function _loadAgents() {
        if (!state.projectId || state.loadingAgents || state.agents) return;
        state.loadingAgents = true;
        const pid = state.projectId;
        try {
            state.agents = await _request('/api/agents/tools?project_id=' + encodeURIComponent(pid));
        } catch (e) {
            state.agents = { error: e.message };
        } finally {
            state.loadingAgents = false;
            if (state.open) _renderList();
        }
    }

    function _staticItems() {
        const pid = state.projectId;
        const tools = TOOL_COMMANDS.map(function (cmd) {
            const disabled = cmd.requiresProject === false ? false : !pid;
            return {
                id: cmd.id, category: 'tool', title: cmd.title,
                subtitle: cmd.route ? '跳转' : (cmd.longTask ? '后台任务' : '写作工具'),
                keywords: [cmd.id], disabled: disabled,
                run: function () { _runToolCommand(cmd); },
            };
        });
        const navs = NAV_COMMANDS.map(function (cmd) {
            return {
                id: cmd.id, category: 'nav', title: cmd.title, subtitle: '创作面板',
                keywords: cmd.keywords, disabled: !pid,
                run: function () { _runNavCommand(cmd); },
            };
        });
        return tools.concat(navs);
    }

    function _matches(item, kw) {
        if (!kw) return true;
        const hay = (item.title + ' ' + (item.subtitle || '') + ' ' + (item.keywords || []).join(' ')).toLowerCase();
        return kw.split(/\s+/).every(function (part) { return hay.indexOf(part) !== -1; });
    }

    function _renderList() {
        state.mode = 'list';
        const kw = state.input.value.trim().toLowerCase();
        const all = _staticItems().concat(_roleItems(), _agentItems());
        state.items = all.filter(function (item) { return _matches(item, kw); });
        state.activeIndex = 0;
        const frag = document.createDocumentFragment();
        let lastCat = null;
        state.items.forEach(function (item, idx) {
            if (item.category !== lastCat) {
                lastCat = item.category;
                frag.appendChild(_el('div', { class: 'cp-group', text: CATEGORY_LABELS[lastCat] || lastCat }));
            }
            const row = _el('button', {
                class: 'cp-item', role: 'option', 'aria-selected': idx === 0 ? 'true' : 'false',
                'data-index': String(idx),
                onclick: function () { if (!item.disabled) item.run(); },
            });
            row.disabled = !!item.disabled;
            row.appendChild(_el('span', { class: 'cp-item-title', text: item.title }));
            if (item.subtitle) row.appendChild(_el('span', { class: 'cp-item-sub', text: item.subtitle }));
            (item.actions || []).forEach(function (action) {
                row.appendChild(_el('span', {
                    class: 'cp-item-action', role: 'button', tabindex: '0', text: action.label,
                    onclick: function (ev) { ev.stopPropagation(); action.run(); },
                    onkeydown: function (ev) { if (ev.key === 'Enter') { ev.stopPropagation(); action.run(); } },
                }));
            });
            frag.appendChild(row);
        });
        if (!state.items.length) frag.appendChild(_el('div', { class: 'cp-group', text: '无匹配命令' }));
        state.list.replaceChildren(frag);
    }

    function _move(delta) {
        if (!state.items.length) return;
        state.activeIndex = (state.activeIndex + delta + state.items.length) % state.items.length;
        const rows = state.list.querySelectorAll('.cp-item');
        rows.forEach(function (row, idx) {
            row.setAttribute('aria-selected', idx === state.activeIndex ? 'true' : 'false');
            if (idx === state.activeIndex) row.scrollIntoView({ block: 'nearest' });
        });
    }

    const CATEGORY_LABELS = { tool: '工具', nav: '导航', role: '角色', agent: '工具 Agent' };

    const ROLE_KEY_PREFIX = 'storyforge:active-role:';

    function getActiveRole(projectId) {
        try {
            const raw = global.localStorage.getItem(ROLE_KEY_PREFIX + projectId);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }

    function setActiveRole(projectId, role) {
        try { global.localStorage.setItem(ROLE_KEY_PREFIX + projectId, JSON.stringify(role)); } catch (e) { /* 隐私模式降级 */ }
        _syncChip();
        global.dispatchEvent(new CustomEvent('storyforge:active-role-changed', {
            detail: { projectId: projectId, role: role },
        }));
    }

    async function _loadRoles() {
        if (!state.projectId || state.loadingRoles || state.roles) return;
        state.loadingRoles = true;
        const pid = state.projectId;
        try {
            const data = await _request('/api/role-map/graph?project_id=' + encodeURIComponent(pid));
            if (state.projectId !== pid) return;
            state.roles = ((data && data.nodes) || []).map(function (n) {
                return { id: n.id, name: n.name || n.id };
            });
        } catch (e) {
            state.roles = { error: e.message };
        } finally {
            state.loadingRoles = false;
            if (state.open) _renderList();
        }
    }

    function _roleItems() {
        if (!state.projectId) return [];
        if (state.loadingRoles) {
            return [{ id: 'role-loading', category: 'role', title: '角色加载中…', disabled: true, run: function () {} }];
        }
        if (!state.roles) return [];
        if (state.roles.error) {
            return [{ id: 'role-error', category: 'role', title: '角色加载失败，点击重试', keywords: [], disabled: false,
                run: function () { state.roles = null; _loadRoles(); } }];
        }
        return state.roles.map(function (role) {
            return {
                id: 'role:' + role.id, category: 'role', title: role.name,
                subtitle: '角色', keywords: [role.id, role.name],
                run: function () {
                    setActiveRole(state.projectId, role);
                    _toast('已切换当前角色：' + role.name, 'success');
                },
                actions: [{ label: '详情', run: function () {
                    factory.close();
                    global.StoryForgeRoleMap.openDetail({ projectId: state.projectId, roleId: role.id, roleName: role.name, apiBase: '' });
                } }],
            };
        });
    }

    function _agentItems() {
        if (!state.projectId) return [];
        if (state.loadingAgents) {
            return [{ id: 'agent-loading', category: 'agent', title: '工具 Agent 加载中…', disabled: true, run: function () {} }];
        }
        if (!state.agents) return [];
        if (state.agents.error) {
            return [{ id: 'agent-error', category: 'agent', title: '工具 Agent 加载失败，点击重试', disabled: false,
                run: function () { state.agents = null; _loadAgents(); } }];
        }
        const items = [];
        state.agents.forEach(function (group) {
            (group.agents || []).forEach(function (agent) {
                const active = agent.status === 'active';
                const isDefault = agent.id === group.default_agent_id;
                items.push({
                    id: 'agent:' + agent.id, category: 'agent',
                    title: group.tool_name + ' / ' + agent.name,
                    subtitle: (agent.platform || 'coze') + (isDefault ? ' · 当前默认' : '') + (active ? '' : ' · 不可用'),
                    keywords: [group.tool_name, agent.name], disabled: !active || isDefault,
                    run: function () { _switchAgent(group.tool_name, agent); },
                });
            });
        });
        return items;
    }

    async function _switchAgent(toolName, agent) {
        if (state.executing) return;
        state.executing = true;
        try {
            await _request('/api/agents/tools/' + encodeURIComponent(toolName) + '/switch', {
                method: 'POST',
                body: JSON.stringify({ project_id: state.projectId, agent_id: agent.id }),
            });
            state.agents.forEach(function (group) {
                if (group.tool_name === toolName) group.default_agent_id = agent.id;
            });
            _toast('已切换：' + toolName + ' → ' + agent.name, 'success');
            _renderList();
        } catch (e) {
            _toast('切换失败: ' + e.message, 'error');
        } finally {
            state.executing = false;
        }
    }

    function _defaultAgentLabel(toolName) {
        if (!state.agents || state.agents.error) return '未配置默认 Agent';
        const group = state.agents.find(function (g) { return g.tool_name === toolName; });
        if (!group || !group.default_agent_id) return '未配置默认 Agent';
        const agent = (group.agents || []).find(function (a) { return a.id === group.default_agent_id; });
        return agent ? ('默认 Agent：' + agent.name + '（' + (agent.platform || 'coze') + '）') : '未配置默认 Agent';
    }
    function _syncChip() {
        const role = state.projectId ? getActiveRole(state.projectId) : null;
        state.chip.textContent = role ? ('当前角色：' + role.name) : '未选择角色';
    }
    function _showList() {
        if (state.form) { state.form.remove(); state.form = null; }
        state.list.style.display = '';
        state.input.value = '';
        _renderList();
        state.input.focus();
    }
    function _runToolCommand(cmd) {
        if (cmd.route) { global.location.hash = cmd.route; factory.close(); return; }
        if (!state.projectId) { _toast('请先进入作品', 'warning'); return; }
        _showParams(cmd);
    }

    function _showParams(cmd) {
        state.mode = 'params';
        state.list.style.display = 'none';
        const role = getActiveRole(state.projectId);
        const form = _el('div', { class: 'cp-form' });
        form.appendChild(_el('div', { class: 'cp-item-title', text: cmd.title }));
        form.appendChild(_el('div', { class: 'cp-meta', text: _defaultAgentLabel(cmd.id) }));
        if (cmd.roleLink) {
            form.appendChild(_el('div', { class: 'cp-meta', text: role ? ('将以角色 ' + role.name + ' 调用') : '未选择角色' }));
        }
        const inputs = {};
        (cmd.params || []).forEach(function (field) {
            let input;
            if (field.type === 'select') {
                input = _el('select', { 'aria-label': field.label });
                (field.options || []).forEach(function (opt) { input.appendChild(_el('option', { value: opt, text: opt })); });
            } else {
                input = _el('input', { type: 'text', placeholder: '可选', 'aria-label': field.label });
            }
            inputs[field.key] = input;
            form.appendChild(_el('label', { class: 'cp-field', text: field.label }, [input]));
        });
        const runBtn = _el('button', { class: 'cp-btn primary', text: '执行', onclick: function () { _executeTool(cmd, inputs); } });
        if (cmd.needRole && !role) runBtn.disabled = true;
        const backBtn = _el('button', { class: 'cp-btn', text: '返回', onclick: function () { _showList(); } });
        form.appendChild(_el('div', { class: 'cp-actions' }, [backBtn, runBtn]));
        form.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); if (!runBtn.disabled) _executeTool(cmd, inputs); }
        });
        if (state.form) state.form.remove();
        state.form = form;
        state.mask.querySelector('.cp-panel').appendChild(form);
        _setResult(cmd.needRole && !role ? '请先在「角色」命令中选择当前角色' : '');
    }

    function _setResult(text) {
        state.result.textContent = text;
        state.result.style.display = text ? '' : 'none';
    }

    async function _executeTool(cmd, inputs) {
        if (state.executing) return;
        state.executing = true;
        const params = {};
        Object.keys(inputs).forEach(function (key) {
            const value = inputs[key].value.trim();
            if (value) params[key] = value;
        });
        const role = getActiveRole(state.projectId);
        const body = { params: params };
        if (cmd.roleLink && role) body.role_id = role.id;
        _setResult('执行中…');
        try {
            const data = await _request('/api/projects/' + encodeURIComponent(state.projectId) + '/tools/' + encodeURIComponent(cmd.id), {
                method: 'POST', body: JSON.stringify(body),
            });
            if (data && data.task_id) _setResult('已排队，task_id=' + data.task_id);
            else _setResult('执行成功\n' + JSON.stringify(data && data.result, null, 2).slice(0, 500));
        } catch (e) {
            _setResult('执行失败：' + e.message);
        } finally {
            state.executing = false;
        }
    }

    function _runNavCommand(cmd) {
        const pid = state.projectId;
        if (!pid) { _toast('请先进入作品', 'warning'); return; }
        factory.close();
        if (cmd.id === 'nav_plot_tree' && global.StoryForgePlotPanel) {
            global.StoryForgePlotPanel.mount({ mountEl: document.body, apiBase: '', projectId: pid });
        } else if (cmd.id === 'nav_role_map' && global.StoryForgeRoleMap) {
            global.StoryForgeRoleMap.mount({ mountEl: document.body, apiBase: '', projectId: pid });
        } else if (cmd.id === 'nav_kb_import') {
            const entry = document.querySelector('#kb-import-entry button');
            if (entry) entry.click();
            else _toast('知识库入口未就绪', 'warning');
        }
    }

    document.addEventListener('keydown', _onKeydown);

    const factory = {
        createButton(opts) {
            const btn = _el('button', { class: 'cp-btn', text: '命令面板 (Ctrl+K)', onclick: function () { factory.toggle(); } });
            (opts.mountEl || document.body).appendChild(btn);
            return btn;
        },
        open() {
            const t0 = performance.now();
            if (!state.built) _build();
            state.projectId = _projectId();
            state.lastFocus = document.activeElement;
            state.open = true;
            state.mode = 'list';
            state.mask.style.display = 'flex';
            state.input.value = '';
            _renderList();
            _syncChip();
            state.input.focus();
            state.lastRenderMs = performance.now() - t0;
            _prefetch();
        },
        close() {
            if (!state.open) return;
            state.open = false;
            state.mask.style.display = 'none';
            if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
        },
        toggle() { if (state.open) factory.close(); else factory.open(); },
        isOpen() { return state.open; },
        getLastRenderMs() { return state.lastRenderMs; },
        getActiveRole: getActiveRole,
        setActiveRole: setActiveRole,
    };
    global.StoryForgeCommandPalette = factory;
})(typeof window !== 'undefined' ? window : globalThis);
