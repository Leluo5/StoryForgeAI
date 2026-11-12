// static/js/knowledge_panel.js —— 知识库 Markdown 导入导出前端组件（F5-T15）
// 交付：独立可挂载面板组件，导出全局对象 StoryForgeKnowledgeMarkdownIO。
// 能力：
//   - 导出模块：单条 / 批量 / 分类（按 type）三种范围，单条直接下载 .md，批量/分类打包 ZIP 下载
//   - 导入模块：多文件选择 → 预览（标题/格式统计/冲突标记）→ 目标 type + 冲突策略 → 结果统计
//   - 进度反馈：大文件导入导出进度条，界面不阻塞（async/await + 非阻塞渲染）
// 用法：
//   StoryForgeKnowledgeMarkdownIO.mount({ apiBase, onClose });
//   StoryForgeKnowledgeMarkdownIO.createButton({ mountEl, apiBase });
// 组件自带轻量请求/反馈，不依赖 app.js IIFE 内部符号（对齐 novel_editor.js 同构模式）。

(function (global) {
    'use strict';

    // ---------- 轻量请求（复用后端 {code,data,message} 契约） ----------
    // options.responseType === 'blob' 时返回 Blob（用于文件流/ZIP），否则解析 JSON data。
    async function _request(url, options) {
        const opts = options || {};
        const isBlob = opts.responseType === 'blob';
        const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
        const fetchOpts = Object.assign({}, opts);
        delete fetchOpts.responseType;
        const resp = await fetch(url, { ...fetchOpts, headers });
        if (isBlob) {
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            return await resp.blob();
        }
        let body = null;
        try { body = await resp.json(); } catch (e) { /* 非 JSON（如文件流） */ }
        if (!resp.ok) {
            const msg = (body && (body.message || body.error)) || ('HTTP ' + resp.status);
            throw new Error(msg);
        }
        if (body && typeof body.code === 'number' && body.code !== 0) {
            throw new Error(body.message || ('业务错误 ' + body.code));
        }
        return body ? body.data : null;
    }

    // ---------- 轻量 toast（自带容器，避免依赖 app.js showToast） ----------
    function _ensureToast() {
        let box = document.getElementById('kbmio-toast-box');
        if (!box) {
            box = document.createElement('div');
            box.id = 'kbmio-toast-box';
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

    // ---------- 文件读取（FileReader → base64 data URL） ----------
    function _readAsDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('读取文件失败: ' + file.name));
            reader.readAsDataURL(file);
        });
    }

    // ---------- 触发浏览器下载（Blob / URL） ----------
    function _download(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
    }

    const STYLE_ID = 'kbmio-panel-style';
    function _ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
        .kbmio-panel{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f2937;background:#fff;
            border:1px solid #e5e7eb;border-radius:8px;}
        .kbmio-header{display:flex;align-items:center;justify-content:space-between;gap:12px;
            padding:12px 16px;border-bottom:1px solid #e5e7eb;background:#f9fafb;border-radius:8px 8px 0 0;}
        .kbmio-header h3{margin:0;font-size:16px;font-weight:600;}
        .kbmio-tabs{display:flex;gap:4px;border-bottom:1px solid #e5e7eb;padding:0 12px;}
        .kbmio-tab{padding:8px 14px;font-size:14px;cursor:pointer;border:none;background:none;
            color:#6b7280;border-bottom:2px solid transparent;}
        .kbmio-tab.active{color:#2563eb;border-bottom-color:#2563eb;font-weight:600;}
        .kbmio-body{padding:14px 16px;}
        .kbmio-field{margin-bottom:12px;}
        .kbmio-label{display:block;font-size:13px;color:#4b5563;margin-bottom:4px;font-weight:500;}
        .kbmio-select,.kbmio-input{width:100%;padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;}
        .kbmio-btn{padding:7px 14px;border-radius:6px;font-size:14px;cursor:pointer;
            border:1px solid #d1d5db;background:#fff;color:#374151;}
        .kbmio-btn:hover{background:#f3f4f6;}
        .kbmio-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff;}
        .kbmio-btn.primary:hover{background:#1d4ed8;}
        .kbmio-btn:disabled{opacity:.5;cursor:not-allowed;}
        .kbmio-btn-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
        .kbmio-hint{font-size:12px;color:#9ca3af;margin-top:4px;}
        .kbmio-list{max-height:300px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:6px;margin-top:8px;}
        .kbmio-item{display:flex;align-items:flex-start;gap:8px;padding:8px 12px;border-bottom:1px solid #f3f4f6;font-size:14px;}
        .kbmio-item:last-child{border-bottom:none;}
        .kbmio-item-head{flex:1;}
        .kbmio-item-title{font-weight:600;}
        .kbmio-item-meta{font-size:12px;color:#6b7280;margin-top:2px;}
        .kbmio-tag{display:inline-block;padding:1px 6px;border-radius:4px;font-size:12px;margin-right:4px;}
        .kbmio-tag.warn{background:#fef3c7;color:#92400e;}
        .kbmio-tag.ok{background:#d1fae5;color:#065f46;}
        .kbmio-tag.err{background:#fee2e2;color:#b91c1c;}
        .kbmio-empty{padding:24px;text-align:center;color:#9ca3af;font-size:14px;}
        .kbmio-progress{margin:10px 0;}
        .kbmio-progress-bar{height:8px;border-radius:4px;background:#e5e7eb;overflow:hidden;}
        .kbmio-progress-fill{height:100%;width:0;background:#2563eb;transition:width .2s;}
        .kbmio-progress-text{font-size:12px;color:#6b7280;margin-top:4px;text-align:center;}
        .kbmio-result{padding:10px 14px;font-size:14px;border-radius:6px;margin-top:12px;}
        .kbmio-result.ok{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0;}
        .kbmio-result.partial{background:#fffbeb;color:#92400e;border:1px solid #fde68a;}
        .kbmio-result.error{background:#fef2f2;color:#991b1b;border:1px solid #fecaca;}
        .kbmio-fail{font-size:13px;color:#6b7280;margin-top:6px;max-height:120px;overflow-y:auto;}
        .kbmio-fail li{list-style:none;margin:2px 0;}
        .kbmio-foot{padding:12px 16px;border-top:1px solid #e5e7eb;background:#f9fafb;border-radius:0 0 8px 8px;
            display:flex;justify-content:space-between;align-items:center;}
        `;
        document.head.appendChild(style);
    }

    // ---------- 主组件 ----------
    class KnowledgeMarkdownIOPanel {
        constructor(opts) {
            this.mountEl = opts.mountEl || document.body;
            this.apiBase = opts.apiBase || '';
            this.onClose = opts.onClose || null;
            this.tab = 'export';
            // 导出状态
            this.entries = [];          // 条目列表（批量选择用）
            this.selectedIds = new Set();
            // 导入状态
            this.previewFiles = [];     // [{file_name, content(数据URL|纯文本)}]
            this.previewItems = [];     // 后端预览结果
            this._built = false;
        }

        build() {
            _ensureStyle();
            if (!this._built) {
                this._root = _el('div', { class: 'kbmio-panel' });
                this.mountEl.appendChild(this._root);
                this._built = true;
            }
            this._renderShell();
            return this._root;
        }

        destroy() {
            if (this._root) this._root.remove();
            this._built = false;
        }

        // ---------- 壳：标题 + 标签页 ----------
        _renderShell() {
            this._root.innerHTML = _escapeHtml('');
            const header = _el('div', { class: 'kbmio-header' }, [
                _el('h3', { text: 'Markdown 导入导出' }),
                _el('button', { class: 'kbmio-btn', text: '关闭', onclick: () => { if (this.onClose) this.onClose(); } }),
            ]);
            const tabs = _el('div', { class: 'kbmio-tabs' }, [
                _el('button', { class: 'kbmio-tab' + (this.tab === 'export' ? ' active' : ''), text: '导出', onclick: () => this._switchTab('export') }),
                _el('button', { class: 'kbmio-tab' + (this.tab === 'import' ? ' active' : ''), text: '导入', onclick: () => this._switchTab('import') }),
            ]);
            this._root.appendChild(header);
            this._root.appendChild(tabs);
            this._body = _el('div', { class: 'kbmio-body' });
            this._root.appendChild(this._body);
            this._renderBody();
        }

        _switchTab(tab) {
            this.tab = tab;
            this._renderShell();
            if (tab === 'export') this.refreshEntries();
        }

        _renderBody() {
            this._body.innerHTML = _escapeHtml('');
            if (this.tab === 'export') this._renderExport();
            else this._renderImport();
        }

        // ============================================================
        // 导出模块
        // ============================================================
        _renderExport() {
            // 范围选择
            const scopeSel = _el('select', { class: 'kbmio-select', onchange: (e) => this._onScopeChange(e.target.value) });
            ['single', 'batch', 'category'].forEach(s => {
                const map = { single: '单条文档', batch: '批量文档', category: '按分类' };
                scopeSel.appendChild(_el('option', { value: s, text: map[s] }));
            });
            scopeSel.value = this.scope || 'single';
            this._scope = scopeSel.value;

            const typeSel = _el('select', { class: 'kbmio-select', style: 'display:none;', onchange: () => {} });
            ['article', 'paper', 'novel', 'inspiration'].forEach(t => {
                typeSel.appendChild(_el('option', { value: t, text: t }));
            });

            const scopeField = _el('div', { class: 'kbmio-field' }, [
                _el('label', { class: 'kbmio-label', text: '导出范围' }),
                scopeSel,
            ]);
            this._typeSel = typeSel;
            this._scopeSel = scopeSel;

            // 条目选择区（batch 显示；single 显示条目下拉；category 显示 type 下拉）
            const picker = _el('div', { class: 'kbmio-field', id: 'kbmio-picker' });
            this._picker = picker;

            this._body.appendChild(scopeField);
            this._body.appendChild(typeSel);
            this._body.appendChild(picker);

            const foot = _el('div', { class: 'kbmio-foot' }, [
                _el('span', { text: '' }),
                _el('button', { class: 'kbmio-btn primary', text: '导出', onclick: () => this._doExport() }),
            ]);
            this._body.appendChild(foot);

            this._renderPicker();
            this.refreshEntries();
        }

        _onScopeChange(scope) {
            this.scope = scope;
            this._renderPicker();
        }

        _renderPicker() {
            this._picker.innerHTML = _escapeHtml('');
            const scope = this.scope || 'single';
            if (scope === 'single') {
                const sel = _el('select', { class: 'kbmio-select', onchange: (e) => { this._singleId = e.target.value; } });
                sel.appendChild(_el('option', { value: '', text: '请选择条目…' }));
                this.entries.forEach(en => sel.appendChild(_el('option', { value: en.id, text: en.title })));
                this._singleId = this.entries[0] ? this.entries[0].id : '';
                this._picker.appendChild(_el('label', { class: 'kbmio-label', text: '选择文档' }));
                this._picker.appendChild(sel);
            } else if (scope === 'batch') {
                const box = _el('div', { class: 'kbmio-list' });
                if (!this.entries.length) {
                    box.appendChild(_el('div', { class: 'kbmio-empty', text: '暂无条目' }));
                }
                this.entries.forEach(en => {
                    const cb = _el('input', { type: 'checkbox' });
                    cb.checked = this.selectedIds.has(en.id);
                    cb.addEventListener('change', () => {
                        if (cb.checked) this.selectedIds.add(en.id); else this.selectedIds.delete(en.id);
                    });
                    box.appendChild(_el('div', { class: 'kbmio-item' }, [
                        cb,
                        _el('div', { class: 'kbmio-item-head' }, [
                            _el('div', { class: 'kbmio-item-title', text: en.title }),
                            _el('div', { class: 'kbmio-item-meta', text: en.type + ' · ' + (en.created_at || '') }),
                        ]),
                    ]));
                });
                this._picker.appendChild(_el('label', { class: 'kbmio-label', text: '勾选多条文档' }));
                this._picker.appendChild(box);
                this._picker.appendChild(_el('div', { class: 'kbmio-hint', text: '已选 ' + this.selectedIds.size + ' 条' }));
            } else if (scope === 'category') {
                const sel = this._typeSel;
                sel.style.display = '';
                this._picker.appendChild(_el('label', { class: 'kbmio-label', text: '按类型导出全部内容' }));
                this._picker.appendChild(sel);
            }
        }

        async refreshEntries() {
            try {
                const data = await _request(this.apiBase + '/api/knowledge/entries?page_size=200');
                this.entries = (data && data.items) || [];
                // 清理已不存在的选中
                const valid = new Set(this.entries.map(en => en.id));
                this.selectedIds = new Set([...this.selectedIds].filter(id => valid.has(id)));
                this._renderPicker();
            } catch (e) {
                _toast('加载条目失败: ' + e.message, 'error');
            }
        }

        async _doExport() {
            const scope = this.scope || 'single';
            const body = { scope: scope };
            if (scope === 'single') {
                if (!this._singleId) { _toast('请先选择文档', 'warning'); return; }
                body.entry_ids = [this._singleId];
            } else if (scope === 'batch') {
                if (!this.selectedIds.size) { _toast('请先勾选文档', 'warning'); return; }
                body.entry_ids = [...this.selectedIds];
            } else if (scope === 'category') {
                body.type = this._typeSel ? this._typeSel.value : 'article';
            }
            // 单条直接下载 .md；批量/分类打包 ZIP
            try {
                if (scope === 'single') {
                    this._showProgress('正在导出…', 30);
                    const data = await _request(this.apiBase + '/api/knowledge/markdown/export', {
                        method: 'POST', body: JSON.stringify(body),
                    });
                    this._showProgress('导出完成', 100);
                    _download(new Blob([data.content], { type: 'text/markdown;charset=utf-8' }), data.file_name);
                    _toast('已导出: ' + data.file_name, 'success');
                } else {
                    this._showProgress('正在打包导出…', 30);
                    const blob = await _request(this.apiBase + '/api/knowledge/markdown/export', {
                        method: 'POST', body: JSON.stringify({ ...body, as_zip: true }), responseType: 'blob',
                    });
                    this._showProgress('打包完成', 100);
                    // 文件名：批量 → knowledge_export_<ts>.zip
                    const fname = 'knowledge_export_' + _tsStamp() + '.zip';
                    _download(blob, fname);
                    _toast('已导出 ZIP: ' + fname, 'success');
                }
            } catch (e) {
                this._showResult({ type: 'error', text: '导出失败: ' + e.message });
            } finally {
                setTimeout(() => this._hideProgress(), 1500);
            }
        }

        // ============================================================
        // 导入模块
        // ============================================================
        _renderImport() {
            const fileInput = _el('input', { type: 'file', multiple: true, accept: '.md,.markdown' });
            fileInput.addEventListener('change', (e) => this._onFilesSelected(e.target.files));

            const typeSel = _el('select', { class: 'kbmio-select' });
            ['article', 'paper', 'novel', 'inspiration'].forEach(t => typeSel.appendChild(_el('option', { value: t, text: t })));

            const strategySel = _el('select', { class: 'kbmio-select' });
            [
                { v: 'rename', t: '重命名（新建副本）' },
                { v: 'overwrite', t: '覆盖（更新已有）' },
                { v: 'skip', t: '跳过（不处理）' },
            ].forEach(s => strategySel.appendChild(_el('option', { value: s.v, text: s.t })));

            const fileField = _el('div', { class: 'kbmio-field' }, [
                _el('label', { class: 'kbmio-label', text: '选择 Markdown 文件（可多选）' }),
                fileInput,
                _el('div', { class: 'kbmio-hint', text: '支持 .md / .markdown，UTF-8 / GBK 编码自动识别' }),
            ]);

            this._importTypeSel = typeSel;
            this._importStrategySel = strategySel;

            this._body.appendChild(fileField);

            // 预览区
            this._previewBox = _el('div', { class: 'kbmio-field' });
            this._body.appendChild(this._previewBox);

            // 导入设置（预览后启用）
            const settings = _el('div', { class: 'kbmio-field', style: 'display:none;', id: 'kbmio-import-settings' }, [
                _el('div', { class: 'kbmio-field' }, [
                    _el('label', { class: 'kbmio-label', text: '目标知识库位置（类型）' }),
                    typeSel,
                ]),
                _el('div', { class: 'kbmio-field' }, [
                    _el('label', { class: 'kbmio-label', text: '同名冲突处理' }),
                    strategySel,
                ]),
            ]);
            this._settings = settings;
            this._body.appendChild(settings);

            const foot = _el('div', { class: 'kbmio-foot' }, [
                _el('span', { text: '' }),
                _el('button', { class: 'kbmio-btn primary', text: '开始导入', disabled: true, onclick: () => this._doImport() }),
            ]);
            this._importBtn = foot.querySelector('.kbmio-btn.primary');
            this._body.appendChild(foot);
        }

        async _onFilesSelected(fileList) {
            const files = Array.from(fileList || []);
            if (!files.length) return;
            this._showProgress('正在读取文件…', 10);
            try {
                const items = [];
                for (let i = 0; i < files.length; i++) {
                    const content = await _readAsDataURL(files[i]);
                    items.push({ file_name: files[i].name, content: content });
                    this._showProgress('读取文件 ' + (i + 1) + ' / ' + files.length, Math.round((i + 1) / files.length * 40));
                }
                this.previewFiles = items;
                await this._doPreview();
            } catch (e) {
                this._showResult({ type: 'error', text: '读取文件失败: ' + e.message });
            } finally {
                this._hideProgress();
            }
        }

        async _doPreview() {
            this._showProgress('正在校验格式…', 50);
            try {
                const data = await _request(this.apiBase + '/api/knowledge/markdown/import/preview', {
                    method: 'POST', body: JSON.stringify({ files: this.previewFiles }),
                });
                this.previewItems = (data && data.items) || [];
                this._showProgress('校验完成', 100);
                this._renderPreview();
            } catch (e) {
                this._showResult({ type: 'error', text: '预览失败: ' + e.message });
            } finally {
                this._hideProgress();
            }
        }

        _renderPreview() {
            const box = this._previewBox;
            box.innerHTML = _escapeHtml('');
            const validCount = this.previewItems.filter(it => it.valid).length;
            box.appendChild(_el('label', { class: 'kbmio-label', text: '导入预览（有效 ' + validCount + ' / ' + this.previewItems.length + '）' }));

            const list = _el('div', { class: 'kbmio-list' });
            if (!this.previewItems.length) {
                list.appendChild(_el('div', { class: 'kbmio-empty', text: '无文件可预览' }));
            }
            this.previewItems.forEach(it => {
                const tag = it.valid
                    ? _el('span', { class: 'kbmio-tag ok', text: '有效' })
                    : _el('span', { class: 'kbmio-tag err', text: (it.reason || '无效') });
                const stats = it.format_stats || {};
                const metaText = (it.title || '未命名') + ' · ' +
                    '标题' + (stats.headings || 0) + ' 代码块' + (stats.code_blocks || 0) +
                    ' 图片' + (stats.images || 0) + ' 列表' + (stats.lists || 0) + ' 表格' + (stats.tables || 0);
                list.appendChild(_el('div', { class: 'kbmio-item' }, [
                    tag,
                    _el('div', { class: 'kbmio-item-head' }, [
                        _el('div', { class: 'kbmio-item-title', text: it.file_name || '文件' }),
                        _el('div', { class: 'kbmio-item-meta', text: metaText }),
                        (it.conflict ? _el('div', { class: 'kbmio-item-meta', text: '⚠ 冲突: ' + (it.conflict.reason || '同名') }) : null),
                    ]),
                ]));
            });
            box.appendChild(list);

            // 启用导入按钮（有有效项才可导入）
            if (this._importBtn) this._importBtn.disabled = validCount === 0;
            if (this._settings) this._settings.style.display = validCount ? '' : 'none';
        }

        async _doImport() {
            const validItems = this.previewItems.filter(it => it.valid);
            if (!validItems.length) { _toast('没有可导入的有效文件', 'warning'); return; }
            this._showProgress('正在导入…', 60);
            try {
                const data = await _request(this.apiBase + '/api/knowledge/markdown/import', {
                    method: 'POST', body: JSON.stringify({
                        files: this.previewFiles,
                        target_type: this._importTypeSel ? this._importTypeSel.value : 'article',
                        conflict_strategy: this._importStrategySel ? this._importStrategySel.value : 'rename',
                    }),
                });
                this._showProgress('导入完成', 100);
                this._renderImportResult(data);
            } catch (e) {
                this._showResult({ type: 'error', text: '导入失败: ' + e.message });
            } finally {
                setTimeout(() => this._hideProgress(), 1500);
            }
        }

        _renderImportResult(data) {
            const total = data.total || 0, success = data.success || 0, failed = data.failed || 0;
            const type = failed ? (success ? 'partial' : 'error') : 'ok';
            let text = '导入完成：共 ' + total + ' 条，成功 ' + success + ' 条，失败 ' + failed + ' 条。';
            if (data.created) text += ' 新建 ' + data.created.length + ' 条。';
            if (data.updated) text += ' 更新 ' + data.updated.length + ' 条。';
            if (data.skipped) text += ' 跳过 ' + data.skipped.length + ' 条。';
            this._showResult({ type: type, text: text, detail: data.failed_items || [] });
        }

        // ---------- 进度 / 结果反馈 ----------
        _showProgress(text, pct) {
            let bar = this._body.querySelector('.kbmio-progress');
            if (!bar) {
                bar = _el('div', { class: 'kbmio-progress' }, [
                    _el('div', { class: 'kbmio-progress-bar' }, [this._progressFill = _el('div', { class: 'kbmio-progress-fill' })]),
                    this._progressText = _el('div', { class: 'kbmio-progress-text' }),
                ]);
                this._body.appendChild(bar);
            }
            this._progressFill.style.width = (pct || 0) + '%';
            this._progressText.textContent = text || '';
        }

        _hideProgress() {
            const bar = this._body.querySelector('.kbmio-progress');
            if (bar) bar.remove();
        }

        _showResult(result) {
            const box = _el('div', { class: 'kbmio-result ' + result.type }, [result.text]);
            if (result.detail && result.detail.length) {
                const ul = _el('ul', { class: 'kbmio-fail' });
                result.detail.slice(0, 50).forEach(f => ul.appendChild(_el('li', { text: '· ' + (f.file_name || f.id || '') + ': ' + (f.reason || f.message || '') })));
                box.appendChild(ul);
            }
            // 结果区固定位置：附加到 body 底部
            this._body.appendChild(box);
            // 自动清理旧结果
            const old = this._body.querySelectorAll('.kbmio-result');
            if (old.length > 3) old[0].remove();
        }
    }

    // ---------- 工具 ----------
    function _tsStamp() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }

    // ---------- 全局挂载 API ----------
    const factory = {
        /**
         * 挂载 Markdown 导入导出面板。
         * @param {Object} opts
         * @param {HTMLElement} [opts.mountEl] 挂载容器（默认 body）
         * @param {string} [opts.apiBase] API 前缀（默认空，即相对路径）
         * @param {Function} [opts.onClose] 面板关闭回调
         * @returns {KnowledgeMarkdownIOPanel} 面板实例
         */
        mount(opts) {
            const panel = new KnowledgeMarkdownIOPanel(opts);
            panel.build();
            return panel;
        },
        /** 创建「Markdown 导入导出」入口按钮，点击后挂载面板到指定容器。 */
        createButton(opts) {
            _ensureStyle();
            const btn = _el('button', { class: 'kbmio-btn primary', text: '📥 Markdown 导入导出', style: 'margin-left:8px;' });
            btn.addEventListener('click', () => {
                const container = document.createElement('div');
                container.style.margin = '12px 0';
                (opts.mountEl || document.body).appendChild(container);
                factory.mount(Object.assign({}, opts, {
                    mountEl: container,
                    onClose: () => { container.remove(); },
                }));
            });
            return btn;
        },
    };

    global.StoryForgeKnowledgeMarkdownIO = factory;
})(window);
