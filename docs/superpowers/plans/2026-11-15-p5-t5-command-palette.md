# P5-T5b 命令面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增命令面板组件，承载工具/导航/角色/工具 Agent 四类命令，冷/热启动渲染 P95 < 100ms，角色与 Agent 切换无闪烁且状态可恢复。

**Architecture:** 新增 `static/js/tool_panel.js`（IIFE + `StoryForgeCommandPalette` 单例），静态命令清单保证首屏零网络；角色与 Agent 数据异步预取并按 `projectId` 缓存；`role_map_panel.js` 增加 `openRoleId`/`openDetail` 复用既有详情；`index.html` 挂载入口。后端零改动。

**Tech Stack:** 原生 JavaScript + CSS 变量、Flask 既有接口、Python unittest 前端不变量守卫、Chrome/Edge CDP 实测。

**设计依据:** `docs/superpowers/specs/2026-11-15-p5-t5-command-palette-design.md`

**分支:** `feat/p5-t5b-command-palette`（从 `main` 切出，完成后经用户确认回合 `main`）。

**通用命令（PowerShell，仓库根 `f:\workspace_trae\StoryForgeAI`）：**
- 单测：`& ".\.venv\Scripts\python.exe" -m pytest tests/test_command_palette.py -q`
- 全量：`& ".\.venv\Scripts\python.exe" -m pytest -q`
- 合规：`& ".\.venv\Scripts\python.exe" scripts/run_checks.py --path "f:\workspace_trae\StoryForgeAI"`
- 前端合规需 Node 18.20.8：`$env:Path = 'C:\Users\taurus\AppData\Local\Author Software\nvm\.nodejs;E:\Program Files\nvm\.shim;' + $env:Path`

---

### Task 1: 切分支并写前端不变量守卫（先失败）

**Files:**
- Create: `tests/test_command_palette.py`

- [ ] **Step 1: 切分支**

```powershell
git checkout -b feat/p5-t5b-command-palette
```

- [ ] **Step 2: 写守卫测试**

```python
# -*- coding: utf-8 -*-
"""P5-T5b 命令面板：前端不变量守卫。

真实渲染耗时、闪烁与状态同步需真实浏览器采样（见验收报告）；
此处以源码不变量兜底，防止「零网络首屏」「一次性提交」「快捷键」被回退。
"""

import os
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PANEL = os.path.join(BASE, "static", "js", "tool_panel.js")
ROLE_MAP = os.path.join(BASE, "static", "js", "role_map_panel.js")
INDEX = os.path.join(BASE, "templates", "index.html")

REGISTERED_TOOLS = [
    "gen_outline", "gen_chapter", "gen_character_image", "gen_world_map",
    "emotion_analysis", "consistency_check", "create_version", "gen_novel",
    "gen_audiobook", "run_70_workflow", "export_novel",
]
ROUTE_TOOLS = ["new_project", "open_project", "open_settings"]


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


class CommandPaletteInvariantTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = _read(PANEL)

    def test_component_is_iife_with_global(self):
        self.assertIn("(function (global) {", self.src)
        self.assertIn("global.StoryForgeCommandPalette = factory;", self.src)

    def test_all_registered_tools_present(self):
        for name in REGISTERED_TOOLS:
            self.assertIn("'" + name + "'", self.src, "缺少工具命令 %s" % name)

    def test_route_tools_present(self):
        for name in ROUTE_TOOLS:
            self.assertIn("'" + name + "'", self.src, "缺少路由命令 %s" % name)

    def test_shortcut_ctrl_cmd_k(self):
        self.assertIn("ctrlKey", self.src)
        self.assertIn("metaKey", self.src)
        self.assertIn("preventDefault()", self.src)
        self.assertIn("isComposing", self.src)

    def test_list_commit_is_atomic(self):
        self.assertIn("replaceChildren", self.src)
        self.assertNotIn(".innerHTML =", self.src)

    def test_agent_endpoints_and_active_filter(self):
        self.assertIn("/api/agents/tools", self.src)
        self.assertIn("/switch", self.src)
        self.assertIn("status === 'active'", self.src)

    def test_render_metric_exposed(self):
        self.assertIn("lastRenderMs", self.src)
        self.assertIn("getLastRenderMs", self.src)
        self.assertIn("performance.now()", self.src)

    def test_active_role_sync(self):
        self.assertIn("storyforge:active-role:", self.src)
        self.assertIn("storyforge:active-role-changed", self.src)
        self.assertIn("localStorage", self.src)

    def test_open_has_no_blocking_fetch(self):
        start = self.src.find("        open() {")
        self.assertGreater(start, -1, "未找到 open()")
        end = self.src.find("\n        close()", start)
        self.assertGreater(end, start, "未找到 close()")
        body = self.src[start:end]
        self.assertNotIn("await ", body, "open() 不得等待网络")
        self.assertIn("_prefetch()", body, "open() 应异步预取角色与 Agent")


class RoleMapOpenDetailInvariantTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = _read(ROLE_MAP)

    def test_factory_exposes_open_detail(self):
        self.assertIn("openDetail(opts)", self.src)

    def test_mount_supports_open_role_id(self):
        self.assertIn("this.openRoleId = opts.openRoleId || null;", self.src)
        self.assertIn("this._openRoleDetail(node)", self.src)


class IndexEntryInvariantTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = _read(INDEX)

    def test_entry_container_and_script(self):
        self.assertIn('id="command-palette-entry"', self.src)
        self.assertIn("/static/js/tool_panel.js", self.src)
        self.assertIn("StoryForgeCommandPalette.createButton", self.src)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: 运行确认失败**

Run: `& ".\.venv\Scripts\python.exe" -m pytest tests/test_command_palette.py -q`
Expected: FAIL（`FileNotFoundError: tool_panel.js`）。

- [ ] **Step 4: Commit**

```powershell
git add tests/test_command_palette.py
git commit -m "test(p5-t5b): 新增命令面板前端不变量守卫"
```

---

### Task 2: `role_map_panel.js` 支持 `openRoleId` 与 `openDetail`

**Files:**
- Modify: `static/js/role_map_panel.js:241-246`（构造函数）、`:386-393`（`loadGraph`）、`:1210-1225`（工厂）
- Test: `tests/test_command_palette.py::RoleMapOpenDetailInvariantTest`

- [ ] **Step 1: 构造函数接收 `openRoleId`**

在 `this.onNodeClick = opts.onNodeClick || null;` 之后追加：

```javascript
            this.openRoleId = opts.openRoleId || null; // P5-T5b：命令面板跳转详情
```

- [ ] **Step 2: `loadGraph()` 渲染后打开详情**

在 `this._renderGraph();` 之后、`await this._loadFilterOptions();` 之前插入：

```javascript
                // P5-T5b：命令面板「查看详情」直达，复用既有详情逻辑
                if (this.openRoleId) {
                    const targetId = this.openRoleId;
                    this.openRoleId = null;
                    const node = this._nodes.find(function (n) { return n.id === targetId; });
                    if (node) this._openRoleDetail(node);
                    else _toast('未找到角色: ' + targetId, 'warning');
                }
```

- [ ] **Step 3: 工厂新增 `openDetail`**

在 `factory` 的 `createButton` 之后追加：

```javascript
        openDetail(opts) {
            const options = Object.assign({}, opts, {
                mountEl: document.body,
                openRoleId: opts.roleId,
            });
            return factory.mount(options);
        },
```

- [ ] **Step 4: 运行守卫**

Run: `& ".\.venv\Scripts\python.exe" -m pytest tests/test_command_palette.py::RoleMapOpenDetailInvariantTest -q`
Expected: 2 passed。

- [ ] **Step 5: 回归既有版图守卫并提交**

Run: `& ".\.venv\Scripts\python.exe" -m pytest tests/test_role_map_detail_switch.py tests/test_role_map_perf.py -q`
Expected: 全 passed。

```powershell
git add static/js/role_map_panel.js
git commit -m "feat(p5-t5b): 版图面板支持openRoleId直达角色详情"
```

---

### Task 3: `tool_panel.js` 骨架、样式与开关（零网络首屏）

**Files:**
- Create: `static/js/tool_panel.js`

- [ ] **Step 1: 写入组件骨架**

```javascript
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

    // ---- 后续任务在此插入：状态、渲染、角色/Agent 命令、参数步骤 ----

    const factory = {
        createButton(opts) {
            const btn = _el('button', { class: 'cp-btn', text: '命令面板 (Ctrl+K)', onclick: function () { factory.toggle(); } });
            (opts.mountEl || document.body).appendChild(btn);
            return btn;
        },
    };
    global.StoryForgeCommandPalette = factory;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 2: 运行守卫确认部分通过**

Run: `& ".\.venv\Scripts\python.exe" -m pytest tests/test_command_palette.py -q`
Expected: `test_component_is_iife_with_global`、工具/路由命令、`test_list_commit_is_atomic` 通过；其余仍 FAIL。

- [ ] **Step 3: Commit**

```powershell
git add static/js/tool_panel.js
git commit -m "feat(p5-t5b): 新增命令面板骨架与静态命令清单"
```

---

### Task 4: 面板开关、快捷键与列表渲染（含渲染埋点）

**Files:**
- Modify: `static/js/tool_panel.js`（替换 `// ---- 后续任务在此插入 ----` 标记区，并在 `factory` 中补方法）

- [ ] **Step 1: 实现状态、`open/close/toggle` 与快捷键**

在标记区插入：

```javascript
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
```

在 `factory` 中补充：

```javascript
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
```

并在 IIFE 内注册一次快捷键（放在 `const factory = {` 之前）：

```javascript
    document.addEventListener('keydown', _onKeydown);
```

- [ ] **Step 2: 实现列表渲染与选中移动**

在标记区继续插入：

```javascript
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
```

- [ ] **Step 3: 补占位实现，保证语法完整（后续任务替换）**

```javascript
    function _roleItems() { return []; }
    function _agentItems() { return []; }
    function _syncChip() { state.chip.textContent = ''; }
    function _showList() { _renderList(); }
    function _runToolCommand(cmd) { if (cmd.route) { global.location.hash = cmd.route; factory.close(); } }
    function _runNavCommand(cmd) { factory.close(); }
```

- [ ] **Step 4: 运行守卫与合规**

Run: `& ".\.venv\Scripts\python.exe" -m pytest tests/test_command_palette.py -q`
Expected: 仅剩角色/Agent/结果相关 FAIL（`status === 'active'`、`/api/agents/tools`、`storyforge:active-role:` 等）。

Run: `& ".\.venv\Scripts\python.exe" scripts/run_checks.py --path "f:\workspace_trae\StoryForgeAI"`
Expected: 0 违规。

- [ ] **Step 5: Commit**

```powershell
git add static/js/tool_panel.js
git commit -m "feat(p5-t5b): 命令面板支持快捷键开关与原子列表渲染"
```

---

### Task 5: 角色命令（切换 + 详情 + 持久化）

**Files:**
- Modify: `static/js/tool_panel.js`

- [ ] **Step 1: 实现当前角色读写与同步事件**

用以下实现替换 `_syncChip` 占位，并新增存储函数：

```javascript
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

    function _syncChip() {
        const role = state.projectId ? getActiveRole(state.projectId) : null;
        state.chip.textContent = role ? ('当前角色：' + role.name) : '未选择角色';
    }
```

在 `factory` 中暴露：

```javascript
        getActiveRole: getActiveRole,
        setActiveRole: setActiveRole,
```

- [ ] **Step 2: 实现角色加载与命令生成**

替换 `_roleItems` 占位，并在 `_prefetch` 中调用 `_loadRoles()`：

```javascript
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
```

`_prefetch` 改为：

```javascript
    function _prefetch() {
        if (!state.projectId) return;
        _loadRoles();
        _loadAgents();
    }
```

并补 `_loadAgents` 占位：`async function _loadAgents() {}`（Task 6 替换）。

- [ ] **Step 3: 运行守卫**

Run: `& ".\.venv\Scripts\python.exe" -m pytest tests/test_command_palette.py -q`
Expected: `test_active_role_sync` 通过，仅剩 Agent 相关 FAIL。

- [ ] **Step 4: Commit**

```powershell
git add static/js/tool_panel.js
git commit -m "feat(p5-t5b): 命令面板支持角色切换与详情直达"
```

---

### Task 6: 工具 Agent 命令（默认项切换）

**Files:**
- Modify: `static/js/tool_panel.js`

- [ ] **Step 1: 实现 Agent 加载与命令生成**

替换 `_loadAgents` 占位与 `_agentItems` 占位：

```javascript
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
```

- [ ] **Step 2: 运行守卫与合规**

Run: `& ".\.venv\Scripts\python.exe" -m pytest tests/test_command_palette.py -q`
Expected: 全部通过（除 `test_open_has_no_blocking_fetch` 需确认 `open()` 无 `await`，本设计满足）。

Run: `& ".\.venv\Scripts\python.exe" scripts/run_checks.py --path "f:\workspace_trae\StoryForgeAI"`
Expected: 0 违规。

- [ ] **Step 3: Commit**

```powershell
git add static/js/tool_panel.js
git commit -m "feat(p5-t5b): 命令面板支持工具默认Agent切换"
```

---

### Task 7: 工具参数步骤与执行反馈

**Files:**
- Modify: `static/js/tool_panel.js`

- [ ] **Step 1: 实现参数步骤与工具执行**

替换 `_runToolCommand` 占位：

```javascript
    function _runToolCommand(cmd) {
        if (cmd.route) { global.location.hash = cmd.route; factory.close(); return; }
        if (!state.projectId) { _toast('请先进入作品', 'warning'); return; }
        _showParams(cmd);
    }

    function _showList() {
        if (state.form) { state.form.remove(); state.form = null; }
        state.list.style.display = '';
        state.input.value = '';
        _renderList();
        state.input.focus();
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
```

替换 `_runNavCommand` 占位：

```javascript
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
```

- [ ] **Step 2: 全量守卫 + 合规 + 回归**

Run: `& ".\.venv\Scripts\python.exe" -m pytest tests/test_command_palette.py tests/test_role_map_detail_switch.py -q`
Expected: 全 passed。

Run: `& ".\.venv\Scripts\python.exe" -m pytest -q`
Expected: 全 passed（748+）。

Run: `& ".\.venv\Scripts\python.exe" scripts/run_checks.py --path "f:\workspace_trae\StoryForgeAI"`
Expected: 0 违规。

- [ ] **Step 3: Commit**

```powershell
git add static/js/tool_panel.js
git commit -m "feat(p5-t5b): 命令面板支持工具参数填写与执行反馈"
```

---

### Task 8: `index.html` 入口挂载

**Files:**
- Modify: `templates/index.html:93`、`:449`、`:488-503`

- [ ] **Step 1: 加入口容器**

在 `<div id="role-map-entry" class="role-map-entry"></div>` 之后插入：

```html
        <!-- P5-T5b 命令面板入口容器 -->
        <div id="command-palette-entry" class="command-palette-entry"></div>
```

- [ ] **Step 2: 加载组件脚本**

在 `role_map_panel.js?v=12` 之后插入：

```html
    <!-- P5-T5b 命令面板组件（全局 StoryForgeCommandPalette） -->
    <script src="/static/js/tool_panel.js?v=1"></script>
```

- [ ] **Step 3: 挂载入口并随作品刷新**

在现有入口 IIFE 的 `mountRoleMapEntry()` 之后新增函数，并在 `DOMContentLoaded`、`hashchange`、`storyforge:work-loaded` 三处与 `mountRoleMapEntry()` 并列调用：

```javascript
            function mountCommandEntry() {
                const entry = document.getElementById('command-palette-entry');
                if (!entry || !window.StoryForgeCommandPalette) return;
                entry.replaceChildren();
                window.StoryForgeCommandPalette.createButton({ mountEl: entry });
            }
```

- [ ] **Step 4: 守卫 + 合规**

Run: `& ".\.venv\Scripts\python.exe" -m pytest tests/test_command_palette.py -q`
Expected: 全 passed。

Run: `& ".\.venv\Scripts\python.exe" scripts/run_checks.py --path "f:\workspace_trae\StoryForgeAI"`
Expected: 0 违规。

- [ ] **Step 5: Commit**

```powershell
git add templates/index.html
git commit -m "feat(p5-t5b): 作品页挂载命令面板入口"
```

---

### Task 9: 真实浏览器 CDP 验收

**Files:**
- Create（gitignored）: `scripts/cdp_tmp/p5t5_palette_perf.js`、`scripts/cdp_tmp/p5t5_palette_consistency.js`

- [ ] **Step 1: 准备基准作品**

复用既有 `scripts/cdp_tmp/seed_work.py` / `seed_perf.py`，准备含 100 角色的作品并进入 `#work/<workId>`；基准项目沿用 `p5t5work100`（若本地 `data/` 已清理则重新生成）。

- [ ] **Step 2: 性能测量**

复制 `scripts/cdp_tmp/p5t5_perf.js` 为 `p5t5_palette_perf.js`，将测量体替换为以下 `Runtime.evaluate` 片段：

```javascript
(async () => {
    const cp = window.StoryForgeCommandPalette;
    const out = { cold: [], warm: [] };
    for (let i = 0; i < 31; i++) {
        if (cp.isOpen()) cp.close();
        cp.open();
        const ms = cp.getLastRenderMs();
        if (i === 0) out.cold.push(ms); else out.warm.push(ms);
        await new Promise(r => setTimeout(r, 20));
    }
    cp.close();
    const p95 = a => a.slice().sort((x, y) => x - y)[Math.ceil(a.length * 0.95) - 1];
    return JSON.stringify({ coldP95: p95(out.cold), warmP95: p95(out.warm), samples: out });
})()
```

验收：冷/热 P95 均 < 100ms；Chrome 与 Edge 各执行一轮。

- [ ] **Step 3: 一致性与交互测量**

`p5t5_palette_consistency.js` 断言（每项均须为真）：

```javascript
// 1) 快捷键开合：dispatch ctrlKey+k 后 isOpen()===true，再次后为 false
// 2) 角色切换：执行某角色 run() 后 localStorage['storyforge:active-role:<pid>'] 含该 id，
//    且捕获到 storyforge:active-role-changed；重新 open() 后 chip 文案含角色名
// 3) Agent 切换：POST 后 GET /api/agents/tools 的 default_agent_id 等于目标 id
// 4) 交叉 30 轮：交替切换角色与 Agent，最终 localStorage 角色与后端默认 Agent 均与最后操作一致
// 5) 参数步骤：选择 export_novel → 填 format=txt → 执行 → 结果区含「执行成功」；
//    选择 gen_novel → 执行 → 结果区含「已排队」
// 6) 无作品上下文：hash='#home' 时 open()，工具项 disabled===true
// 7) 四档宽度(1920/1440/1024/375) × 双主题：document.documentElement.scrollWidth <= innerWidth
```

- [ ] **Step 4: 全量回归**

Run: `& ".\.venv\Scripts\python.exe" -m pytest -q`；`run_checks.py`。Expected: 全 passed / 0 违规。

- [ ] **Step 5: Commit 验收脚本（gitignored 不入库，仅记录结果）**

无需提交脚本；将测量原始数据写入验收报告。

---

### Task 10: 验收报告与路线图同步

**Files:**
- Create: `docs/04-测试与质量/P5-T5b命令面板验收报告.md`
- Modify: `docs/03-规划与路线/小说AI写作软件改造实施路线图.md`（§7.2 P5-T5 行与 §7.4 技术要点）

- [ ] **Step 1: 写验收报告**

内容：范围、环境（Chrome/Edge 版本）、性能采样表（冷/热 P50/P95/最大值）、交互与一致性断言结果、四档宽度 × 双主题结果、全量 pytest 与 `run_checks.py` 输出、遗留问题。

- [ ] **Step 2: 更新路线图**

§7.2 P5-T5 行标注「P5-T5a 已完成、P5-T5b 命令面板（含工具 Agent 切换）已完成」；§7.4「体验优化」要点补一行：命令面板 `tool_panel.js` 四类命令、零网络首屏、`openRoleId` 详情直达、角色持久化与事件同步。

- [ ] **Step 3: 提交**

```powershell
git add docs/04-测试与质量/P5-T5b命令面板验收报告.md docs/03-规划与路线/小说AI写作软件改造实施路线图.md
git commit -m "docs(p5-t5b): 生成命令面板验收报告并同步路线图"
```

- [ ] **Step 4: 请求用户确认回合 `main`**

向用户报告验收数据，经确认后：

```powershell
git checkout main
git merge --no-ff feat/p5-t5b-command-palette -m "feat(p5-t5b): 合入命令面板体验优化"
```

推送远程需用户另行确认。

---

## Self-Review 记录

- 规格覆盖：§3.1~§3.4 命令 → Task 3/5/6；§4 交互 → Task 4/7；§5.2 版图改动 → Task 2；§5.3 入口 → Task 8；§6 状态同步 → Task 5/6；§7 性能口径 → Task 4 埋点 + Task 9 实测；§8 错误边界 → Task 5/6/7；§10.1 守卫 → Task 1；§10.4 验收 → Task 9/10。
- 占位说明：Task 4 的 `_roleItems/_agentItems/_loadAgents` 是显式占位实现，分别在 Task 5/6 用完整实现替换；`_prefetch` 在 Task 4 为空、Task 5 补全。
- 类型一致：`state.lastRenderMs` ↔ `getLastRenderMs()`；`getActiveRole/setActiveRole` 签名在 Task 5 定义、Task 7 复用；`_defaultAgentLabel` 在 Task 6 定义、Task 7 使用。
