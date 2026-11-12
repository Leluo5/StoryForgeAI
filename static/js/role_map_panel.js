// 交付：独立可挂载面板组件，导出全局对象 StoryForgeRoleMap。
// 能力（F8-T7 力导向图前端）：
//   - d3-force 力导向图渲染：节点 <circle>+<text>，边 <line>+关系标签
//   - 拖拽（d3-drag）、缩放（d3-zoom）、平移（pan）
//   - 性能分级：<50 节点全量物理模拟；50-100 简化力（forceManyBody 衰减 + 碰撞仅同层）
//   - requestAnimationFrame 节流重绘；alphaDecay 提前收敛；DOM 节点复用
//   - 手动添加节点/边、删除节点/边
//   - 预留筛选（F8-T8）与点击跳转详情（F8-T9）钩子
// 用法：
//   StoryForgeRoleMap.mount({ projectId, mountEl, apiBase, onClose });
//   StoryForgeRoleMap.createButton({ mountEl, apiBase, projectId });
// 组件自带轻量请求/反馈，不依赖 app.js IIFE 内部符号（对齐 plot_tree_panel.js 同构模式）。

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
        // 兼容两种响应契约：
        //   1) {code, data, message} 包装（接口契约统一格式，F7 等模块使用）
        //   2) 裸对象（F8 后端 /api/role-map/* 直接 jsonify 数据）
        if (body && typeof body === 'object' && typeof body.code === 'number') {
            if (body.code !== 0) {
                throw new Error(body.message || ('业务错误 ' + body.code));
            }
            return body.data;
        }
        return body;
    }

    // ---------- 轻量 toast ----------
    function _ensureToast() {
        let box = document.getElementById('rmp-toast-box');
        if (!box) {
            box = document.createElement('div');
            box.id = 'rmp-toast-box';
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
    function _escapeHtml(str) {
        if (str === null || str === undefined) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function _el(tag, attrs, children) {
        const node = document.createElement(tag);
        if (attrs) {
            Object.keys(attrs).forEach(function (k) {
                const v = attrs[k];
                if (k === 'class') node.className = v;
                else if (k === 'text') node.textContent = v;
                else if (k === 'html') node.innerHTML = _escapeHtml(v);
                else if (k === 'style') node.style.cssText = v;
                else if (k === 'onclick') node.onclick = v;
                else if (k === 'onchange') node.onchange = v;
                else if (k === 'oninput') node.oninput = v;
                else if (v !== null && v !== undefined) node.setAttribute(k, v);
            });
        }
        (children || []).forEach(function (c) {
            if (c) node.appendChild(c);
        });
        return node;
    }

    // ---------- 样式注入 ----------
    let _styleInjected = false;
    function _ensureStyle() {
        if (_styleInjected) return;
        _styleInjected = true;
        const css = [
            '.rmp-panel{position:fixed;inset:0;z-index:99990;display:flex;flex-direction:column;background:#f8fafc;}',
            '.rmp-header{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:#fff;border-bottom:1px solid #e2e8f0;flex:0 0 auto;}',
            '.rmp-header h3{margin:0;font-size:16px;color:#0f172a;}',
            '.rmp-close{border:none;background:transparent;font-size:22px;color:#64748b;cursor:pointer;line-height:1;}',
            '.rmp-toolbar{display:flex;gap:8px;align-items:center;padding:8px 16px;background:#fff;border-bottom:1px solid #e2e8f0;flex-wrap:wrap;flex:0 0 auto;}',
            '.rmp-btn{padding:6px 12px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#334155;font-size:13px;cursor:pointer;}',
            '.rmp-btn:hover{background:#f1f5f9;}',
            '.rmp-btn.primary{background:#2563eb;color:#fff;border-color:#2563eb;}',
            '.rmp-btn.danger{background:#dc2626;color:#fff;border-color:#dc2626;}',
            '.rmp-canvas-wrap{flex:1 1 auto;position:relative;overflow:hidden;min-height:0;}',
            '.rmp-svg{width:100%;height:100%;display:block;cursor:grab;}',
            '.rmp-svg:active{cursor:grabbing;}',
            '.rmp-node{cursor:pointer;}',
            '.rmp-node circle{stroke:#fff;stroke-width:2px;}',
            '.rmp-node text{fill:#0f172a;font-size:12px;pointer-events:none;text-anchor:middle;}',
            '.rmp-node.dimmed{opacity:0.2;}',
            '.rmp-node.matched circle{stroke:#f59e0b;stroke-width:3px;}',
            '.rmp-link{stroke:#94a3b8;stroke-width:1.5px;}',
            '.rmp-link-label{fill:#64748b;font-size:10px;pointer-events:none;text-anchor:middle;}',
            '.rmp-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:14px;}',
            '.rmp-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:100000;display:flex;align-items:center;justify-content:center;}',
            '.rmp-modal{background:#fff;border-radius:10px;padding:20px;width:min(420px,92vw);max-height:88vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,.2);}',
            '.rmp-modal h4{margin:0 0 14px;color:#0f172a;font-size:15px;}',
            '.rmp-field{margin-bottom:12px;}',
            '.rmp-field label{display:block;font-size:12px;color:#64748b;margin-bottom:4px;}',
            '.rmp-field select,.rmp-field input{width:100%;padding:7px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;box-sizing:border-box;}',
            '.rmp-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;}',
            '.rmp-legend{font-size:12px;color:#64748b;}',
            '.rmp-nodata{color:#64748b;font-size:12px;padding:4px 0;}',
        ].join('\n');
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }

    // ---------- 节点颜色映射（按阵营 camp） ----------
    const CAMP_COLORS = {
        '主角': '#2563eb', '主角团': '#2563eb', '配角': '#16a34a', '配角团': '#16a34a',
        '反派': '#dc2626', '反派团': '#dc2626', '中立': '#d97706',
    };
    function _nodeColor(role) {
        const camp = (role && role.camp) || '';
        return CAMP_COLORS[camp] || '#6b7280';
    }

    // 关系类型标签映射（边 label）
    const RELATION_LABELS = {
        'ally': '盟友', 'enemy': '敌人', 'family': '亲属', 'lover': '恋人',
        'mentor': '师徒', 'rival': '对手', 'partner': '搭档', 'unknown': '关系',
    };
    function _relLabel(t) {
        return RELATION_LABELS[t] || (t || '关系');
    }

    // ---------- 角色版图面板 ----------
    class RoleMapPanel {
        constructor(opts) {
            this.mountEl = opts.mountEl || document.body;
            this.apiBase = opts.apiBase || '';
            this.projectId = opts.projectId || null;
            this.onClose = opts.onClose || null;
            this.onNodeClick = opts.onNodeClick || null; // F8-T9 详情页跳转钩子
            this._nodes = [];   // 节点数据 [{id,name,camp,...}]
            this._edges = [];   // 边数据 [{source,target,relation_type,note}]
            this._sim = null;
            this._svg = null;
            this._g = null;
            this._nodeSel = null;
            this._linkSel = null;
            this._linkLabelSel = null;
            this._raf = null;
            this._destroyed = false;
            this._build();
        }

        _api(path) {
            return this.apiBase + '/api/role-map' + path;
        }

        // ---------- 构建界面 ----------
        _build() {
            _ensureStyle();
            this._root = _el('div', { class: 'rmp-panel' });

            const header = _el('div', { class: 'rmp-header' }, [
                _el('h3', { text: '角色版图' }),
                _el('button', { class: 'rmp-close', text: '×', onclick: () => this._close() }),
            ]);
            this._root.appendChild(header);

            // 工具栏：添加节点/边 + 重排 + 图例
            const toolbar = _el('div', { class: 'rmp-toolbar' });
            this._toolbar = toolbar;
            toolbar.appendChild(_el('button', { class: 'rmp-btn primary', text: '添加角色', onclick: () => this._openNodeEditor(null) }));
            toolbar.appendChild(_el('button', { class: 'rmp-btn', text: '添加关系', onclick: () => this._openEdgeEditor() }));
            toolbar.appendChild(_el('button', { class: 'rmp-btn', text: '重排', onclick: () => this._restartSim() }));
            this._legend = _el('span', { class: 'rmp-legend' });
            toolbar.appendChild(this._legend);
            this._root.appendChild(toolbar);

            // 画布
            const wrap = _el('div', { class: 'rmp-canvas-wrap' });
            this._wrap = wrap;
            // 注意：SVG 根必须用 createElementNS 创建（document.createElement('svg')
            // 会产生 XHTML 命名空间，导致子元素几何量为 0、整棵子树不可见）。
            this._svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            this._svg.setAttribute('class', 'rmp-svg');
            // 视口分组（zoom/pan 作用于此）
            this._g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            this._svg.appendChild(this._g);
            wrap.appendChild(this._svg);
            this._root.appendChild(wrap);

            (this.mountEl).appendChild(this._root);

            this._initZoomPan();
            this.loadGraph();
        }

        // ---------- 数据加载 ----------
        async loadGraph() {
            if (!this.projectId) { _toast('缺少 projectId', 'error'); return; }
            this._showEmpty('加载中...');
            try {
                const data = await _request(this._api('/graph') + '?project_id=' + encodeURIComponent(this.projectId));
                this._nodes = (data && data.nodes) || [];
                this._edges = (data && data.edges) || [];
                this._renderGraph();
                this._updateLegend();
            } catch (e) {
                _toast('加载图谱失败: ' + e.message, 'error');
                this._showEmpty('加载失败，请重试');
            }
        }

        _showEmpty(text) {
            let empty = this._wrap.querySelector('.rmp-empty');
            if (!empty) {
                empty = _el('div', { class: 'rmp-empty', text: text });
                this._wrap.appendChild(empty);
            } else {
                empty.textContent = text;
            }
            empty.style.display = 'flex';
        }
        _hideEmpty() {
            const empty = this._wrap.querySelector('.rmp-empty');
            if (empty) empty.style.display = 'none';
        }

        _updateLegend() {
            const n = this._nodes.length;
            this._legend.textContent = '节点 ' + n + ' / 边 ' + this._edges.length;
        }

        // ---------- d3-force 渲染 ----------
        _renderGraph() {
            if (this._destroyed) return;
            const d3 = global.d3;
            if (!d3) { this._showEmpty('缺少 d3 库'); return; }
            this._hideEmpty();
            if (!this._nodes.length) { this._showEmpty('暂无角色，点击「添加角色」创建'); }

            const wrapW = this._wrap.clientWidth || 800;
            const wrapH = this._wrap.clientHeight || 600;

            const svg = d3.select(this._svg);
            const g = d3.select(this._g);

            // 节点/边数据：节点用 id 索引，边两端引用节点对象
            const nodeById = {};
            this._nodes.forEach(function (n) { nodeById[n.id] = n; });
            const links = this._edges
                .filter(function (e) { return nodeById[e.source] && nodeById[e.target]; })
                .map(function (e) {
                    return { source: e.source, target: e.target, relation_type: e.relation_type, note: e.note };
                });
            const nodes = this._nodes.map(function (n) {
                return Object.assign({}, n, { x: (n.x != null ? n.x : 0), y: (n.y != null ? n.y : 0), vx: 0, vy: 0 });
            });

            // 力导向：性能分级
            const count = nodes.length;
            const sim = d3.forceSimulation(nodes)
                .force('link', d3.forceLink(links).id(function (d) { return d.id; }).distance(110).strength(0.5))
                .force('charge', d3.forceManyBody().strength(count > 50 ? -80 : -160).distanceMax(count > 50 ? 200 : Infinity))
                .force('center', d3.forceCenter(wrapW / 2, wrapH / 2))
                .force('collision', d3.forceCollide(count > 50 ? 22 : 34))
                .alphaDecay(0.02)
                .velocityDecay(0.4);
            this._sim = sim;

            // DOM 节点复用（增量）：绑定 key 以复用既有节点
            const node = g.selectAll('g.rmp-node').data(nodes, function (d) { return d.id; });
            const nodeEnter = node.enter().append('g').attr('class', 'rmp-node');
            nodeEnter.append('circle').attr('r', 18).attr('fill', function (d) { return _nodeColor(d); });
            nodeEnter.append('text').attr('dy', 4).text(function (d) { return d.name || d.id; });
            nodeEnter.append('title').text(function (d) { return d.name || d.id; });

            const nodeMerge = nodeEnter.merge(node);
            nodeMerge.select('circle').attr('fill', function (d) { return _nodeColor(d); });
            nodeMerge.select('text').text(function (d) { return d.name || d.id; });

            // 边
            const link = g.selectAll('line.rmp-link').data(links, function (d) {
                return (typeof d.source === 'object' ? d.source.id : d.source) + '-' + (typeof d.target === 'object' ? d.target.id : d.target);
            });
            const linkEnter = link.enter().insert('line', 'g').attr('class', 'rmp-link');
            const linkMerge = linkEnter.merge(link);

            const linkLabel = g.selectAll('text.rmp-link-label').data(links, function (d) {
                return (typeof d.source === 'object' ? d.source.id : d.source) + '-' + (typeof d.target === 'object' ? d.target.id : d.target);
            });
            const labelEnter = linkLabel.enter().insert('text', 'g').attr('class', 'rmp-link-label');
            const labelMerge = labelEnter.merge(linkLabel);
            labelMerge.text(function (d) { return _relLabel(d.relation_type); });

            // 移除退出节点/边（label 数据 key 与 link 一致，独立退出）
            node.exit().remove();
            link.exit().remove();
            linkLabel.exit().remove();

            // 拖拽
            nodeMerge.call(this._dragBehavior(d3, sim));

            // 点击节点 → 详情跳转钩子（F8-T9）
            nodeMerge.on('click', function (event, d) {
                if (d._dragged) return; // 拖拽后不触发点击
                if (this.onNodeClick) this.onNodeClick(d);
            }.bind(this));

            // 模拟 tick → 节流重绘
            this._nodeSel = nodeMerge;
            this._linkSel = linkMerge;
            this._linkLabelSel = labelMerge;
            sim.on('tick', this._tickHandler());
        }

        _tickHandler() {
            const self = this;
            return function () {
                if (self._raf) return;
                self._raf = requestAnimationFrame(function () {
                    self._raf = null;
                    if (self._destroyed || !self._sim) return;
                    self._linkSel
                        .attr('x1', function (d) { return d.source.x; })
                        .attr('y1', function (d) { return d.source.y; })
                        .attr('x2', function (d) { return d.target.x; })
                        .attr('y2', function (d) { return d.target.y; });
                    self._linkLabelSel
                        .attr('x', function (d) { return (d.source.x + d.target.x) / 2; })
                        .attr('y', function (d) { return (d.source.y + d.target.y) / 2; });
                    self._nodeSel.attr('transform', function (d) { return 'translate(' + d.x + ',' + d.y + ')'; });
                });
            };
        }

        _dragBehavior(d3, sim) {
            const self = this;
            return d3.drag()
                .on('start', function (event, d) {
                    if (!event.active) sim.alphaTarget(0.3).restart();
                    d.fx = d.x; d.fy = d.y;
                    d._dragged = false;
                })
                .on('drag', function (event, d) {
                    d.fx = event.x; d.fy = event.y;
                    d._dragged = true;
                })
                .on('end', function (event, d) {
                    if (!event.active) sim.alphaTarget(0);
                    d.fx = null; d.fy = null;
                    // 允许 click 在下一次事件循环判定（拖拽结束不立即触发 click）
                    const wasDragged = d._dragged;
                    setTimeout(function () { d._dragged = false; }, 0);
                    if (wasDragged) { if (event.sourceEvent) event.sourceEvent.stopPropagation(); }
                });
        }

        _initZoomPan() {
            const self = this;
            const d3 = global.d3;
            if (!d3) return;
            const svg = d3.select(this._svg);
            const g = d3.select(this._g);
            svg.call(d3.zoom()
                .scaleExtent([0.2, 4])
                .on('zoom', function (event) {
                    g.attr('transform', event.transform);
                }));
        }

        _restartSim() {
            if (this._sim) {
                this._sim.alpha(1).restart();
            }
        }

        // ---------- 节点/边编辑 ----------
        _openNodeEditor(existing) {
            const self = this;
            const roles = this._nodes.slice();
            // 已入图谱的不可重复添加
            const inGraph = {};
            roles.forEach(function (r) { inGraph[r.id] = true; });

            const modal = _el('div', { class: 'rmp-modal-bg' });
            const box = _el('div', { class: 'rmp-modal' });
            box.appendChild(_el('h4', { text: existing ? '编辑角色' : '添加角色节点' }));

            // 选择角色（从图谱当前节点 + 提示先建角色）
            const field = _el('div', { class: 'rmp-field' });
            field.appendChild(_el('label', { text: '选择角色（角色需先创建，若为空请先建角色）' }));
            const select = _el('select');
            select.appendChild(_el('option', { value: '', text: '— 选择角色 —' }));
            roles.forEach(function (r) {
                select.appendChild(_el('option', { value: r.id, text: (r.name || r.id) + (inGraph[r.id] ? '（已在图谱）' : '') }));
            });
            field.appendChild(select);
            box.appendChild(field);

            const actions = _el('div', { class: 'rmp-modal-actions' });
            const cancel = _el('button', { class: 'rmp-btn', text: '取消', onclick: function () { modal.remove(); } });
            const ok = _el('button', { class: 'rmp-btn primary', text: '添加', onclick: async function () {
                const roleId = select.value;
                if (!roleId) { _toast('请选择角色', 'warning'); return; }
                try {
                    await _request(self._api('/nodes'), {
                        method: 'POST',
                        body: JSON.stringify({ project_id: self.projectId, role_id: roleId }),
                    });
                    modal.remove();
                    await self.loadGraph();
                    _toast('已添加到图谱', 'success');
                } catch (e) {
                    _toast('添加失败: ' + e.message, 'error');
                }
            } });
            actions.appendChild(cancel);
            actions.appendChild(ok);
            box.appendChild(actions);
            modal.appendChild(box);
            document.body.appendChild(modal);
        }

        _openEdgeEditor() {
            const self = this;
            if (this._nodes.length < 2) { _toast('至少需要 2 个节点才能建立关系', 'warning'); return; }

            const modal = _el('div', { class: 'rmp-modal-bg' });
            const box = _el('div', { class: 'rmp-modal' });
            box.appendChild(_el('h4', { text: '添加角色关系' }));

            const mkSelect = function (label) {
                const field = _el('div', { class: 'rmp-field' });
                field.appendChild(_el('label', { text: label }));
                const sel = _el('select');
                self._nodes.forEach(function (r) {
                    sel.appendChild(_el('option', { value: r.id, text: r.name || r.id }));
                });
                field.appendChild(sel);
                box.appendChild(field);
                return sel;
            };

            const srcSel = mkSelect('源角色');
            const tgtSel = mkSelect('目标角色');
            const relField = _el('div', { class: 'rmp-field' });
            relField.appendChild(_el('label', { text: '关系类型' }));
            const relSel = _el('select');
            ['ally', 'enemy', 'family', 'lover', 'mentor', 'rival', 'partner', 'unknown'].forEach(function (t) {
                relSel.appendChild(_el('option', { value: t, text: _relLabel(t) }));
            });
            relField.appendChild(relSel);
            box.appendChild(relField);

            const noteField = _el('div', { class: 'rmp-field' });
            noteField.appendChild(_el('label', { text: '备注（可选）' }));
            const noteInput = _el('input', { placeholder: '关系备注' });
            noteField.appendChild(noteInput);
            box.appendChild(noteField);

            const actions = _el('div', { class: 'rmp-modal-actions' });
            const cancel = _el('button', { class: 'rmp-btn', text: '取消', onclick: function () { modal.remove(); } });
            const ok = _el('button', { class: 'rmp-btn primary', text: '添加', onclick: async function () {
                const source = srcSel.value;
                const target = tgtSel.value;
                if (!source || !target) { _toast('请选择源/目标角色', 'warning'); return; }
                if (source === target) { _toast('不能关联自己', 'warning'); return; }
                try {
                    await _request(self._api('/edges'), {
                        method: 'POST',
                        body: JSON.stringify({
                            project_id: self.projectId, source: source, target: target,
                            relation_type: relSel.value, note: noteInput.value,
                        }),
                    });
                    modal.remove();
                    await self.loadGraph();
                    _toast('关系已建立', 'success');
                } catch (e) {
                    _toast('添加关系失败: ' + e.message, 'error');
                }
            } });
            actions.appendChild(cancel);
            actions.appendChild(ok);
            box.appendChild(actions);
            modal.appendChild(box);
            document.body.appendChild(modal);
        }

        // ---------- 关闭 ----------
        _close() {
            this._destroyed = true;
            if (this._sim) this._sim.stop();
            if (this._raf) cancelAnimationFrame(this._raf);
            this._root.remove();
            if (this.onClose) this.onClose();
        }
    }

    // ---------- 工厂导出 ----------
    const factory = {
        mount(opts) {
            return new RoleMapPanel(opts);
        },
        createButton(opts) {
            const container = _el('div', { style: 'display:inline-block;margin:4px;' });
            (opts.mountEl || document.body).appendChild(container);
            const btn = _el('button', { class: 'rmp-btn', text: opts.text || '角色版图', onclick: function () {
                factory.mount(Object.assign({}, opts, {
                    mountEl: container.parentElement === document.body ? document.body : container.parentElement,
                }));
            } });
            container.appendChild(btn);
            return btn;
        },
    };

    global.StoryForgeRoleMap = factory;
})(typeof window !== 'undefined' ? window : globalThis);
