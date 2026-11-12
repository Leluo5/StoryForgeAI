// static/js/plot_tree_panel.js —— 剧情树前端面板组件（F7-T7~T9）
// 交付：独立可挂载面板组件，导出全局对象 StoryForgePlotPanel。
// 能力：
//   - 剧情树列表 + 创建（manual/outline/novel）
//   - Canvas 树可视化：节点渲染、连线（前置/后置/非线性）、节点拖拽、缩放
//   - 节点操作：新增（含父节点）、编辑、删除（级联）
//   - 关联操作：新增（含环路校验）、删除
//   - 布局保存（拖拽后持久化 position）
//   - 双向联动：push（树→推衍上下文）/ pull（推衍回写）
//   - 导出 / 导入（merge / replace）
// 用法：
//   StoryForgePlotPanel.mount({ projectId, mountEl, apiBase, onClose });
//   StoryForgePlotPanel.createButton({ mountEl, apiBase, projectId });
// 组件自带轻量请求/反馈，不依赖 app.js IIFE 内部符号（对齐 knowledge_panel.js 同构模式）。

(function (global) {
    'use strict';

    // ---------- 轻量请求（复用后端 {code,data,message} 契约） ----------
    async function _request(url, options) {
        const opts = options || {};
        const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
        const fetchOpts = Object.assign({}, opts);
        const resp = await fetch(url, { ...fetchOpts, headers });
        let body = null;
        try { body = await resp.json(); } catch (e) { /* 非 JSON */ }
        if (!resp.ok) {
            const msg = (body && (body.message || body.error)) || ('HTTP ' + resp.status);
            throw new Error(msg);
        }
        if (body && typeof body.code === 'number' && body.code !== 0) {
            throw new Error(body.message || ('业务错误 ' + body.code));
        }
        return body ? body.data : null;
    }

    // ---------- 轻量 toast ----------
    function _ensureToast() {
        let box = document.getElementById('ptp-toast-box');
        if (!box) {
            box = document.createElement('div');
            box.id = 'ptp-toast-box';
            box.style.cssText = 'position:fixed;top:16px;right:16px;z-index:99999;display:flex;flex-direction:column;gap:8px;';
            document.body.appendChild(box);
        }
        return box;
    }
    function _toast(msg, type) {
        const box = _ensureToast();
        const el = document.createElement('div');
        const colors = { success: '#16a34a', warning: '#d97706', error: '#dc2626', info: '#2563eb' };
        el.style.cssText = 'padding:10px 16px;border-radius:8px;color:#fff;font-size:14px;' +
            'box-shadow:0 4px 12px rgba(0,0,0,.2);background:' + (colors[type] || colors.info) + ';' +
            'max-width:420px;word-break:break-all;transition:opacity .3s;';
        el.textContent = msg;
        box.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3600);
    }

    // ---------- DOM 辅助 ----------
    // 本地 HTML 转义（独立组件不依赖 app.js IIFE 内部符号）
    function _escapeHtml(str) {
        if (str === null || str === undefined) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function _el(tag, attrs, children) {
        const node = document.createElement(tag);
        if (attrs) {
            for (const k of Object.keys(attrs)) {
                if (k === 'class') node.className = attrs[k];
                else if (k === 'style') node.style.cssText = attrs[k];
                else if (k === 'text') node.textContent = attrs[k];
                else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
                else node.setAttribute(k, attrs[k]);
            }
        }
        (children || []).forEach(c => {
            if (typeof c === 'string') node.appendChild(document.createTextNode(c));
            else node.appendChild(c);
        });
        return node;
    }

    const STYLE_ID = 'ptp-panel-style';
    function _ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
        .ptp-panel{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f2937;background:#fff;
            border:1px solid #e5e7eb;border-radius:8px;display:flex;flex-direction:column;max-height:80vh;}
        .ptp-header{display:flex;align-items:center;justify-content:space-between;gap:12px;
            padding:12px 16px;border-bottom:1px solid #e5e7eb;background:#f9fafb;border-radius:8px 8px 0 0;}
        .ptp-header h3{margin:0;font-size:16px;font-weight:600;}
        .ptp-close{border:none;background:none;font-size:18px;cursor:pointer;color:#6b7280;line-height:1;}
        .ptp-body{display:flex;gap:12px;padding:12px 16px;min-height:320px;}
        .ptp-sidebar{width:200px;flex-shrink:0;border-right:1px solid #e5e7eb;padding-right:12px;}
        .ptp-sidebar h4{margin:0 0 8px;font-size:13px;color:#6b7280;font-weight:600;}
        .ptp-tree-list{max-height:220px;overflow-y:auto;}
        .ptp-tree-item{padding:6px 10px;border-radius:6px;cursor:pointer;font-size:13px;display:flex;
            justify-content:space-between;align-items:center;gap:6px;}
        .ptp-tree-item:hover{background:#f3f4f6;}
        .ptp-tree-item.active{background:#dbeafe;color:#1d4ed8;font-weight:600;}
        .ptp-tree-count{font-size:11px;color:#9ca3af;}
        .ptp-toolbar{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;}
        .ptp-btn{border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:5px 10px;
            font-size:12px;cursor:pointer;color:#374151;}
        .ptp-btn:hover{background:#f3f4f6;}
        .ptp-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff;}
        .ptp-btn.primary:hover{background:#1d4ed8;}
        .ptp-btn.danger{color:#dc2626;border-color:#fecaca;}
        .ptp-canvas-wrap{flex:1;position:relative;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;
            background:#fafafa;min-height:320px;}
        .ptp-canvas{display:block;cursor:grab;}
        .ptp-canvas:active{cursor:grabbing;}
        .ptp-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
            color:#9ca3af;font-size:14px;flex-direction:column;gap:8px;}
        .ptp-node-editor{margin-top:10px;border-top:1px solid #e5e7eb;padding-top:10px;}
        .ptp-node-editor h4{margin:0 0 8px;font-size:13px;color:#6b7280;font-weight:600;}
        .ptp-field{display:flex;gap:6px;margin-bottom:6px;align-items:center;}
        .ptp-field label{font-size:12px;color:#6b7280;width:56px;flex-shrink:0;}
        .ptp-field input,.ptp-field select,.ptp-field textarea{flex:1;border:1px solid #d1d5db;
            border-radius:6px;padding:5px 8px;font-size:13px;}
        .ptp-field textarea{min-height:48px;resize:vertical;}
        .ptp-field-row{display:flex;gap:8px;margin-bottom:8px;}
        .ptp-form-btn{flex:1;border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:6px;
            font-size:12px;cursor:pointer;}
        .ptp-form-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff;}
        .ptp-tooltip{position:absolute;background:#111827;color:#fff;font-size:12px;padding:4px 8px;
            border-radius:4px;pointer-events:none;opacity:0;transition:opacity .15s;z-index:10;}
        .ptp-search{display:flex;gap:6px;margin-bottom:8px;}
        .ptp-search input{flex:1;border:1px solid #d1d5db;border-radius:6px;padding:5px 8px;font-size:12px;}
        .ptp-log{font-size:11px;color:#9ca3af;margin-top:8px;max-height:60px;overflow-y:auto;}
        `;
        document.head.appendChild(style);
    }

    // ---------- 节点颜色映射（按类型） ----------
    const NODE_COLORS = {
        start: '#2563eb', main: '#16a34a', branch: '#d97706',
        turn: '#9333ea', climax: '#dc2626', end: '#4b5563',
    };
    const LINK_COLORS = { '前置': '#2563eb', '后置': '#d97706', '非线性': '#9333ea' };

    // ---------- 剧情树面板 ----------
    class PlotTreePanel {
        constructor(opts) {
            this.mountEl = opts.mountEl || document.body;
            this.apiBase = opts.apiBase || '';
            this.projectId = opts.projectId || null;
            this.onClose = opts.onClose || null;
            this.trees = [];
            this.currentTree = null;
            this.currentTreeId = null;
            this.scale = 1;
            this.panX = 0;
            this.panY = 0;
            this.dragNodeId = null;
            this.dragOffset = null;
            this.selectedNodeId = null;
            this._build();
        }

        _api(path) {
            return this.apiBase + '/api/plot' + path;
        }

        // ---------- 构建界面 ----------
        _build() {
            _ensureStyle();
            this._root = _el('div', { class: 'ptp-panel' });

            const header = _el('div', { class: 'ptp-header' }, [
                _el('h3', { text: '剧情树' }),
                _el('button', { class: 'ptp-close', text: '×', onclick: () => this._close() }),
            ]);
            this._root.appendChild(header);

            const body = _el('div', { class: 'ptp-body' });

            // 左侧：树列表 + 创建
            const sidebar = _el('div', { class: 'ptp-sidebar' });
            sidebar.appendChild(_el('h4', { text: '剧情树' }));
            this._treeList = _el('div', { class: 'ptp-tree-list' });
            sidebar.appendChild(this._treeList);

            const createBar = _el('div', { class: 'ptp-toolbar' });
            this._newNameInput = _el('input', { placeholder: '新剧情树名' });
            const newBtn = _el('button', { class: 'ptp-btn primary', text: '创建', onclick: () => this._createTree() });
            createBar.appendChild(this._newNameInput);
            createBar.appendChild(newBtn);
            sidebar.appendChild(createBar);

            const genBar = _el('div', { class: 'ptp-toolbar' });
            const genOutlineBtn = _el('button', { class: 'ptp-btn', text: '大纲生成', onclick: () => this._openGenerate('outline') });
            const genNovelBtn = _el('button', { class: 'ptp-btn', text: '小说生成', onclick: () => this._openGenerate('novel') });
            genBar.appendChild(genOutlineBtn);
            genBar.appendChild(genNovelBtn);
            sidebar.appendChild(genBar);
            body.appendChild(sidebar);

            // 右侧：画布 + 工具栏
            const main = _el('div', { style: 'flex:1;display:flex;flex-direction:column;min-width:0;' });

            const toolbar = _el('div', { class: 'ptp-toolbar' });
            this._toolbar = toolbar;
            toolbar.appendChild(_el('button', { class: 'ptp-btn', text: '新增节点', onclick: () => this._openNodeEditor(null) }));
            toolbar.appendChild(_el('button', { class: 'ptp-btn', text: '编辑节点', onclick: () => this._editSelected() }));
            toolbar.appendChild(_el('button', { class: 'ptp-btn danger', text: '删除节点', onclick: () => this._deleteSelected() }));
            toolbar.appendChild(_el('button', { class: 'ptp-btn', text: '新增关联', onclick: () => this._openLinkEditor() }));
            toolbar.appendChild(_el('button', { class: 'ptp-btn', text: '保存布局', onclick: () => this._saveLayout() }));
            toolbar.appendChild(_el('button', { class: 'ptp-btn', text: '导出', onclick: () => this._exportTree() }));
            toolbar.appendChild(_el('button', { class: 'ptp-btn', text: '导入', onclick: () => this._openImport() }));
            toolbar.appendChild(_el('button', { class: 'ptp-btn', text: '推送到聊天室', onclick: () => this._syncRoom('push') }));
            toolbar.appendChild(_el('button', { class: 'ptp-btn', text: '拉取推衍', onclick: () => this._syncRoom('pull') }));
            toolbar.appendChild(_el('button', { class: 'ptp-btn', text: '+', onclick: () => this._zoom(1.2) }));
            toolbar.appendChild(_el('button', { class: 'ptp-btn', text: '−', onclick: () => this._zoom(0.8) }));
            toolbar.appendChild(_el('button', { class: 'ptp-btn', text: '复位', onclick: () => this._resetView() }));
            main.appendChild(toolbar);

            // 搜索
            const searchBar = _el('div', { class: 'ptp-search' });
            this._searchInput = _el('input', { placeholder: '搜索节点...', oninput: () => this._searchNodes() });
            searchBar.appendChild(this._searchInput);
            main.appendChild(searchBar);

            // 画布
            const canvasWrap = _el('div', { class: 'ptp-canvas-wrap' });
            this._canvas = _el('canvas', { class: 'ptp-canvas' });
            this._canvas.width = 900;
            this._canvas.height = 480;
            canvasWrap.appendChild(this._canvas);
            this._emptyHint = _el('div', { class: 'ptp-empty', style: 'display:none;' }, [
                _el('span', { text: '暂无剧情树，请创建或生成' }),
            ]);
            canvasWrap.appendChild(this._emptyHint);
            this._tooltip = _el('div', { class: 'ptp-tooltip' });
            canvasWrap.appendChild(this._tooltip);
            this._canvasWrap = canvasWrap;
            main.appendChild(canvasWrap);

            // 节点编辑器（默认隐藏）
            this._editor = _el('div', { class: 'ptp-node-editor', style: 'display:none;' });
            main.appendChild(this._editor);

            // 日志
            this._log = _el('div', { class: 'ptp-log' });
            main.appendChild(this._log);

            body.appendChild(main);
            this._root.appendChild(body);
            this.mountEl.appendChild(this._root);

            this._bindCanvasEvents();
            this._resizeCanvas();
            this.refresh();
        }

        _close() {
            if (this._root) this._root.remove();
            if (this.onClose) this.onClose();
        }

        _logMsg(msg) {
            if (!this._log) return;
            const line = _el('div', { text: msg });
            this._log.appendChild(line);
            this._log.scrollTop = this._log.scrollHeight;
        }

        // ---------- 列表 & 刷新 ----------
        async refresh() {
            try {
                this.trees = await _request(this._api('/trees'));
                this.trees = (this.trees && this.trees.trees) || [];
                this._renderTreeList();
                if (!this.currentTreeId && this.trees.length) {
                    await this._selectTree(this.trees[0].id);
                } else if (this.currentTreeId) {
                    await this._loadTree(this.currentTreeId);
                }
            } catch (e) {
                _toast('加载剧情树失败: ' + e.message, 'error');
            }
        }

        _renderTreeList() {
            this._treeList.innerHTML = _escapeHtml('');
            this.trees.forEach(t => {
                const item = _el('div', {
                    class: 'ptp-tree-item' + (t.id === this.currentTreeId ? ' active' : ''),
                }, [
                    _el('span', { text: t.name }),
                    _el('span', { class: 'ptp-tree-count', text: t.nodes_count + '节点' }),
                ]);
                item.addEventListener('click', () => this._selectTree(t.id));
                item.addEventListener('dblclick', () => this._confirmDeleteTree(t.id));
                this._treeList.appendChild(item);
            });
            if (!this.trees.length) {
                this._treeList.appendChild(_el('div', { class: 'ptp-tree-count', text: '（暂无）' }));
            }
        }

        async _selectTree(treeId) {
            this.currentTreeId = treeId;
            await this._loadTree(treeId);
            this._renderTreeList();
        }

        async _loadTree(treeId) {
            try {
                this.currentTree = await _request(this._api('/trees/' + treeId));
                this._render();
            } catch (e) {
                _toast('加载剧情树失败: ' + e.message, 'error');
            }
        }

        // ---------- 创建 ----------
        async _createTree() {
            const name = (this._newNameInput.value || '').trim();
            if (!name) { _toast('请输入剧情树名', 'warning'); return; }
            try {
                const tree = await _request(this._api('/trees'), {
                    method: 'POST', body: JSON.stringify({ name, source: 'manual' }),
                });
                this._newNameInput.value = '';
                this.currentTreeId = tree.id;
                await this._loadTree(tree.id);
                await this.refresh();
                _toast('创建成功', 'success');
            } catch (e) {
                _toast('创建失败: ' + e.message, 'error');
            }
        }

        async _confirmDeleteTree(treeId) {
            if (!confirm('确认删除该剧情树？（不可恢复）')) return;
            try {
                await _request(this._api('/trees/' + treeId), { method: 'DELETE' });
                this.currentTreeId = null;
                this.currentTree = null;
                await this.refresh();
                _toast('已删除', 'success');
            } catch (e) {
                _toast('删除失败: ' + e.message, 'error');
            }
        }

        // ---------- 生成（大纲/小说）----------
        _openGenerate(mode) {
            const content = prompt('请输入' + (mode === 'outline' ? '大纲' : '小说拆文') + '内容（≥20字）:');
            if (!content) return;
            const name = prompt('剧情树名称:', mode === 'outline' ? '大纲剧情树' : '小说剧情树') || '生成剧情树';
            this._doGenerate(mode, content, name);
        }

        async _doGenerate(mode, content, name) {
            try {
                const tree = await _request(this._api('/trees/generate'), {
                    method: 'POST', body: JSON.stringify({ mode, content, name }),
                });
                // 生成结果待确认：直接作为新树保存
                this.currentTreeId = tree.id;
                this.currentTree = tree;
                this._render();
                await this.refresh();
                _toast('生成成功（待确认）', 'success');
            } catch (e) {
                _toast('生成失败: ' + e.message, 'error');
            }
        }

        // ---------- 渲染画布 ----------
        _resizeCanvas() {
            const wrap = this._canvasWrap;
            if (!wrap) return;
            const w = wrap.clientWidth || 900;
            const h = wrap.clientHeight || 480;
            this._canvas.width = w;
            this._canvas.height = h;
            this._render();
        }

        _render() {
            const ctx = this._canvas.getContext('2d');
            const W = this._canvas.width;
            const H = this._canvas.height;
            ctx.clearRect(0, 0, W, H);
            if (!this.currentTree || !this.currentTree.nodes || !this.currentTree.nodes.length) {
                this._emptyHint.style.display = 'flex';
                return;
            }
            this._emptyHint.style.display = 'none';

            // 计算布局：按层级分配 x/y（无层级则用 position 或自动）
            this._computeLayout();

            ctx.save();
            ctx.translate(this.panX, this.panY);
            ctx.scale(this.scale, this.scale);

            // 画关联线
            const links = this.currentTree.links || [];
            const nodes = this.currentTree.nodes;
            links.forEach(l => {
                const from = nodes.find(n => n.id === l.from);
                const to = nodes.find(n => n.id === l.to);
                if (!from || !to) return;
                this._drawLink(ctx, from, to, l);
            });

            // 画节点
            nodes.forEach(n => this._drawNode(ctx, n));

            ctx.restore();
        }

        _computeLayout() {
            const nodes = this.currentTree.nodes || [];
            if (!nodes.length) return;
            // 有 position 的节点直接用；否则按 parent 层级瀑布布局
            nodes.forEach(n => {
                if (!n.position) n.position = { x: 120, y: 200 };
            });
        }

        _nodeXY(n) {
            const pos = n.position || { x: 120, y: 200 };
            return { x: pos.x, y: pos.y };
        }

        _drawNode(ctx, node) {
            const { x, y } = this._nodeXY(node);
            const w = 130, h = 44;
            const color = NODE_COLORS[node.type] || NODE_COLORS.main;
            const isSel = node.id === this.selectedNodeId;

            // 阴影
            ctx.save();
            ctx.shadowColor = 'rgba(0,0,0,.12)';
            ctx.shadowBlur = 6;
            ctx.fillStyle = '#fff';
            this._roundRect(ctx, x - w / 2, y - h / 2, w, h, 8);
            ctx.fill();
            ctx.restore();

            // 边框
            ctx.strokeStyle = isSel ? '#111827' : color;
            ctx.lineWidth = isSel ? 2.5 : 1.5;
            this._roundRect(ctx, x - w / 2, y - h / 2, w, h, 8);
            ctx.stroke();

            // 类型色条
            ctx.fillStyle = color;
            this._roundRect(ctx, x - w / 2, y - h / 2, 6, h, 8);
            ctx.fill();

            // 标题
            ctx.fillStyle = '#111827';
            ctx.font = 'bold 13px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            const label = (node.label || '未命名').length > 10 ? (node.label.slice(0, 9) + '…') : (node.label || '未命名');
            ctx.fillText(label, x - w / 2 + 14, y - 8);

            // 类型标签
            ctx.fillStyle = '#6b7280';
            ctx.font = '10px sans-serif';
            ctx.fillText(node.type || 'main', x - w / 2 + 14, y + 12);
        }

        _roundRect(ctx, x, y, w, h, r) {
            ctx.beginPath();
            ctx.moveTo(x + r, y);
            ctx.arcTo(x + w, y, x + w, y + h, r);
            ctx.arcTo(x + w, y + h, x, y + h, r);
            ctx.arcTo(x, y + h, x, y, r);
            ctx.arcTo(x, y, x + w, y, r);
            ctx.closePath();
        }

        _drawLink(ctx, from, to, link) {
            const a = this._nodeXY(from);
            const b = this._nodeXY(to);
            const color = LINK_COLORS[link.type] || '#9ca3af';
            ctx.strokeStyle = color;
            ctx.lineWidth = link.type === '非线性' ? 1.5 : 1.2;
            ctx.setLineDash(link.type === '非线性' ? [4, 4] : []);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
            ctx.setLineDash([]);
            // 箭头
            const ang = Math.atan2(b.y - a.y, b.x - a.x);
            const size = 7;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(b.x, b.y);
            ctx.lineTo(b.x - size * Math.cos(ang - Math.PI / 6), b.y - size * Math.sin(ang - Math.PI / 6));
            ctx.lineTo(b.x - size * Math.cos(ang + Math.PI / 6), b.y - size * Math.sin(ang + Math.PI / 6));
            ctx.closePath();
            ctx.fill();
        }

        // ---------- 节点编辑 ----------
        _openNodeEditor(parentId) {
            if (!this.currentTreeId) { _toast('请先选择剧情树', 'warning'); return; }
            this._showNodeEditor({ parent_id: parentId, mode: 'add' });
        }

        _editSelected() {
            if (!this.selectedNodeId) { _toast('请先选中节点（点击画布节点）', 'warning'); return; }
            const node = (this.currentTree.nodes || []).find(n => n.id === this.selectedNodeId);
            if (!node) return;
            this._showNodeEditor({ mode: 'edit', node });
        }

        _showNodeEditor(state) {
            this._editor.innerHTML = _escapeHtml('');
            this._editor.style.display = 'block';

            const title = _el('h4', { text: state.mode === 'add' ? '新增节点' : '编辑节点' });
            this._editor.appendChild(title);

            const labelField = _el('div', { class: 'ptp-field' }, [
                _el('label', { text: '标题' }),
                _el('input', { value: state.mode === 'edit' ? (state.node.label || '') : '' }),
            ]);
            const labelInput = labelField.querySelector('input');

            const typeField = _el('div', { class: 'ptp-field' }, [
                _el('label', { text: '类型' }),
                _el('select', null, ['start', 'main', 'branch', 'turn', 'climax', 'end'].map(t =>
                    _el('option', { value: t, text: t, ...(state.mode === 'edit' && state.node.type === t ? { selected: 'selected' } : {}) })
                )),
            ]);
            const typeSelect = typeField.querySelector('select');

            const contentField = _el('div', { class: 'ptp-field' }, [
                _el('label', { text: '内容' }),
                _el('textarea', { text: state.mode === 'edit' ? (state.node.content || '') : '' }),
            ]);
            const contentText = contentField.querySelector('textarea');

            this._editor.appendChild(labelField);
            this._editor.appendChild(typeField);
            this._editor.appendChild(contentField);

            const btnRow = _el('div', { class: 'ptp-field-row' });
            const saveBtn = _el('button', { class: 'ptp-form-btn primary', text: '保存', onclick: () => this._saveNode(state, {
                label: labelInput.value, type: typeSelect.value, content: contentText.value,
            }) });
            const cancelBtn = _el('button', { class: 'ptp-form-btn', text: '取消', onclick: () => { this._editor.style.display = 'none'; } });
            btnRow.appendChild(saveBtn);
            btnRow.appendChild(cancelBtn);
            this._editor.appendChild(btnRow);
        }

        async _saveNode(state, data) {
            try {
                if (state.mode === 'add') {
                    const node = await _request(this._api('/trees/' + this.currentTreeId + '/nodes'), {
                        method: 'POST',
                        body: JSON.stringify({
                            label: data.label, type: data.type, content: data.content,
                            parent_id: state.parent_id || null, source: 'manual',
                        }),
                    });
                    this.selectedNodeId = node.id;
                    _toast('新增成功', 'success');
                } else {
                    await _request(this._api('/trees/' + this.currentTreeId + '/nodes/' + state.node.id), {
                        method: 'PATCH',
                        body: JSON.stringify({ label: data.label, type: data.type, content: data.content }),
                    });
                    _toast('编辑成功', 'success');
                }
                this._editor.style.display = 'none';
                await this._loadTree(this.currentTreeId);
                await this._refreshTreeList();
            } catch (e) {
                _toast('保存失败: ' + e.message, 'error');
            }
        }

        async _deleteSelected() {
            if (!this.selectedNodeId) { _toast('请先选中节点', 'warning'); return; }
            if (!confirm('确认删除该节点及其全部子节点？')) return;
            try {
                await _request(this._api('/trees/' + this.currentTreeId + '/nodes/' + this.selectedNodeId), { method: 'DELETE' });
                this.selectedNodeId = null;
                await this._loadTree(this.currentTreeId);
                await this._refreshTreeList();
                _toast('已删除', 'success');
            } catch (e) {
                _toast('删除失败: ' + e.message, 'error');
            }
        }

        async _refreshTreeList() {
            // 仅刷新左侧树列表（更新 nodes_count 计数），不改变当前选中树
            try {
                const res = await _request(this._api('/trees'));
                this.trees = (res && res.trees) || [];
                this._renderTreeList();
            } catch (e) { /* 列表刷新失败不阻塞主流程 */ }
        }

        // ---------- 关联编辑 ----------
        _openLinkEditor() {
            if (!this.currentTree || !this.currentTree.nodes || !this.currentTree.nodes.length) {
                _toast('剧情树为空', 'warning'); return;
            }
            const nodes = this.currentTree.nodes;
            const names = {};
            nodes.forEach(n => names[n.id] = n.label || n.id);
            const fromSel = _el('select', null, nodes.map(n => _el('option', { value: n.id, text: names[n.id] })));
            const toSel = _el('select', null, nodes.map(n => _el('option', { value: n.id, text: names[n.id] })));
            const typeSel = _el('select', null, ['前置', '后置', '非线性'].map(t => _el('option', { value: t, text: t })));
            const noteInput = _el('input', { placeholder: '备注（可选）' });

            this._editor.innerHTML = _escapeHtml('');
            this._editor.style.display = 'block';
            this._editor.appendChild(_el('h4', { text: '新增关联' }));
            const row1 = _el('div', { class: 'ptp-field-row' });
            row1.appendChild(fromSel);
            row1.appendChild(_el('span', { text: '→' }));
            row1.appendChild(toSel);
            this._editor.appendChild(row1);
            const row2 = _el('div', { class: 'ptp-field-row' });
            row2.appendChild(typeSel);
            row2.appendChild(noteInput);
            this._editor.appendChild(row2);
            const btnRow = _el('div', { class: 'ptp-field-row' });
            btnRow.appendChild(_el('button', { class: 'ptp-form-btn primary', text: '保存', onclick: () => this._saveLink(fromSel.value, toSel.value, typeSel.value, noteInput.value) }));
            btnRow.appendChild(_el('button', { class: 'ptp-form-btn', text: '取消', onclick: () => { this._editor.style.display = 'none'; } }));
            this._editor.appendChild(btnRow);
        }

        async _saveLink(fromId, toId, type, note) {
            try {
                await _request(this._api('/trees/' + this.currentTreeId + '/links'), {
                    method: 'POST',
                    body: JSON.stringify({ from_id: fromId, to_id: toId, type, note }),
                });
                this._editor.style.display = 'none';
                await this._loadTree(this.currentTreeId);
                _toast('关联已建立', 'success');
            } catch (e) {
                _toast('关联失败: ' + e.message, 'error');
            }
        }

        // ---------- 布局保存 ----------
        async _saveLayout() {
            if (!this.currentTreeId) return;
            const positions = (this.currentTree.nodes || []).map(n => ({ id: n.id, position: n.position }));
            try {
                const res = await _request(this._api('/trees/' + this.currentTreeId + '/layout'), {
                    method: 'POST', body: JSON.stringify({ positions }),
                });
                _toast('已保存 ' + res.updated + ' 个节点坐标', 'success');
            } catch (e) {
                _toast('保存布局失败: ' + e.message, 'error');
            }
        }

        // ---------- 双向联动 ----------
        async _syncRoom(action) {
            if (!this.currentTreeId) { _toast('请先选择剧情树', 'warning'); return; }
            const roomId = prompt('输入聊天室 ID:');
            if (!roomId) return;
            try {
                const res = await _request(this._api('/trees/' + this.currentTreeId + '/sync-room/' + roomId), {
                    method: 'POST', body: JSON.stringify({ action }),
                });
                if (action === 'push') {
                    _toast('已注入 ' + res.injected + ' 个上下文节点到聊天室', 'success');
                } else {
                    _toast('已回写 ' + res.added + ' 个推衍节点', 'success');
                    await this._loadTree(this.currentTreeId);
                }
            } catch (e) {
                _toast('联动失败: ' + e.message, 'error');
            }
        }

        // ---------- 导出 ----------
        async _exportTree() {
            if (!this.currentTreeId) { _toast('请先选择剧情树', 'warning'); return; }
            const scope = confirm('导出全部节点？确定=全部，取消=仅选中节点及子链') ? 'all' : 'node';
            try {
                let url = this._api('/trees/' + this.currentTreeId + '/export?scope=' + scope);
                if (scope === 'node') {
                    if (!this.selectedNodeId) { _toast('请先选中节点', 'warning'); return; }
                    url += '&node_id=' + this.selectedNodeId;
                }
                const data = await _request(url);
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = (this.currentTree.name || 'plot') + '.plot.json';
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 3000);
                _toast('已导出', 'success');
            } catch (e) {
                _toast('导出失败: ' + e.message, 'error');
            }
        }

        // ---------- 导入 ----------
        _openImport() {
            const mode = confirm('确定=合并到当前树，取消=覆盖当前树') ? 'merge' : 'replace';
            const fileInput = _el('input', { type: 'file', accept: 'application/json', style: 'display:none' });
            document.body.appendChild(fileInput);
            fileInput.addEventListener('change', async () => {
                const file = fileInput.files[0];
                if (!file) { fileInput.remove(); return; }
                try {
                    const text = await file.text();
                    const data = JSON.parse(text);
                    if (!this.currentTreeId) { _toast('请先选择目标剧情树', 'warning'); return; }
                    const res = await _request(this._api('/trees/import'), {
                        method: 'POST',
                        body: JSON.stringify({ data, mode, target_tree_id: this.currentTreeId }),
                    });
                    await this._loadTree(this.currentTreeId);
                    _toast('导入完成（' + res.mode + '，共 ' + res.nodes_count + ' 节点）', 'success');
                } catch (e) {
                    _toast('导入失败: ' + e.message, 'error');
                }
                fileInput.remove();
            });
            fileInput.click();
        }

        // ---------- 画布交互 ----------
        _bindCanvasEvents() {
            const canvas = this._canvas;
            canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
            canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
            canvas.addEventListener('mouseup', (e) => this._onMouseUp(e));
            canvas.addEventListener('mouseleave', () => { this._tooltip.style.opacity = '0'; });
            canvas.addEventListener('wheel', (e) => {
                e.preventDefault();
                const delta = e.deltaY < 0 ? 1.1 : 0.9;
                this._zoom(delta);
            }, { passive: false });
        }

        _screenToCanvas(e) {
            const rect = this._canvas.getBoundingClientRect();
            return {
                x: (e.clientX - rect.left - this.panX) / this.scale,
                y: (e.clientY - rect.top - this.panY) / this.scale,
            };
        }

        _hitTest(x, y) {
            const nodes = (this.currentTree && this.currentTree.nodes) || [];
            for (let i = nodes.length - 1; i >= 0; i--) {
                const n = nodes[i];
                const { x: nx, y: ny } = this._nodeXY(n);
                if (Math.abs(x - nx) <= 65 && Math.abs(y - ny) <= 22) return n;
            }
            return null;
        }

        _onMouseDown(e) {
            const pt = this._screenToCanvas(e);
            const hit = this._hitTest(pt.x, pt.y);
            if (hit) {
                this.selectedNodeId = hit.id;
                this.dragNodeId = hit.id;
                this.dragOffset = { dx: pt.x - hit.position.x, dy: pt.y - hit.position.y };
                this._render();
            } else {
                this.selectedNodeId = null;
                this._render();
            }
        }

        _onMouseMove(e) {
            const pt = this._screenToCanvas(e);
            if (this.dragNodeId) {
                const node = (this.currentTree.nodes || []).find(n => n.id === this.dragNodeId);
                if (node) {
                    node.position = {
                        x: Math.round(pt.x - this.dragOffset.dx),
                        y: Math.round(pt.y - this.dragOffset.dy),
                    };
                    this._render();
                }
            } else {
                const hit = this._hitTest(pt.x, pt.y);
                if (hit) {
                    const { x, y } = this._nodeXY(hit);
                    this._tooltip.style.left = (x * this.scale + this.panX + 10) + 'px';
                    this._tooltip.style.top = (y * this.scale + this.panY + 10) + 'px';
                    this._tooltip.textContent = (hit.label || '') + ' (' + hit.type + ')';
                    this._tooltip.style.opacity = '1';
                } else {
                    this._tooltip.style.opacity = '0';
                }
            }
        }

        _onMouseUp() {
            if (this.dragNodeId) {
                // 拖拽结束自动保存布局
                this._saveLayout();
                this.dragNodeId = null;
            }
        }

        _zoom(delta) {
            this.scale = Math.max(0.3, Math.min(2.5, this.scale * delta));
            this._render();
        }

        _resetView() {
            this.scale = 1;
            this.panX = 0;
            this.panY = 0;
            this._render();
        }

        _searchNodes() {
            const q = (this._searchInput.value || '').toLowerCase();
            if (!q || !this.currentTree) return;
            const nodes = this.currentTree.nodes || [];
            const found = nodes.find(n => (n.label || '').toLowerCase().includes(q));
            if (found) {
                this.selectedNodeId = found.id;
                this._render();
            }
        }
    }

    // ---------- 工厂（对齐 knowledge_panel.js） ----------
    const factory = {
        mount(opts) {
            const panel = new PlotTreePanel(opts);
            return panel;
        },
        createButton(opts) {
            const container = _el('div', { style: 'display:inline-block;margin:4px;' });
            (opts.mountEl || document.body).appendChild(container);
            const btn = _el('button', { class: 'ptp-btn', text: opts.text || '剧情树', onclick: () => {
                factory.mount(Object.assign({}, opts, { mountEl: container.parentElement === document.body ? document.body : container.parentElement }));
            } });
            container.appendChild(btn);
            return btn;
        },
    };

    global.StoryForgePlotPanel = factory;
})(typeof window !== 'undefined' ? window : globalThis);
