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
            box.style.cssText = 'position:fixed;top:var(--sp-4,16px);right:var(--sp-4,16px);z-index:99999;display:flex;flex-direction:column;gap:var(--sp-2,8px);';
            document.body.appendChild(box);
        }
        return box;
    }
    function _toast(msg, type) {
        const box = _ensureToast();
        const el = document.createElement('div');
        const colors = { success: 'var(--success,#16a34a)', warning: 'var(--warning,#d97706)', error: 'var(--danger,#dc2626)', info: 'var(--accent,#2563eb)' };
        el.style.cssText = 'padding:var(--sp-3,10px) var(--sp-4,16px);border-radius:var(--radius-md,8px);color:var(--text-inverse,#fff);font-size:var(--fs-body,14px);' +
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
            '.rmp-panel{position:fixed;inset:0;z-index:99990;display:flex;flex-direction:column;background:var(--bg-primary,#f8fafc);color:var(--text-primary,#0f172a);}',
            '.rmp-header{display:flex;align-items:center;justify-content:space-between;padding:var(--sp-3,10px) var(--sp-4,16px);background:var(--bg-card,#fff);border-bottom:1px solid var(--border-color,#e2e8f0);flex:0 0 auto;}',
            '.rmp-header h3{margin:0;font-size:var(--fs-h3,16px);color:var(--text-primary,#0f172a);}',
            '.rmp-close{border:none;background:transparent;font-size:var(--fs-h2,22px);color:var(--text-tertiary,#64748b);cursor:pointer;line-height:1;padding:var(--sp-1,4px);border-radius:var(--radius-sm,4px);}',
            '.rmp-close:hover{background:var(--bg-hover,#f1f5f9);color:var(--text-primary,#0f172a);}',
            '.rmp-toolbar{display:flex;gap:var(--sp-2,8px);align-items:center;padding:var(--sp-2,8px) var(--sp-4,16px);background:var(--bg-card,#fff);border-bottom:1px solid var(--border-color,#e2e8f0);flex-wrap:wrap;flex:0 0 auto;}',
            '.rmp-btn{padding:var(--sp-2,6px) var(--sp-3,12px);border:1px solid var(--border-color,#cbd5e1);border-radius:var(--radius-sm,6px);background:var(--bg-card,#fff);color:var(--text-primary,#334155);font-size:var(--fs-small,13px);cursor:pointer;transition:var(--transition,.2s);}',
            '.rmp-btn:hover{background:var(--bg-hover,#f1f5f9);border-color:var(--accent,#818cf8);}',
            '.rmp-btn:active{transform:scale(.97);}',
            '.rmp-btn.primary{background:var(--accent,#2563eb);color:var(--text-inverse,#fff);border-color:var(--accent,#2563eb);}',
            '.rmp-btn.primary:hover{background:var(--accent-hover,#1d4ed8);border-color:var(--accent-hover,#1d4ed8);}',
            '.rmp-btn.danger{background:var(--danger,#dc2626);color:var(--text-inverse,#fff);border-color:var(--danger,#dc2626);}',
            '.rmp-btn.danger:hover{background:var(--danger-hover,#b91c1c);border-color:var(--danger-hover,#b91c1c);}',
            '.rmp-canvas-wrap{flex:1 1 auto;position:relative;overflow:hidden;min-height:0;}',
            '.rmp-svg{width:100%;height:100%;display:block;cursor:grab;}',
            '.rmp-svg:active{cursor:grabbing;}',
            '.rmp-node{cursor:pointer;}',
            '.rmp-node circle{stroke:var(--bg-card,#fff);stroke-width:2px;}',
            '.rmp-node text{fill:var(--text-primary,#0f172a);font-size:var(--fs-small,12px);pointer-events:none;text-anchor:middle;}',
            '.rmp-node.dimmed{opacity:0.2;}',
            '.rmp-node.matched circle{stroke:var(--warning,#f59e0b);stroke-width:3px;}',
            '.rmp-link{stroke:var(--text-tertiary,#94a3b8);stroke-width:1.5px;}',
            '.rmp-link.dimmed{opacity:0.15;}',
            '.rmp-link.matched{stroke:var(--warning,#f59e0b);stroke-width:2px;}',
            '.rmp-link-label{fill:var(--text-tertiary,#64748b);font-size:var(--fs-caption,10px);pointer-events:none;text-anchor:middle;}',
            '.rmp-link-label.dimmed{opacity:0.15;}',
            '.rmp-link-label.matched{fill:var(--warning,#b45309);font-weight:600;}',
            // F8-T8 筛选维度栏
            '.rmp-filterbar{display:flex;gap:var(--sp-2,8px);align-items:center;padding:var(--sp-2,6px) var(--sp-4,16px);background:var(--bg-primary,#f8fafc);border-bottom:1px solid var(--border-color,#e2e8f0);flex-wrap:wrap;flex:0 0 auto;}',
            '.rmp-filter-title{font-size:var(--fs-small,12px);color:var(--text-secondary,#475569);font-weight:var(--fw-semibold,600);white-space:nowrap;}',
            '.rmp-filter-item{display:inline-flex;align-items:center;gap:var(--sp-1,4px);font-size:var(--fs-small,12px);color:var(--text-secondary,#475569);}',
            '.rmp-filter-label{white-space:nowrap;}',
            '.rmp-filter-select{padding:var(--sp-1,4px) var(--sp-2,6px);border:1px solid var(--border-color,#cbd5e1);border-radius:var(--radius-sm,5px);font-size:var(--fs-small,12px);background:var(--bg-input,#fff);color:var(--text-primary,#334155);max-width:120px;}',
            '.rmp-filter-count{font-size:var(--fs-small,12px);color:var(--warning,#b45309);font-weight:var(--fw-semibold,600);white-space:nowrap;}',
            '.rmp-btn-sm{padding:var(--sp-1,3px) var(--sp-3,10px);font-size:var(--fs-small,12px);}',
            '.rmp-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text-tertiary,#94a3b8);font-size:var(--fs-body,14px);}',
            '.rmp-modal-bg{position:fixed;inset:0;background:var(--bg-modal-overlay,rgba(0,0,0,.4));z-index:100000;display:flex;align-items:center;justify-content:center;}',
            '.rmp-modal{background:var(--bg-card,#fff);border-radius:var(--radius-md,10px);padding:var(--sp-5,20px);width:min(420px,92vw);max-height:88vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,.2);}',
            '.rmp-modal h4{margin:0 0 var(--sp-4,14px);color:var(--text-primary,#0f172a);font-size:var(--fs-body-lg,15px);}',
            '.rmp-field{margin-bottom:var(--sp-3,12px);}',
            '.rmp-field label{display:block;font-size:var(--fs-small,12px);color:var(--text-tertiary,#64748b);margin-bottom:var(--sp-1,4px);}',
            '.rmp-field select,.rmp-field input{width:100%;padding:var(--sp-2,7px) var(--sp-3,10px);border:1px solid var(--border-color,#cbd5e1);border-radius:var(--radius-sm,6px);font-size:var(--fs-small,13px);box-sizing:border-box;background:var(--bg-input,#fff);color:var(--text-primary,#334155);}',
            '.rmp-field select:focus,.rmp-field input:focus{border-color:var(--accent,#2563eb);box-shadow:0 0 0 3px var(--accent-light,#dbeafe);outline:none;}',
            '.rmp-modal-actions{display:flex;justify-content:flex-end;gap:var(--sp-2,8px);margin-top:var(--sp-4,16px);}',
            '.rmp-legend{font-size:var(--fs-small,12px);color:var(--text-tertiary,#64748b);}',
            '.rmp-nodata{color:var(--text-tertiary,#64748b);font-size:var(--fs-small,12px);padding:var(--sp-1,4px) 0;}',
            // F8-T9 角色详情侧滑面板
            '.rmp-detail{position:absolute;top:0;right:0;bottom:0;width:min(360px,92vw);background:var(--bg-card,#fff);border-left:1px solid var(--border-color,#e2e8f0);box-shadow:-4px 0 16px rgba(0,0,0,.08);z-index:100001;display:flex;flex-direction:column;overflow:hidden;}',
            '.rmp-detail-head{display:flex;align-items:center;gap:var(--sp-2,8px);padding:var(--sp-3,12px) var(--sp-4,14px);border-bottom:1px solid var(--border-color,#e2e8f0);flex:0 0 auto;}',
            '.rmp-detail-dot{width:12px;height:12px;border-radius:50%;flex:0 0 auto;}',
            '.rmp-detail-head h4{margin:0;font-size:var(--fs-body-lg,15px);color:var(--text-primary,#0f172a);flex:1 1 auto;}',
            '.rmp-detail-close{border:none;background:transparent;font-size:var(--fs-h2,20px);color:var(--text-tertiary,#64748b);cursor:pointer;line-height:1;padding:var(--sp-1,4px);border-radius:var(--radius-sm,4px);}',
            '.rmp-detail-close:hover{background:var(--bg-hover,#f1f5f9);color:var(--text-primary,#0f172a);}',
            // F9-T6 详情侧滑头部头像：圆形裁剪，缺失时隐藏（回退色点）
            '.rmp-detail-avatar{width:44px;height:44px;border-radius:50%;object-fit:cover;border:2px solid var(--border-color,#e2e8f0);flex:0 0 auto;background:var(--bg-hover,#f1f5f9);display:none;}',
            '.rmp-detail-avatar.show{display:block;}',
            // F9-T6 版图节点头像：圆形裁剪叠加于色点之上，缺失时色点可见
            '.rmp-node image.rmp-node-avatar{pointer-events:none;}',
            '.rmp-detail-body{padding:var(--sp-3,10px) var(--sp-4,14px);border-bottom:1px solid var(--border-light,#f1f5f9);flex:0 0 auto;}',
            '.rmp-detail-row{font-size:var(--fs-small,13px);color:var(--text-secondary,#334155);padding:var(--sp-1,3px) 0;display:flex;gap:var(--sp-1,4px);}',
            '.rmp-detail-k{color:var(--text-tertiary,#64748b);flex:0 0 auto;min-width:70px;}',
            '.rmp-detail-v{color:var(--text-primary,#0f172a);}',
            '.rmp-detail-sec-title{font-size:var(--fs-small,12px);color:var(--text-secondary,#475569);font-weight:var(--fw-semibold,600);padding:var(--sp-3,10px) var(--sp-4,14px) var(--sp-1,4px);}',
            '.rmp-detail-rels{padding:0 var(--sp-4,14px) var(--sp-2,8px);flex:0 0 auto;max-height:180px;overflow:auto;}',
            '.rmp-detail-rel{display:flex;align-items:center;gap:var(--sp-2,8px);padding:var(--sp-1,4px) 0;font-size:var(--fs-small,13px);border-bottom:1px dashed var(--border-light,#f1f5f9);}',
            '.rmp-detail-rel-type{flex:0 0 auto;background:var(--bg-hover,#f1f5f9);color:var(--text-secondary,#475569);border-radius:var(--radius-sm,4px);padding:1px 6px;font-size:var(--fs-caption,11px);}',
            '.rmp-detail-rel-name{color:var(--text-primary,#0f172a);}',
            '.rmp-detail-rel-note{color:var(--text-tertiary,#94a3b8);font-size:var(--fs-caption,11px);}',
            '.rmp-detail-growth{flex:1 1 auto;overflow:auto;padding:0 var(--sp-4,14px) var(--sp-4,14px);}',
            '.rmp-detail-growth-item{padding:var(--sp-2,6px) 0;border-bottom:1px solid var(--border-light,#f1f5f9);}',
            '.rmp-detail-growth-title{font-size:var(--fs-small,13px);color:var(--text-primary,#0f172a);}',
            '.rmp-detail-growth-sub{font-size:var(--fs-caption,11px);color:var(--text-tertiary,#94a3b8);margin-top:2px;}',
            // F8-T10 成长线纵向时间轴
            '.rmp-growth-nav{display:flex;align-items:center;gap:var(--sp-2,8px);padding:var(--sp-2,8px) 0;border-bottom:1px solid var(--border-light,#f1f5f9);margin-bottom:var(--sp-2,8px);}',
            '.rmp-growth-progress{font-size:var(--fs-small,12px);color:var(--text-secondary,#475569);font-weight:var(--fw-semibold,600);flex:1 1 auto;text-align:center;}',
            '.rmp-growth-nav .rmp-btn-sm{flex:0 0 auto;}',
            '.rmp-growth-nav .rmp-btn-sm:disabled{opacity:0.45;cursor:not-allowed;}',
            '.rmp-growth-axis{position:relative;padding-left:18px;min-height:0;}',
            '.rmp-growth-line{position:absolute;left:6px;top:4px;bottom:4px;width:2px;background:var(--border-color,#e2e8f0);border-radius:1px;}',
            '.rmp-growth-list{padding-left:18px;}',
            '.rmp-growth-item{position:relative;display:flex;align-items:flex-start;gap:var(--sp-3,10px);padding:var(--sp-2,8px) 0;cursor:pointer;}',
            '.rmp-growth-tick{position:absolute;left:-18px;top:12px;width:12px;height:12px;border-radius:50%;background:var(--border-color,#e2e8f0);border:2px solid var(--bg-card,#fff);box-shadow:0 0 0 1px var(--border-color,#cbd5e1);flex:0 0 auto;}',
            '.rmp-growth-content{flex:1 1 auto;min-width:0;}',
            '.rmp-growth-title{font-size:var(--fs-small,13px);color:var(--text-primary,#0f172a);font-weight:var(--fw-medium,500);}',
            '.rmp-growth-sub{font-size:var(--fs-caption,11px);color:var(--text-tertiary,#94a3b8);margin-top:2px;}',
            '.rmp-growth-jump{margin-top:6px;}',
            // 状态类：done 已读（历史回溯可点击）/ active 当前段 / future 未来段
            '.rmp-growth-item.done .rmp-growth-tick{background:var(--success,#16a34a);border-color:var(--success-100,#bbf7d0);box-shadow:0 0 0 1px var(--success,#16a34a);}',
            '.rmp-growth-item.done .rmp-growth-title{color:var(--text-secondary,#334155);}',
            '.rmp-growth-item.active .rmp-growth-tick{background:var(--accent,#2563eb);border-color:var(--accent-light,#bfdbfe);box-shadow:0 0 0 1px var(--accent,#2563eb);}',
            '.rmp-growth-item.active .rmp-growth-title{color:var(--accent,#2563eb);font-weight:var(--fw-semibold,600);}',
            '.rmp-growth-item.future .rmp-growth-tick{background:var(--border-color,#e2e8f0);border-color:var(--bg-card,#fff);box-shadow:0 0 0 1px var(--border-color,#cbd5e1);}',
            '.rmp-growth-item.future .rmp-growth-title{color:var(--text-tertiary,#94a3b8);}',
            // F8-T11 响应式断点
            // 平板（768-1279px）：筛选栏折叠为横向滚动，避免换行撑高
            '@media (max-width:1279px){',
            '.rmp-filterbar{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:thin;-webkit-overflow-scrolling:touch;}',
            '.rmp-filter-item{flex:0 0 auto;}',
            '.rmp-filter-title{flex:0 0 auto;}',
            '}',
            // 移动（<768px）：工具栏/头部紧凑，详情面板全屏（滑出盖满画布）
            '@media (max-width:767px){',
            '.rmp-header{padding:var(--sp-2,8px) var(--sp-3,12px);}',
            '.rmp-header h3{font-size:var(--fs-body-lg,15px);}',
            '.rmp-toolbar{padding:var(--sp-2,6px) var(--sp-3,10px);gap:6px;}',
            '.rmp-filterbar{padding:var(--sp-2,6px) var(--sp-3,10px);}',
            '.rmp-filter-select{max-width:96px;}',
            '.rmp-detail{width:100vw;max-width:100vw;border-left:none;}',
            '.rmp-detail-head{padding:var(--sp-3,10px) var(--sp-3,12px);}',
            '.rmp-detail-body{padding:var(--sp-2,8px) var(--sp-3,12px);}',
            '.rmp-detail-sec-title{padding:var(--sp-2,8px) var(--sp-3,12px) 3px;}',
            '.rmp-detail-rels{padding:0 var(--sp-3,12px) var(--sp-2,6px);}',
            '.rmp-detail-growth{padding:0 var(--sp-3,12px) var(--sp-3,12px);}',
            '.rmp-btn{padding:5px 10px;font-size:var(--fs-small,12px);}',
            '}',
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
            // F9-T7：头像同步事件监听（版本图节点 + 详情侧滑 + 导入预览）
            this._onAvatarUpdated = this._onAvatarUpdated.bind(this);
            global.addEventListener('storyforge:role-avatar-updated', this._onAvatarUpdated);
            this._build();
        }

        // ---------- F9-T7 头像同步 ----------
        // 全局事件 storyforge:role-avatar-updated（detail={roleId, avatarPath}）：
        //   1. 更新版图节点 <image.rmp-node-avatar> href
        //   2. 若详情侧滑正展示该角色 → 更新 <img.rmp-detail-avatar> src
        // 导入预览卡片由其宿主（novel_editor.js）自行监听（候选角色独立数据源）。
        _onAvatarUpdated(ev) {
            const detail = (ev && ev.detail) || {};
            const roleId = detail.roleId;
            const avatarPath = detail.avatarPath || '';
            if (!roleId) return;
            // 1) 版图节点
            const node = this._nodes.find(function (n) { return n.id === roleId; });
            if (node) {
                node.avatar = avatarPath;
                if (this._g) {
                    const d3 = global.d3;
                    if (d3) {
                        d3.select(this._g).selectAll('g.rmp-node')
                            .filter(function (d) { return d.id === roleId; })
                            .select('image.rmp-node-avatar')
                            .attr('href', avatarPath);
                    }
                }
            }
            // 2) 详情侧滑（正展示该角色 → 实时更新）
            if (this._detailData && this._detailData.id === roleId && this._detailEl) {
                this._detailData.avatar = avatarPath;
                const img = this._detailEl.querySelector('img.rmp-detail-avatar');
                if (img) {
                    img.src = avatarPath;
                    img.classList.toggle('show', !!avatarPath);
                }
            }
        }

        // ---------- F9-T7 生成头像 ----------
        // 调 POST /api/role-map/avatar/generate → 成功后派发全局同步事件，
        // 使所有展示位（版图节点/详情侧滑/导入预览）实时更新，无需刷新。
        async _generateAvatar(roleId, roleName) {
            const self = this;
            if (!roleId) { _toast('缺少角色', 'error'); return; }
            try {
                _toast('正在生成头像...', 'info');
                const data = await _request(this._api('/avatar/generate'), {
                    method: 'POST',
                    body: JSON.stringify({ project_id: this.projectId, role_id: roleId }),
                });
                const avatarPath = (data && data.avatar) || '';
                if (data && data.placeholder) {
                    _toast('角色特征为空，请先在角色详情设置形象特征', 'warning');
                } else {
                    _toast('头像已更新', 'success');
                }
                // 全局同步事件：通知所有展示位
                global.dispatchEvent(new CustomEvent('storyforge:role-avatar-updated', {
                    detail: { roleId: roleId, avatarPath: avatarPath, roleName: roleName },
                }));
            } catch (e) {
                _toast('生成头像失败: ' + e.message, 'error');
            }
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

            // F8-T8 筛选维度栏（6 维：国家/地域、信仰、阵营、种族、职业、年龄段）
            this._filterBar = _el('div', { class: 'rmp-filterbar' });
            this._filterSelects = {}; // {dimension: <select>}
            this._filterActive = {};  // {dimension: value} 当前生效筛选
            this._filterOptions = {}; // {dimension: [values]}
            this._buildFilterBar();
            this._root.appendChild(this._filterBar);

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
            this._initResize();
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
                // F8-T8：图谱加载后拉取筛选维度候选值并同步筛选栏状态
                await this._loadFilterOptions();
                this._syncFilterBar();
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

        // ---------- F8-T8 多维筛选 ----------
        // 6 个筛选维度（对齐 F8 技术方案 §3.1 / 服务端 _filter_dimensions）
        _filterDims() {
            return [
                { key: 'nationality', label: '国家/地域' },
                { key: 'faith', label: '信仰' },
                { key: 'camp', label: '阵营' },
                { key: 'race', label: '种族' },
                { key: 'profession', label: '职业' },
                { key: 'age_group', label: '年龄段' },
            ];
        }

        _buildFilterBar() {
            const self = this;
            // 清空容器用 replaceChildren（等价 innerHTML=''，且规避 innerHTML 注入检查）
            this._filterBar.replaceChildren();
            this._filterBar.appendChild(_el('span', { class: 'rmp-filter-title', text: '筛选：' }));
            this._filterDims().forEach(function (dim) {
                const field = _el('label', { class: 'rmp-filter-item' });
                field.appendChild(_el('span', { class: 'rmp-filter-label', text: dim.label }));
                const select = _el('select', {
                    class: 'rmp-filter-select',
                    'data-dim': dim.key,
                    onchange: function (ev) { self._onFilterChange(dim.key, ev.target.value); },
                });
                // 初始仅「全部」选项，候选值异步加载后填充
                select.appendChild(_el('option', { value: '', text: '全部' }));
                field.appendChild(select);
                self._filterBar.appendChild(field);
                self._filterSelects[dim.key] = select;
            });
            // 匹配计数 + 清除筛选
            this._filterCount = _el('span', { class: 'rmp-filter-count' });
            this._filterBar.appendChild(this._filterCount);
            this._filterBar.appendChild(_el('button', {
                class: 'rmp-btn rmp-btn-sm', text: '清除', onclick: function () { self._clearFilter(); },
            }));
        }

        async _loadFilterOptions() {
            try {
                const data = await _request(this._api('/filter/options') + '?project_id=' + encodeURIComponent(this.projectId));
                this._filterOptions = (data && typeof data === 'object') ? data : {};
            } catch (e) {
                // 候选值加载失败不阻塞图谱（筛选栏保持「全部」）
                this._filterOptions = {};
            }
        }

        _syncFilterBar() {
            // 候选值变化时重填下拉，保留当前选中值
            const self = this;
            this._filterDims().forEach(function (dim) {
                const select = self._filterSelects[dim.key];
                if (!select) return;
                const cur = select.value;
                select.replaceChildren();
                select.appendChild(_el('option', { value: '', text: '全部' }));
                const vals = self._filterOptions[dim.key] || [];
                vals.forEach(function (v) {
                    select.appendChild(_el('option', { value: v, text: v }));
                });
                // 保留当前生效值（若候选仍存在）
                if (cur && vals.indexOf(cur) >= 0) select.value = cur;
                else if (!cur) select.value = '';
                else select.value = ''; // 已选值不存在于新候选，重置
            });
        }

        _onFilterChange(dim, value) {
            if (value) this._filterActive[dim] = value;
            else delete this._filterActive[dim];
            this._applyFilter();
        }

        _clearFilter() {
            this._filterActive = {};
            const self = this;
            this._filterDims().forEach(function (dim) {
                const select = self._filterSelects[dim.key];
                if (select) select.value = '';
            });
            this._applyFilter();
        }

        _hasActiveFilter() {
            return Object.keys(this._filterActive).length > 0;
        }

        // 组合筛选：服务端过滤（多维度 AND、单维度多值 OR），前端对全量节点/边打 class
        async _applyFilter() {
            if (!this._hasActiveFilter()) {
                // 无筛选：恢复全图（去掉所有 matched/dimmed）
                this._clearMatchClasses();
                this._filterCount.textContent = '';
                this._updateLegend();
                return;
            }
            try {
                const resp = await _request(this._api('/filter'), {
                    method: 'POST',
                    body: JSON.stringify({ project_id: this.projectId, filters: this._filterActive }),
                });
                // resp: {nodes, edges, matched_count, total_count}
                const matched = (resp && resp.nodes) || [];
                const matchedIds = {};
                matched.forEach(function (n) { matchedIds[n.id] = true; });
                this._applyMatchClasses(matchedIds);
                this._filterCount.textContent = '匹配 ' + (resp.matched_count || matched.length) +
                    ' / ' + (resp.total_count != null ? resp.total_count : this._nodes.length);
            } catch (e) {
                _toast('筛选失败: ' + e.message, 'error');
            }
        }

        // F9-T8 恢复边颜色：清除高亮/筛选后，每条边回到各自 color（无 color 回退 CSS 默认灰）。
        // 内联 stroke 必须重设（而非清空），否则清除筛选后新边颜色会丢失。
        _restoreLinkColors() {
            if (!this._linkSel) return;
            this._linkSel.each(function (d) {
                const el = d3.select(this);
                if (d && d.color && /^#[0-9a-fA-F]{6}$/.test(d.color)) {
                    el.style('stroke', d.color);
                } else {
                    el.style('stroke', null);
                }
            });
        }

        // 对全量节点/边打 class：节点命中 → matched，未命中 → dimmed；
        // 边两端均命中 → matched，否则 dimmed。
        _applyMatchClasses(matchedIds) {
            const self = this;
            // 清空旧 class（保留 rmp-node / rmp-link 基础类）+ F9-T8 恢复边颜色（不清空内联，防丢色）
            this._nodeSel && this._nodeSel.classed('matched', false).classed('dimmed', false);
            this._linkSel && this._linkSel.classed('matched', false).classed('dimmed', false);
            this._restoreLinkColors();
            this._linkLabelSel && this._linkLabelSel.classed('matched', false).classed('dimmed', false);
            if (!this._nodeSel || !this._linkSel) return;

            this._nodeSel.each(function (d) {
                const el = d3.select(this);
                el.classed('matched', !!matchedIds[d.id]);
                el.classed('dimmed', !matchedIds[d.id]);
            });
            // 边：source/target 解析（d3-force 会把 source/target 转为节点对象）
            this._linkSel.each(function (d) {
                const s = (d.source && d.source.id) ? d.source.id : d.source;
                const t = (d.target && d.target.id) ? d.target.id : d.target;
                const hit = matchedIds[s] && matchedIds[t];
                const el = d3.select(this);
                el.classed('matched', !!hit);
                el.classed('dimmed', !hit);
                // F9-T8 高亮优先：matched 边保留各自 color（避免统一橙色丢失区分度）；
                // dimmed 边用 CSS 类置灰。matched 用内联覆盖高亮类。
                if (hit) {
                    const c = d && d.color;
                    if (c && /^#[0-9a-fA-F]{6}$/.test(c)) { el.style('stroke', c); }
                }
            });
            this._linkLabelSel && this._linkLabelSel.each(function (d) {
                const s = (d.source && d.source.id) ? d.source.id : d.source;
                const t = (d.target && d.target.id) ? d.target.id : d.target;
                const hit = matchedIds[s] && matchedIds[t];
                const el = d3.select(this);
                el.classed('matched', !!hit);
                el.classed('dimmed', !hit);
            });
        }

        _clearMatchClasses() {
            this._nodeSel && this._nodeSel.classed('matched', false).classed('dimmed', false);
            this._linkSel && this._linkSel.classed('matched', false).classed('dimmed', false);
            // F9-T8 恢复边颜色（不清空内联 stroke，防清除筛选后新边颜色丢失）
            this._restoreLinkColors();
            this._linkLabelSel && this._linkLabelSel.classed('matched', false).classed('dimmed', false);
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
                    return { source: e.source, target: e.target, relation_type: e.relation_type, note: e.note, color: e.color };
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
            // F9-T6 版图节点头像：圆形裁剪叠加于色点之上，缺失回退色点
            nodeEnter.append('defs').append('clipPath').attr('id', function (d) { return 'rmp-clip-' + d.id; })
                .append('circle').attr('r', 16);
            nodeEnter.append('image').attr('class', 'rmp-node-avatar')
                .attr('x', -16).attr('y', -16).attr('width', 32).attr('height', 32)
                .attr('clip-path', function (d) { return 'url(#rmp-clip-' + d.id + ')'; })
                .attr('preserveAspectRatio', 'xMidYMid slice')
                .attr('href', function (d) { return d.avatar || ''; });
            nodeEnter.append('text').attr('dy', 4).text(function (d) { return d.name || d.id; });
            nodeEnter.append('title').text(function (d) { return d.name || d.id; });

            const nodeMerge = nodeEnter.merge(node);
            nodeMerge.select('circle').attr('fill', function (d) { return _nodeColor(d); });
            nodeMerge.select('text').text(function (d) { return d.name || d.id; });
            // F9-T6：更新头像 href（缺失置空 → 色点回退可见）
            nodeMerge.select('image.rmp-node-avatar').attr('href', function (d) { return d.avatar || ''; });

            // 边
            const link = g.selectAll('line.rmp-link').data(links, function (d) {
                return (typeof d.source === 'object' ? d.source.id : d.source) + '-' + (typeof d.target === 'object' ? d.target.id : d.target);
            });
            const linkEnter = link.enter().insert('line', 'g').attr('class', 'rmp-link');
            const linkMerge = linkEnter.merge(link);
            // F9-T8 连线颜色：优先 edge.color（服务端分配唯一高对比度色），缺失回退默认灰。
            // 必须用 .style()（内联样式）而非 .attr()（presentation attribute）——
            // CSS 规则 .rmp-link{stroke:#94a3b8} 优先级高于 presentation attribute，
            // 用 .attr() 会导致新边颜色被覆盖回灰色。
            linkMerge.style('stroke', function (d) {
                if (d && d.color && /^#[0-9a-fA-F]{6}$/.test(d.color)) return d.color;
                return '#94a3b8';
            });

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

            // 点击节点 → 详情（F8-T9）
            // 优先外部钩子（index.html 可注入 onNodeClick 自定义跳转）；否则内置详情面板。
            // 内置详情用点击时的节点数据 d（含完整属性），免二次请求基础信息。
            nodeMerge.on('click', function (event, d) {
                if (d._dragged) return; // 拖拽后不触发点击
                if (this.onNodeClick) { this.onNodeClick(d); return; }
                this._openRoleDetail(d);
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
                    // F8-16：拖拽期跳过 150 条边标签的中点重排（标签仅静态可读，
                    // 松手后 layout 收敛会在静止态 tick 中重新定位）。
                    if (self._draggingNodeId == null) {
                        self._linkLabelSel
                            .attr('x', function (d) { return (d.source.x + d.target.x) / 2; })
                            .attr('y', function (d) { return (d.source.y + d.target.y) / 2; });
                    }
                    self._nodeSel.attr('transform', function (d) { return 'translate(' + d.x + ',' + d.y + ')'; });
                });
            };
        }

        // F8-T11 触屏判定：细指针（鼠标）为 false；粗指针（触屏/手写笔）为 true
        _isTouch() {
            if (this._touchDetected != null) return this._touchDetected;
            const mq = global.matchMedia && global.matchMedia('(pointer: coarse)');
            this._touchDetected = !!(mq && mq.matches);
            return this._touchDetected;
        }

        // F8-T11 移动端手势：
        //   - 触屏节点不启用 d3.drag（filter 排除 touch），单指平移/双指捏合由 d3.zoom 原生接管；
        //   - 节点 tap（无位移）仍触发 click → 打开详情；
        //   - 鼠标（细指针）保持原行为：按下即拖节点。
        // 说明：触屏「长按拖节点」与 d3.zoom 平移在 touchstart 上互斥（d3 用 stopImmediatePropagation
        // 独占），无法延迟判定，故触屏以画布平移/缩放为准（对齐 T11 多视口截图验收）。
        //
        // F8-16 交互态性能：拖拽期帧率从 48.8fps 提到 60fps。
        //   根因：d3.drag 的 move 事件频率高于显示刷新率（HiDPI/高刷新输入可达 240Hz），
        //   每次 move 都直接改写 fx/fy，导致 forceSimulation 在单帧内多次 tick，
        //   100 节点 + 150 边 + 150 标签的全量重算叠加成掉帧。
        //   修复：拖拽目标坐标按 rAF 合帧（每帧最多写一次 fx/fy），并把「当前拖拽节点 id」
        //   暴露给 tick 处理器，拖拽期跳过边标签文本重排（标签只读中点，非交互必需）。
        _dragBehavior(d3, sim) {
            const self = this;
            let pending = null;      // { node, x, y }
            let rafId = null;

            return d3.drag()
                .filter(function (event) {
                    // 触屏：交由 zoom（单指平移/双指捏合），不拖节点
                    if (event.type && event.type.indexOf('touch') === 0) return false;
                    return true;
                })
                .on('start', function (event, d) {
                    if (!event.active) sim.alphaTarget(0.3).restart();
                    d.fx = d.x; d.fy = d.y;
                    d._dragged = false;
                    self._draggingNodeId = d.id;
                })
                .on('drag', function (event, d) {
                    d._dragged = true;
                    // 合帧：同一帧内多次 move 只保留最后一次坐标
                    pending = { node: d, x: event.x, y: event.y };
                    if (rafId != null) return;
                    rafId = requestAnimationFrame(function () {
                        rafId = null;
                        if (pending && !self._destroyed) {
                            pending.node.fx = pending.x;
                            pending.node.fy = pending.y;
                        }
                        pending = null;
                    });
                })
                .on('end', function (event, d) {
                    if (!event.active) sim.alphaTarget(0);
                    // 收尾：把最后一帧未应用的坐标补写一次，避免松手后节点回弹
                    if (pending && pending.node === d && rafId != null) {
                        d.fx = pending.x; d.fy = pending.y;
                        rafId = null; pending = null;
                    } else if (pending) {
                        pending = null;
                    }
                    d.fx = null; d.fy = null;
                    self._draggingNodeId = null;
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
            // F8-T11 触摸手势：svg 禁用触摸默认滚动，交由 d3.zoom 处理单指平移/双指捏合
            svg.style('touch-action', 'none');
            this._zoom = d3.zoom()
                .scaleExtent([0.2, 4])
                .on('zoom', function (event) {
                    g.attr('transform', event.transform);
                });
            svg.call(this._zoom);
        }

        // F8-T11 容器自适应：监听画布容器尺寸变化，重算力导向中心并重绘。
        // 面板在窗口 resize / 侧栏开合时宽度变化，ResizeObserver 保持图谱居中不偏。
        // 注意：d3.zoom 没有 resize() 方法；resize 时仅更新 extent（避免滚轮缩放中心错位），
        // 不移动 transform——节点数据已由 forceCenter(w/2,h/2) 居中，若再叠加 zoom 平移
        // 会造成双重偏移（节点被推到右下角）。
        _initResize() {
            const self = this;
            if (typeof ResizeObserver === 'undefined') return;
            const wrap = this._root.querySelector('.rmp-canvas-wrap');
            if (!wrap) return;
            this._resizeObs = new ResizeObserver(function (entries) {
                const entry = entries && entries[0];
                if (!entry) return;
                const w = entry.contentRect.width;
                const h = entry.contentRect.height;
                if (!w || !h) return;
                self._width = w;
                self._height = h;
                if (self._sim) {
                    self._sim.force('center', global.d3.forceCenter(w / 2, h / 2));
                    self._sim.force('charge', global.d3.forceManyBody().strength(-300));
                    self._sim.alpha(0.3).restart();
                }
                if (self._zoom) {
                    self._zoom.extent([[0, 0], [w, h]]);
                }
            });
            this._resizeObs.observe(wrap);
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

        // ---------- F8-T9 角色详情侧滑面板 ----------
        // 用点击时的节点数据 d（含完整属性）免二次请求基础信息 + 本地关系列表。
        // 成长线（F8-T10）与详情 API 深度数据在本面板内按需异步补齐。
        _openRoleDetail(d) {
            if (!d || !d.id) return;
            const self = this;
            // 关闭已有详情
            this._closeRoleDetail();

            const panel = _el('div', { class: 'rmp-detail' });
            this._detailEl = panel;
            // F9-T7：记录当前详情角色数据（供头像同步事件更新 src）
            this._detailData = d;

            // 头部：角色名 + 阵营色点 + 生成头像 + 关闭
            const name = d.name || d.id;
            // F9-T6 详情侧滑头部头像：有 avatar 显示圆形头像，否则隐藏回退色点
            const head = _el('div', { class: 'rmp-detail-head' }, [
                _el('span', { class: 'rmp-detail-dot', style: 'background:' + _nodeColor(d) + ';' }),
                _el('img', { class: 'rmp-detail-avatar' + (d.avatar ? ' show' : ''), src: d.avatar || '' }),
                _el('h4', { text: name }),
                // F9-T7：生成头像按钮 → POST avatar/generate → 成功后派发同步事件
                _el('button', {
                    class: 'rmp-btn', text: '生成头像',
                    onclick: () => self._generateAvatar(d.id, d.name || name),
                }),
                _el('button', { class: 'rmp-detail-close', text: '×', onclick: () => self._closeRoleDetail() }),
            ]);
            panel.appendChild(head);

            // 基础信息（免二次请求：来自节点数据）
            const info = _el('div', { class: 'rmp-detail-body' });
            const dims = [
                ['nationality', '国家/地域'], ['faith', '信仰'], ['camp', '阵营'],
                ['race', '种族'], ['profession', '职业'], ['age_group', '年龄段'],
                ['identity', '身份'],
            ];
            dims.forEach(function (pair) {
                const v = d[pair[0]] || '';
                if (!v) return;
                info.appendChild(_el('div', { class: 'rmp-detail-row' }, [
                    _el('span', { class: 'rmp-detail-k', text: pair[1] + '：' }),
                    _el('span', { class: 'rmp-detail-v', text: v }),
                ]));
            });
            panel.appendChild(info);

            // 关系列表（来自本地图谱边，免二次请求）
            const relTitle = _el('div', { class: 'rmp-detail-sec-title', text: '关系' });
            panel.appendChild(relTitle);
            const relBox = _el('div', { class: 'rmp-detail-rels' });
            const rels = this._edges.filter(function (e) {
                return e.source === d.id || e.target === d.id;
            });
            if (!rels.length) {
                relBox.appendChild(_el('div', { class: 'rmp-nodata', text: '暂无关系' }));
            } else {
                rels.forEach(function (e) {
                    const otherId = e.source === d.id ? e.target : e.source;
                    const other = self._nodes.find(function (n) { return n.id === otherId; });
                    const otherName = other ? (other.name || other.id) : otherId;
                    const row = _el('div', { class: 'rmp-detail-rel' });
                    row.appendChild(_el('span', { class: 'rmp-detail-rel-type', text: _relLabel(e.relation_type) }));
                    row.appendChild(_el('span', { class: 'rmp-detail-rel-name', text: otherName }));
                    if (e.note) row.appendChild(_el('span', { class: 'rmp-detail-rel-note', text: e.note }));
                    relBox.appendChild(row);
                });
            }
            panel.appendChild(relBox);

            // 成长线占位（F8-T10 在此渲染）
            const growthTitle = _el('div', { class: 'rmp-detail-sec-title', text: '成长线' });
            panel.appendChild(growthTitle);
            const growthBox = _el('div', { class: 'rmp-detail-growth' });
            growthBox.appendChild(_el('div', { class: 'rmp-nodata', text: '成长线加载中...' }));
            panel.appendChild(growthBox);
            this._detailGrowthBox = growthBox;

            this._root.appendChild(panel);

            // F8-T10：异步加载成长线（剧情树按角色过滤）
            this._loadGrowth(d.id);
        }

        _closeRoleDetail() {
            if (this._detailEl) { this._detailEl.remove(); this._detailEl = null; }
            if (this._detailGrowthBox) this._detailGrowthBox = null;
            this._detailData = null;
        }

        // ---------- F8-T10 成长线时间线 ----------
        // 纵向时间轴：按 order 排序渲染剧情节点；支持逐段浏览（上/下一段）、
        // 快速定位（刻度点击）、历史回溯（已读节点可点击高亮）、章节跳转（onNodeJump 钩子）。
        async _loadGrowth(roleId) {
            if (!this.projectId) return;
            const box = this._detailGrowthBox;
            if (!box) return;
            try {
                const url = this._api('/roles/' + encodeURIComponent(roleId) +
                    '?project_id=' + encodeURIComponent(this.projectId));
                const data = await _request(url);
                const nodes = (data && data.growth && data.growth.nodes) || [];
                if (!this._detailGrowthBox) return;
                box.replaceChildren();
                if (!nodes.length) {
                    box.appendChild(_el('div', { class: 'rmp-nodata', text: '暂无成长线' }));
                    return;
                }
                this._renderGrowthTimeline(box, nodes);
            } catch (e) {
                if (this._detailGrowthBox) {
                    box.replaceChildren();
                    box.appendChild(_el('div', { class: 'rmp-nodata', text: '成长线加载失败: ' + e.message }));
                }
            }
        }

        _renderGrowthTimeline(box, nodes) {
            const self = this;
            this._growthNodes = nodes;
            this._growthIndex = 0;

            // 工具条：上一段 / 下一段 / 进度
            const nav = _el('div', { class: 'rmp-growth-nav' });
            const prevBtn = _el('button', { class: 'rmp-btn-sm', text: '◀ 上一段', onclick: function () { self._growthStep(-1); } });
            const nextBtn = _el('button', { class: 'rmp-btn-sm', text: '下一段 ▶', onclick: function () { self._growthStep(1); } });
            const progress = _el('span', { class: 'rmp-growth-progress', text: '1/' + nodes.length });
            this._growthPrevBtn = prevBtn;
            this._growthNextBtn = nextBtn;
            this._growthProgress = progress;
            nav.appendChild(prevBtn);
            nav.appendChild(progress);
            nav.appendChild(nextBtn);
            box.appendChild(nav);

            // 时间轴主体：一条竖线 + 节点列表（含刻度）
            const axis = _el('div', { class: 'rmp-growth-axis' });
            const list = _el('div', { class: 'rmp-growth-list' });
            this._growthAxis = axis;
            this._growthList = list;
            const dot = _el('div', { class: 'rmp-growth-line' });
            axis.appendChild(dot);
            box.appendChild(axis);
            box.appendChild(list);

            nodes.forEach(function (n, i) {
                const row = _el('div', { class: 'rmp-growth-item' });
                // 时间刻度（可点击快速定位）
                const tick = _el('div', { class: 'rmp-growth-tick', onclick: function () { self._growthGoTo(i); } });
                row.appendChild(tick);
                // 内容
                const content = _el('div', { class: 'rmp-growth-content' });
                const title = n.label || n.title || ('剧情节点 ' + (n.order != null ? n.order : ''));
                content.appendChild(_el('div', { class: 'rmp-growth-title', text: title }));
                const sub = [];
                if (n.type) sub.push(n.type);
                if (n.tree_name) sub.push(n.tree_name);
                content.appendChild(_el('div', { class: 'rmp-growth-sub', text: sub.join(' · ') }));
                // 章节跳转按钮
                const jumpBtn = _el('button', { class: 'rmp-btn-sm rmp-growth-jump', text: '跳转', onclick: function (e) {
                    e.stopPropagation();
                    self._growthJump(n);
                } });
                content.appendChild(jumpBtn);
                row.appendChild(content);
                list.appendChild(row);
            });

            // 初始化定位到第一段
            this._growthGoTo(0, true);
        }

        // 逐段浏览：上/下一段
        _growthStep(delta) {
            const next = Math.max(0, Math.min((this._growthNodes.length - 1), (this._growthIndex || 0) + delta));
            this._growthGoTo(next);
        }

        // 快速定位：跳转到指定段并高亮
        _growthGoTo(index, silent) {
            const nodes = this._growthNodes || [];
            if (!nodes.length) return;
            const idx = Math.max(0, Math.min(nodes.length - 1, index));
            this._growthIndex = idx;
            // 更新进度
            if (this._growthProgress) this._growthProgress.textContent = (idx + 1) + '/' + nodes.length;
            // 更新按钮禁用态
            if (this._growthPrevBtn) this._growthPrevBtn.disabled = (idx === 0);
            if (this._growthNextBtn) this._growthNextBtn.disabled = (idx === nodes.length - 1);
            // 高亮当前段（历史回溯：index <= current 视为已读）
            const items = this._growthList ? this._growthList.children : [];
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                item.classList.remove('active', 'done', 'future');
                if (i < idx) item.classList.add('done');      // 已读（历史回溯可点击）
                else if (i === idx) item.classList.add('active'); // 当前段
                else item.classList.add('future');             // 未来段
            }
            // 滚动到当前段（非 silent 时）
            if (!silent && this._growthList && items[idx]) {
                items[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }

        // 章节跳转：回调外部钩子（onNodeJump），否则面板内定位高亮
        _growthJump(n) {
            if (this.onNodeJump) {
                this.onNodeJump({ treeId: n.tree_id, nodeId: n.id, label: n.label || n.title });
                return;
            }
            // 无外部钩子：面板内定位（回退）
            const idx = this._growthNodes.findIndex(function (x) { return x.id === n.id; });
            if (idx >= 0) this._growthGoTo(idx);
        }

        // ---------- 关闭 ----------
        _close() {
            this._destroyed = true;
            // F9-T7：移除头像同步监听
            global.removeEventListener('storyforge:role-avatar-updated', this._onAvatarUpdated);
            if (this._sim) this._sim.stop();
            if (this._raf) cancelAnimationFrame(this._raf);
            if (this._resizeObs) { this._resizeObs.disconnect(); this._resizeObs = null; }
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
