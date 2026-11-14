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
        // 异步预取，不阻塞首屏；Task 5/6 实现具体加载。
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

    function _roleItems() { return []; }
    function _agentItems() { return []; }
    function _syncChip() { state.chip.textContent = ''; }
    function _showList() { _renderList(); }
    function _runToolCommand(cmd) { if (cmd.route) { global.location.hash = cmd.route; factory.close(); } }
    function _runNavCommand(cmd) { factory.close(); }

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
    };
    global.StoryForgeCommandPalette = factory;
})(typeof window !== 'undefined' ? window : globalThis);
