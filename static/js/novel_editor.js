// static/js/novel_editor.js —— 小说创作前端编辑器（P3/P4）
// 目标架构：角色驱动小说创作工作台前端，经 app.js 入口加载。
// 能力：项目/章节编辑、角色面板、11 步流程、多角色协同、工具命令面板联动。
// 说明：本文件为架构骨架占位，交互实现随 P3-T8/T9 与 P4 工具面板编码落地。
//
// ─────────────────────────────────────────────────────────────────────────────
// F5→P3 知识库角色同步导入组件（本轮交付）
// 提供「从知识库导入」完整前端能力：
//   - 入口按钮（可挂载到任意角色管理容器）
//   - 候选角色批量勾选 + 关键词过滤
//   - 单条角色预览导入（字段映射标红 + 自定义编辑）
//   - 批量导入 + 结果反馈（成功数 / 失败原因）
//   - 导入历史回溯
// 用法：
//   StoryForgeKBRoleImport.mount({ projectId, mountEl, apiBase });
// 组件自带轻量请求与反馈，不依赖 app.js IIFE 内部符号。
// ─────────────────────────────────────────────────────────────────────────────

(function (global) {
    'use strict';

    // ---------- 轻量请求（独立，复用后端 {code,data,message} 契约） ----------
    async function _request(url, options) {
        const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
        const resp = await fetch(url, { ...options, headers });
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

    // ---------- 轻量 toast（自带容器，避免依赖 app.js 内部 showToast） ----------
    function _ensureToast() {
        let box = document.getElementById('kb-import-toast-box');
        if (!box) {
            box = document.createElement('div');
            box.id = 'kb-import-toast-box';
            box.style.cssText = 'position:fixed;top:var(--sp-4,16px);right:var(--sp-4,16px);z-index:99999;display:flex;flex-direction:column;gap:var(--sp-2,8px);';
            document.body.appendChild(box);
        }
        return box;
    }

    function _toast(msg, type) {
        const box = _ensureToast();
        const el = document.createElement('div');
        const colors = {
            success: 'var(--success,#16a34a)', warning: 'var(--warning,#d97706)', error: 'var(--danger,#dc2626)', info: 'var(--accent,#2563eb)',
        };
        el.style.cssText = 'padding:var(--sp-3,10px) var(--sp-4,16px);border-radius:var(--radius-md,8px);color:var(--text-inverse,#fff);font-size:var(--fs-body,14px);' +
            'box-shadow:0 4px 12px rgba(0,0,0,.2);background:' + (colors[type] || colors.info) + ';' +
            'max-width:360px;word-break:break-all;transition:opacity .3s;';
        el.textContent = msg;
        box.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3200);
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

    const STYLE_ID = 'kb-role-import-style';
    function _ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
        .kbri-panel{font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);color:var(--text-primary,#1f2937);}
        .kbri-header{display:flex;align-items:center;justify-content:space-between;gap:var(--sp-3,12px);
            padding:var(--sp-3,12px) var(--sp-4,16px);border-bottom:1px solid var(--border-color,#e5e7eb);background:var(--bg-tertiary,#f9fafb);border-radius:var(--radius-md,8px) var(--radius-md,8px) 0 0;}
        .kbri-header h3{margin:0;font-size:var(--fs-h3,16px);font-weight:var(--fw-semibold,600);}
        .kbri-tabs{display:flex;gap:var(--sp-1,4px);border-bottom:1px solid var(--border-color,#e5e7eb);padding:0 var(--sp-3,12px);}
        .kbri-tab{padding:var(--sp-2,8px) var(--sp-4,14px);font-size:var(--fs-body,14px);cursor:pointer;border:none;background:none;
            color:var(--text-tertiary,#6b7280);border-bottom:2px solid transparent;}
        .kbri-tab.active{color:var(--accent,#2563eb);border-bottom-color:var(--accent,#2563eb);font-weight:var(--fw-semibold,600);}
        .kbri-toolbar{display:flex;gap:var(--sp-2,8px);padding:var(--sp-3,10px) var(--sp-4,16px);flex-wrap:wrap;align-items:center;}
        .kbri-search{flex:1;min-width:180px;padding:var(--sp-2,8px) var(--sp-3,12px);border:1px solid var(--border-color,#d1d5db);
            border-radius:var(--radius-sm,6px);font-size:var(--fs-body,14px);background:var(--bg-input,#fff);color:var(--text-primary,#1f2937);}
        .kbri-search:focus{border-color:var(--accent,#2563eb);box-shadow:0 0 0 3px var(--accent-light,#dbeafe);outline:none;}
        .kbri-btn{padding:var(--sp-2,7px) var(--sp-4,14px);border-radius:var(--radius-sm,6px);font-size:var(--fs-body,14px);cursor:pointer;
            border:1px solid var(--border-color,#d1d5db);background:var(--bg-card,#fff);color:var(--text-primary,#374151);transition:var(--transition,.2s);}
        .kbri-btn:hover{background:var(--bg-hover,#f3f4f6);}
        .kbri-btn:active{transform:scale(.97);}
        .kbri-btn.primary{background:var(--accent,#2563eb);border-color:var(--accent,#2563eb);color:var(--text-inverse,#fff);}
        .kbri-btn.primary:hover{background:var(--accent-hover,#1d4ed8);border-color:var(--accent-hover,#1d4ed8);}
        .kbri-btn:disabled{opacity:.5;cursor:not-allowed;}
        .kbri-list{padding:0 var(--sp-4,16px);max-height:340px;overflow-y:auto;}
        .kbri-item{display:flex;align-items:flex-start;gap:var(--sp-3,10px);padding:var(--sp-3,10px) 0;
            border-bottom:1px solid var(--border-light,#f3f4f6);}
        .kbri-item:last-child{border-bottom:none;}
        .kbri-item.unavailable{opacity:.5;}
        .kbri-info{flex:1;}
        .kbri-name{font-weight:var(--fw-semibold,600);font-size:var(--fs-body-lg,15px);}
        .kbri-meta{font-size:var(--fs-small,13px);color:var(--text-tertiary,#6b7280);margin-top:2px;}
        .kbri-tag{display:inline-block;padding:1px 6px;border-radius:var(--radius-sm,4px);font-size:var(--fs-small,12px);
            margin-right:var(--sp-1,4px);}
        .kbri-tag.warn{background:var(--warning-100,#fef3c7);color:var(--warning,#92400e);}
        .kbri-tag.ok{background:var(--success-100,#d1fae5);color:var(--success,#065f46);}
        .kbri-empty{padding:var(--sp-6,24px);text-align:center;color:var(--text-tertiary,#9ca3af);font-size:var(--fs-body,14px);}
        .kbri-foot{padding:var(--sp-3,12px) var(--sp-4,16px);border-top:1px solid var(--border-color,#e5e7eb);display:flex;justify-content:space-between;
            align-items:center;background:var(--bg-tertiary,#f9fafb);border-radius:0 0 var(--radius-md,8px) var(--radius-md,8px);}
        .kbri-foot .kbri-btn{margin-left:var(--sp-2,8px);}
        .kbri-history{padding:0 var(--sp-4,16px);max-height:300px;overflow-y:auto;}
        .kbri-hitem{padding:var(--sp-3,10px) 0;border-bottom:1px solid var(--border-light,#f3f4f6);font-size:var(--fs-body,14px);}
        .kbri-hitem:last-child{border-bottom:none;}
        .kbri-hmeta{color:var(--text-tertiary,#6b7280);font-size:var(--fs-small,12px);}
        .kbri-flags{margin-top:var(--sp-2,6px);}
        .kbri-flag{display:inline-block;margin:2px var(--sp-1,4px) 2px 0;padding:1px 6px;border-radius:var(--radius-sm,4px);
            font-size:var(--fs-small,12px);background:var(--danger-100,#fee2e2);color:var(--danger,#b91c1c);border:1px solid var(--danger-100,#fecaca);}
        .kbri-flag.ok{background:var(--success-100,#d1fae5);color:var(--success,#065f46);border-color:var(--success-100,#a7f3d0);}
        .kbri-result{padding:var(--sp-3,12px) var(--sp-4,16px);font-size:var(--fs-body,14px);border-radius:var(--radius-sm,6px);margin:var(--sp-3,12px) var(--sp-4,16px);}
        .kbri-result.ok{background:var(--success-100,#ecfdf5);color:var(--success,#065f46);border:1px solid var(--success-100,#a7f3d0);}
        .kbri-result.partial{background:var(--warning-100,#fffbeb);color:var(--warning,#92400e);border:1px solid var(--warning-100,#fde68a);}
        .kbri-result.error{background:var(--danger-100,#fef2f2);color:var(--danger,#991b1b);border:1px solid var(--danger-100,#fecaca);}
        .kbri-fail{font-size:var(--fs-small,13px);color:var(--text-tertiary,#6b7280);margin-top:var(--sp-1,4px);}
        .kbri-fail li{list-style:none;}
        `;
        document.head.appendChild(style);
    }

    // ---------- 字段映射标红标签 ----------
    function _fieldFlag(fm) {
        if (!fm) return '';
        const ok = fm.mapped;
        const reason = fm.reason || '';
        const labelMap = {
            kb_no_appearance: '外貌待补', kb_missing: '缺失', target_missing: '关系未关联',
        };
        const text = labelMap[reason] || (ok ? '已映射' : '待补');
        return '<span class="kbri-flag ' + (ok ? 'ok' : '') + '">' + text + '</span>';
    }

    // ---------- 主组件 ----------
    class KBRoleImportPanel {
        constructor(opts) {
            this.projectId = opts.projectId;
            this.mountEl = opts.mountEl || document.body;
            this.apiBase = opts.apiBase || '';
            this.candidates = [];
            this.selected = new Set(); // 存 candidate key（entry_id:role_index）
            this.history = [];
            this.tab = 'list';
            this.keyword = '';
            this._built = false;
        }

        // 候选唯一键
        _key(c) { return c.entry_id + ':' + c.role_index; }

        // 构建整体 UI
        build() {
            _ensureStyle();
            if (!this._built) {
                this._root = _el('div', { class: 'kbri-panel', style: 'background:var(--bg-card,#fff);border:1px solid var(--border-color,#e5e7eb);border-radius:var(--radius-md,8px);' });
                this.mountEl.appendChild(this._root);
                this._built = true;
            }
            this._renderShell();
            this.refreshCandidates();
            return this._root;
        }

        _renderShell() {
            this._root.innerHTML = _escapeHtml('');
            const header = _el('div', { class: 'kbri-header' }, [
                _el('h3', { text: '从知识库导入角色' }),
                _el('button', { class: 'kbri-btn', text: '关闭', onclick: () => { if (this.onClose) this.onClose(); } }),
            ]);
            const tabs = _el('div', { class: 'kbri-tabs' }, [
                _el('button', { class: 'kbri-tab' + (this.tab === 'list' ? ' active' : ''), text: '候选角色', onclick: () => this._switchTab('list') }),
                _el('button', { class: 'kbri-tab' + (this.tab === 'history' ? ' active' : ''), text: '导入历史', onclick: () => this._switchTab('history') }),
            ]);
            this._root.appendChild(header);
            this._root.appendChild(tabs);
            this._body = _el('div', {});
            this._root.appendChild(this._body);
            this._renderBody();
        }

        _switchTab(tab) {
            this.tab = tab;
            this._renderShell();
            if (tab === 'history') this.refreshHistory();
        }

        _renderBody() {
            this._body.innerHTML = _escapeHtml('');
            if (this.tab === 'history') this._renderHistory();
            else this._renderList();
        }

        // ---- 列表（候选 + 批量） ----
        _renderList() {
            const toolbar = _el('div', { class: 'kbri-toolbar' }, [
                _el('input', {
                    class: 'kbri-search', placeholder: '搜索知识库条目…', value: this.keyword,
                    oninput: (e) => { this.keyword = e.target.value; this._debouncedRefresh(); },
                }),
                _el('button', { class: 'kbri-btn', text: '刷新', onclick: () => this.refreshCandidates() }),
            ]);
            this._body.appendChild(toolbar);

            this._listBox = _el('div', { class: 'kbri-list' });
            this._body.appendChild(this._listBox);
            this._renderCandidates();

            const foot = _el('div', { class: 'kbri-foot' }, [
                _el('span', { text: '已选 ' + this.selected.size + ' / ' + this.candidates.length }),
                (() => {
                    const wrap = _el('div', {});
                    wrap.appendChild(_el('button', {
                        class: 'kbri-btn', text: '预览选中', disabled: this.selected.size === 0,
                        onclick: () => this._previewSelected(),
                    }));
                    wrap.appendChild(_el('button', {
                        class: 'kbri-btn primary', text: '批量导入', disabled: this.selected.size === 0,
                        onclick: () => this._batchImport(),
                    }));
                    return wrap;
                })(),
            ]);
            this._body.appendChild(foot);
        }

        _renderCandidates() {
            if (!this._listBox) return;
            this._listBox.innerHTML = _escapeHtml('');
            if (!this.candidates.length) {
                this._listBox.appendChild(_el('div', { class: 'kbri-empty', text: '暂无候选角色（知识库需含 novel 类型条目）' }));
                return;
            }
            this.candidates.forEach(c => {
                const key = this._key(c);
                const checked = this.selected.has(key);
                const unavailable = c.available === false;
                const row = _el('div', { class: 'kbri-item' + (unavailable ? ' unavailable' : '') }, [
                    (() => {
                        const cb = _el('input', { type: 'checkbox', disabled: unavailable });
                        cb.checked = checked;
                        cb.addEventListener('change', () => {
                            if (cb.checked) this.selected.add(key); else this.selected.delete(key);
                            this._refreshFoot();
                        });
                        return cb;
                    })(),
                    _el('div', { class: 'kbri-info' }, [
                        _el('div', { class: 'kbri-name', text: c.name }),
                        _el('div', { class: 'kbri-meta', text: (c.identity || '身份未知') + ' · ' + (c.entry_title || '') }),
                        _el('div', { class: 'kbri-flags' }, [
                            (c.available === false
                                ? _el('span', { class: 'kbri-tag warn', text: '已存在同名角色' })
                                : _el('span', { class: 'kbri-tag ok', text: '可导入' })),
                            (c.relation_edges && c.relation_edges.length
                                ? _el('span', { class: 'kbri-tag', text: '关系 ' + c.relation_edges.length })
                                : null),
                        ].filter(Boolean)),
                    ]),
                    _el('button', {
                        class: 'kbri-btn', text: '预览',
                        onclick: () => this._previewSingle(c),
                    }),
                ]);
                this._listBox.appendChild(row);
            });
        }

        _refreshFoot() {
            const foot = this._body.querySelector('.kbri-foot');
            if (foot) foot.querySelector('span').textContent = '已选 ' + this.selected.size + ' / ' + this.candidates.length;
            const btns = foot.querySelectorAll('.kbri-btn');
            const previewBtn = foot.querySelector('.kbri-btn');
            const importBtn = foot.querySelector('.kbri-btn.primary');
            if (previewBtn) previewBtn.disabled = this.selected.size === 0;
            if (importBtn) importBtn.disabled = this.selected.size === 0;
        }

        _debouncedRefresh() {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = setTimeout(() => this.refreshCandidates(), 350);
        }

        // ---- 数据加载 ----
        async refreshCandidates() {
            const url = this.apiBase + '/api/projects/' + this.projectId + '/kb-roles/candidates';
            const q = this.keyword ? '?keyword=' + encodeURIComponent(this.keyword) : '';
            try {
                const data = await _request(url + q);
                this.candidates = (data && data.items) || [];
                // 清理已不存在的选中
                const valid = new Set(this.candidates.map(c => this._key(c)));
                this.selected = new Set([...this.selected].filter(k => valid.has(k)));
                this._renderBody();
            } catch (e) {
                _toast('加载候选失败: ' + e.message, 'error');
            }
        }

        async refreshHistory() {
            const url = this.apiBase + '/api/projects/' + this.projectId + '/kb-roles/history';
            try {
                const data = await _request(url);
                this.history = (data && data.items) || [];
                this._renderHistory();
            } catch (e) {
                _toast('加载历史失败: ' + e.message, 'error');
            }
        }

        _renderHistory() {
            const box = _el('div', { class: 'kbri-history' });
            if (!this.history.length) {
                box.appendChild(_el('div', { class: 'kbri-empty', text: '暂无导入记录' }));
            }
            this.history.forEach(rec => {
                const rolesTxt = (rec.roles || []).map(r => r.name).join('、');
                box.appendChild(_el('div', { class: 'kbri-hitem' }, [
                    _el('div', { text: '导入 ' + (rec.roles || []).length + ' 个角色：' + rolesTxt }),
                    _el('div', { class: 'kbri-hmeta', text: new Date(rec.imported_at).toLocaleString() }),
                ]));
            });
            this._body.appendChild(box);
        }

        // ---- 预览 ----
        async _previewSelected() {
            const selectedCandidates = this.candidates.filter(c => this.selected.has(this._key(c)));
            this._openPreview(selectedCandidates);
        }

        _previewSingle(c) {
            this._openPreview([c]);
        }

        _openPreview(candidates) {
            if (!candidates.length) return;
            // 直接以预览模式导入（不落库）拿到 payload + field_mapping
            const payloadCands = candidates.map(c => this._toPayload(c));
            this._fetchPreview(payloadCands);
        }

        _toPayload(c) {
            return {
                entry_id: c.entry_id, entry_title: c.entry_title, role_index: c.role_index,
                name: c.name, identity: c.identity || '', personality: c.personality || '',
                relation_edges: (c.relation_edges || []).map(e => ({
                    a: e.a, b: e.b, relation: e.relation, camp: e.camp,
                })),
            };
        }

        async _fetchPreview(cands) {
            const url = this.apiBase + '/api/projects/' + this.projectId + '/kb-roles/import';
            try {
                const data = await _request(url, {
                    method: 'POST',
                    body: JSON.stringify({ candidates: cands, preview: true }),
                });
                this._showPreviewModal(cands, (data && data.imported) || []);
            } catch (e) {
                _toast('预览失败: ' + e.message, 'error');
            }
        }

        _showPreviewModal(cands, previewItems) {
            const overlay = _el('div', { style: 'position:fixed;inset:0;background:var(--bg-modal-overlay,rgba(0,0,0,.45));z-index:99990;display:flex;align-items:center;justify-content:center;' });
            const modal = _el('div', { style: 'background:var(--bg-card,#fff);border-radius:var(--radius-md,10px);width:680px;max-width:92vw;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 10px 30px rgba(0,0,0,.3);' });
            const header = _el('div', { style: 'padding:var(--sp-4,14px) var(--sp-5,18px);border-bottom:1px solid var(--border-color,#e5e7eb);display:flex;justify-content:space-between;align-items:center;' }, [
                _el('h3', { text: '预览导入角色', style: 'margin:0;font-size:var(--fs-h3,16px);' }),
                _el('button', { text: '×', style: 'border:none;background:none;font-size:var(--fs-h2,22px);cursor:pointer;color:var(--text-tertiary,#6b7280);', onclick: () => overlay.remove() }),
            ]);
            const bodyBox = _el('div', { style: 'padding:var(--sp-4,14px) var(--sp-5,18px);overflow-y:auto;' });

            previewItems.forEach((item, idx) => {
                const cand = cands[idx] || {};
                const card = _el('div', { style: 'border:1px solid var(--border-color,#e5e7eb);border-radius:var(--radius-md,8px);padding:var(--sp-3,12px);margin-bottom:var(--sp-3,12px);' });
                card.setAttribute('data-card-index', String(idx));
                // F9-T6 导入预览卡片头像：候选含 avatar 显示，否则色点占位
                const avaBox = _el('div', { style: 'display:flex;align-items:center;gap:var(--sp-2,8px);margin-bottom:var(--sp-2,8px);' });
                const avaImg = _el('img', {
                    style: 'width:40px;height:40px;border-radius:50%;object-fit:cover;border:1px solid var(--border-color,#e5e7eb);background:var(--bg-hover,#f1f5f9);flex:0 0 auto;' +
                        (cand.avatar ? '' : 'display:none;'),
                    src: cand.avatar || '',
                });
                const avaDot = _el('span', {
                    style: 'width:12px;height:12px;border-radius:50%;background:var(--text-tertiary,#94a3b8);flex:0 0 auto;' +
                        (cand.avatar ? 'display:none;' : ''),
                });
                avaBox.appendChild(avaImg);
                avaBox.appendChild(avaDot);
                card.appendChild(avaBox);
                const titleRow = _el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--sp-2,8px);' }, [
                    _el('strong', { text: item.name || cand.name || '未命名角色' }),
                    _el('span', { text: cand.entry_title || '', style: 'font-size:var(--fs-small,12px);color:var(--text-tertiary,#6b7280);' }),
                ]);
                card.appendChild(titleRow);
                // F9-T7 导入预览头像同步：匹配角色名更新候选头像（卡片脱离 DOM 后自解绑）
                const previewRoleName = item.name || cand.name || '';
                if (previewRoleName) {
                    const syncFn = function (ev) {
                        // 卡片已关闭/移除 → 自解绑
                        if (!card.isConnected) { window.removeEventListener('storyforge:role-avatar-updated', syncFn); return; }
                        const det = (ev && ev.detail) || {};
                        if (det.roleName === previewRoleName && det.avatarPath) {
                            avaImg.src = det.avatarPath;
                            avaImg.style.display = '';
                            avaDot.style.display = 'none';
                            cand.avatar = det.avatarPath;
                        }
                    };
                    window.addEventListener('storyforge:role-avatar-updated', syncFn);
                    card._avatarSyncFn = syncFn;
                }
                const fm = item.field_mapping || {};
                const fields = [
                    { key: 'identity', label: '身份', text: item.identity, map: fm.identity },
                    { key: 'personality', label: '性格', text: item.personality, map: fm.personality },
                    { key: 'background', label: '背景故事', text: item.background, map: fm.background },
                    { key: 'appearance', label: '外貌特征', text: item.appearance, map: fm.appearance },
                ];
                fields.forEach(f => {
                    const wrap = _el('div', { style: 'margin-bottom:var(--sp-2,6px);' });
                    wrap.appendChild(_el('div', { style: 'font-size:var(--fs-small,13px);color:var(--text-tertiary,#6b7280);margin-bottom:2px;' }, [
                        _el('span', { text: f.label }),
                        _el('span', { class: 'kbri-flags', style: 'margin-left:6px;' }),
                    ]));
                    // 字段可编辑（需求 3 自定义编辑）
                    const ta = _el('textarea', {
                        style: 'width:100%;min-height:34px;border:1px solid var(--border-color,#d1d5db);border-radius:var(--radius-sm,6px);padding:var(--sp-2,6px) var(--sp-2,8px);font-size:var(--fs-body,14px);font-family:inherit;',
                        rows: f.key === 'background' ? 2 : 1,
                    });
                    ta.value = f.text || '';
                    wrap.appendChild(ta);
                    // 标红标记（mapped=False 时）
                    if (f.map && !f.map.mapped) {
                        const reason = f.map.reason || '';
                        const label = reason === 'kb_no_appearance' ? '外貌无来源，待补' :
                            (reason === 'kb_missing' ? '知识库未提供' : '待补');
                        const flag = _el('span', { class: 'kbri-flag', text: label, style: 'margin-left:6px;' });
                        wrap.querySelector('.kbri-flags').appendChild(flag);
                    } else {
                        const flag = _el('span', { class: 'kbri-flag ok', text: '已映射', style: 'margin-left:6px;' });
                        wrap.querySelector('.kbri-flags').appendChild(flag);
                    }
                    wrap.dataset.fieldKey = f.key;
                    wrap.dataset.origValue = f.text || '';
                    wrap._textarea = ta;
                    card.appendChild(wrap);
                });

                // 人物关系（标红 target_missing）
                const rels = item.relations || [];
                if (rels.length) {
                    const relBox = _el('div', { style: 'margin-top:6px;' });
                    relBox.appendChild(_el('div', { style: 'font-size:var(--fs-small,13px);color:var(--text-tertiary,#6b7280);margin-bottom:var(--sp-1,4px);', text: '人物关系' }));
                    rels.forEach(r => {
                        const flag = r.mapped ? 'kbri-flag ok' : 'kbri-flag';
                        const label = r.mapped ? ('与 ' + r.target_name + ' · ' + r.relation_type) :
                            ('与 ' + r.target_name + ' · ' + r.relation_type + '（未关联）');
                        relBox.appendChild(_el('span', { class: flag, text: label, style: 'margin:2px 4px 2px 0;' }));
                    });
                    card.appendChild(relBox);
                }
                bodyBox.appendChild(card);
            });

            const foot = _el('div', { style: 'padding:var(--sp-3,12px) var(--sp-5,18px);border-top:1px solid var(--border-color,#e5e7eb);display:flex;justify-content:flex-end;gap:var(--sp-2,8px);' }, [
                _el('button', { class: 'kbri-btn', text: '取消', onclick: () => overlay.remove() }),
                _el('button', {
                    class: 'kbri-btn primary', text: '确认导入',
                    onclick: async () => {
                        // 从卡片收集编辑后的字段值（需求 3 自定义编辑）
                        const payloads = this._collectEdits(bodyBox, cands, previewItems);
                        try {
                            const res = await _request(this.apiBase + '/api/projects/' + this.projectId + '/kb-roles/import', {
                                method: 'POST',
                                body: JSON.stringify({ candidates: payloads, preview: false }),
                            });
                            overlay.remove();
                            this._showImportResult(res);
                            this.refreshCandidates();
                        } catch (e) {
                            _toast('导入失败: ' + e.message, 'error');
                        }
                    },
                }),
            ]);
            modal.appendChild(header);
            modal.appendChild(bodyBox);
            modal.appendChild(foot);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);
        }

        _collectEdits(bodyBox, cands, previewItems) {
            // 按卡片顺序收集 textarea 编辑值；卡片含 data-card-index
            const payloads = [];
            const cards = bodyBox.querySelectorAll('[data-card-index]');
            cards.forEach(cardEl => {
                const idx = parseInt(cardEl.getAttribute('data-card-index'), 10) || 0;
                const cand = cands[idx] || {};
                const fields = {};
                cardEl.querySelectorAll('[data-field-key]').forEach(wrapEl => {
                    const key = wrapEl.getAttribute('data-field-key');
                    const ta = wrapEl.querySelector('textarea');
                    fields[key] = ta ? ta.value : '';
                });
                payloads.push(Object.assign({}, cand, {
                    name: fields.name || cand.name,
                    identity: fields.identity || '',
                    personality: fields.personality || '',
                    background: fields.background || '',
                    appearance: fields.appearance || '',
                }));
            });
            return payloads;
        }

        // ---- 批量导入 ----
        async _batchImport() {
            const selectedCandidates = this.candidates.filter(c => this.selected.has(this._key(c)));
            const payloads = selectedCandidates.map(c => this._toPayload(c));
            if (!payloads.length) return;
            try {
                const res = await _request(this.apiBase + '/api/projects/' + this.projectId + '/kb-roles/import', {
                    method: 'POST',
                    body: JSON.stringify({ candidates: payloads, preview: false }),
                });
                this._showImportResult(res);
                this.refreshCandidates();
            } catch (e) {
                _toast('导入失败: ' + e.message, 'error');
            }
        }

        // ---- 结果反馈（需求 5） ----
        _showImportResult(res) {
            if (!res) return;
            const cls = res.failed === 0 ? 'ok' : (res.success > 0 ? 'partial' : 'error');
            const title = '导入完成：成功 ' + res.success + ' / ' + res.total;
            const box = _el('div', { class: 'kbri-result ' + cls });
            box.appendChild(_el('div', { text: title, style: 'font-weight:600;' }));
            if (res.failed_items && res.failed_items.length) {
                const ul = _el('ul', { class: 'kbri-fail' });
                res.failed_items.forEach(f => {
                    ul.appendChild(_el('li', { text: (f.name || '?') + '：' + (f.detail || f.reason || '未知原因') }));
                });
                box.appendChild(ul);
            }
            this._body.appendChild(box);
            _toast(title, cls === 'ok' ? 'success' : (cls === 'error' ? 'error' : 'warning'));
            setTimeout(() => box.remove(), 6000);
        }

        // ---- 生命周期 ----
        destroy() {
            if (this._root) this._root.remove();
            // 清理防抖定时器，避免 destroy 后触发异步渲染
            clearTimeout(this._debounceTimer);
            this._built = false;
        }
    }

    // ---------- 全局挂载 API（供角色管理界面/后续调用） ----------
    const factory = {
        /**
         * 挂载知识库角色导入面板。
         * @param {Object} opts
         * @param {string} opts.projectId 当前小说项目 ID（必填）
         * @param {HTMLElement} [opts.mountEl] 挂载容器（默认 body）
         * @param {string} [opts.apiBase] API 前缀（默认空，即相对路径）
         * @param {Function} [opts.onClose] 面板关闭回调
         * @returns {KBRoleImportPanel} 面板实例
         */
        mount(opts) {
            const panel = new KBRoleImportPanel(opts);
            panel.build();
            return panel;
        },
        /** 创建一个「从知识库导入」入口按钮，点击后挂载面板到指定容器。 */
        createButton(opts) {
            _ensureStyle();
            const btn = _el('button', {
                class: 'kbri-btn primary',
                text: '📥 从知识库导入',
                style: 'margin-left:8px;',
            });
            btn.addEventListener('click', () => {
                // 防重复挂载
                const existing = document.getElementById('kb-role-import-panel-' + (opts.projectId || 'x'));
                if (existing) { existing.scrollIntoView({ behavior: 'smooth' }); return; }
                const container = document.createElement('div');
                container.id = 'kb-role-import-panel-' + (opts.projectId || 'x');
                (opts.mountEl || document.body).appendChild(container);
                factory.mount(Object.assign({}, opts, {
                    mountEl: container,
                    onClose: () => { container.remove(); },
                }));
            });
            return btn;
        },
    };

    global.StoryForgeKBRoleImport = factory;
})(window);
