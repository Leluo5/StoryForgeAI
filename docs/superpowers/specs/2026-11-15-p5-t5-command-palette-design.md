# P5-T5b 命令面板体验优化设计（Command Palette）

> 版本：v1.0 · 状态：待评审（2026-11-15）
> 项目：StoryForgeAI
> 类型：设计规格（Spec）
> 关联：[实施路线图 §7.2/§7.4](../../03-规划与路线/小说AI写作软件改造实施路线图.md)、[前端规范与 API 约定](../../02-技术与架构/开发规范/02-前端规范与API约定.md)、[智能体管理模块设计](./2026-11-15-agent-management-design.md)、[P5-T5a 版图角色详情体验设计](./2026-11-14-p5-t5-role-detail-experience-design.md)
> 范围：新增前端命令面板组件 `static/js/tool_panel.js`，承载工具、导航、角色、工具 Agent 四类命令；后端零新增接口。

---

## 一、背景与目标

### 1.1 背景

- 路线图 §7.2 P5-T5「体验优化」剩余目标：**命令面板渲染 < 100ms**、**角色切换无闪烁与状态同步**（P5-T5a 已完成版图角色详情切换优化）。
- 路线图 §6.4 规划的 `static/js/tool_panel.js` 至今不存在，`templates/index.html` 未加载；`novel_editor.js` 仅是知识库角色导入占位，不是命令面板。
- `main` 已合入 agent-management（`1e7ffed`~`a449d79`）：作品创建时自动开通 11 个流程 Agent 与每工具默认 Agent；`invoke_tool` 通过 `tool_agent_resolver` 自动把默认 Agent 注入 `context["tool_agent"]`；`GET /api/agents/tools` 与 `POST /api/agents/tools/<tool>/switch` 已可用。原「同作品多 Agent 切换」因此并入本设计，不再单独立项。

### 1.2 目标

1. 提供统一命令面板，一个入口完成「调用写作工具、跳转创作面板、切换当前角色、切换工具默认 Agent」。
2. 面板打开渲染 P95 < 100ms（冷/热启动各 30 次，不含网络）。
3. 角色与 Agent 切换无闪烁、状态可同步、刷新后可恢复。
4. 不新增后端接口，不破坏既有面板与合规检查。

### 1.3 需求决策（澄清结论）

| 决策点 | 结论 |
| --- | --- |
| 承载内容 | 工具 + 导航 + 角色 + 工具 Agent 四类命令 |
| 唤起方式 | 顶部按钮 + `Ctrl+K` / `Cmd+K` 双入口，共用同一面板 |
| 角色命令语义 | 既要「设为当前角色」，也要「查看详情」 |
| 工具执行方式 | 选中后先在面板内填参数，再调用 |
| 实现路径 | 独立组件 `tool_panel.js`，静态命令清单零网络首屏 |
| 性能口径 | 冷/热启动各 30 次，本地渲染 P95 < 100ms，不含角色/Agent 网络耗时 |

---

## 二、非目标

- 不提供 Agent 的新建/编辑/删除/归档/分组管理界面（与 agent-management「本期不提供前端管理界面」一致）。
- 不实现 11 步流程进度 UI、不改动 11 步流程定义与工具处理器业务逻辑。
- 不重写剧情树、角色版图、知识库导入等既有面板；命令面板只做调用与跳转。
- 不引入构建链、框架、npm 依赖或拼音搜索；不改动后端任何路由。

---

## 三、命令模型

命令统一结构：

```text
{ id, title, subtitle, category, keywords[], requiresProject, params[], run }
```

- `category`：`tool` / `nav` / `role` / `agent`。
- `requiresProject`：无作品上下文时置灰。
- `params`：参数步骤字段声明（见 §3.2），仅 `tool` 与部分 `agent` 命令使用。
- `run`：执行函数，返回 Promise；结果统一由面板结果区/toast 呈现。

### 3.1 工具命令（14 项，静态清单）

11 项走 `POST /api/projects/<project_id>/tools/<tool>`，body `{ params, role_id }`；`role_id` 仅在已选当前角色时携带。

| 命令 id | 标题 | role_link | long_task | 参数字段 |
| --- | --- | --- | --- | --- |
| `gen_outline` | 生成大纲 | 是 | 否 | `theme`（text，可选，主题/题材） |
| `gen_chapter` | 生成章节 | 是 | 否 | `chapter_title`（text，可选） |
| `gen_character_image` | 生成角色形象 | 是 | 否 | 无字段，**必须已选当前角色** |
| `gen_world_map` | 生成世界地图 | 否 | 否 | `style`（text，可选） |
| `emotion_analysis` | 情感分析 | 是 | 否 | `text`（text，可选，待分析文本） |
| `consistency_check` | 一致性检查 | 是 | 否 | `chapter_id`（text，可选） |
| `create_version` | 创建版本 | 否 | 否 | `version_name`（text，可选） |
| `gen_novel` | 生成长篇小说 | 是 | 是 | `title`（text，可选） |
| `gen_audiobook` | 生成有声书 | 否 | 是 | `voice`（text，可选，音色） |
| `run_70_workflow` | 运行 70 步工作流 | 是 | 是 | `start_step`（text，可选，起始步骤） |
| `export_novel` | 导出小说 | 否 | 否 | `format`（select：`markdown`/`txt`，默认 `markdown`） |

3 项映射既有专用入口（无参数步骤，选中即跳转）：

| 命令 id | 标题 | 目标 |
| --- | --- | --- |
| `new_project` | 新建作品/项目 | `location.hash = '#home'`（作品列表，含新建入口） |
| `open_project` | 打开作品 | `location.hash = '#home'` |
| `open_settings` | 打开设置 | `location.hash = '#admin'` |

> 说明：`new_project` 与 `open_project` 目标相同、文案与关键词不同；新建动作由作品列表页既有表单完成，面板不重复实现。

### 3.2 导航命令（3 项，静态清单）

| 命令 id | 标题 | 行为 |
| --- | --- | --- |
| `nav_plot_tree` | 剧情树 | 复用 `mountPlotEntry` 同模式挂载 `StoryForgePlotPanel` |
| `nav_role_map` | 角色版图 | 挂载 `StoryForgeRoleMap` |
| `nav_kb_import` | 知识库角色导入 | 触发既有 `#kb-import-entry` 内按钮 click |

### 3.3 角色命令（动态）

- 数据源：`GET /api/role-map/graph?project_id=<id>`，取 `nodes` 的 `id/name`。
- 每个角色一行，行内两个操作：「设为当前角色」与「查看详情」。
- 「设为当前角色」：更新顶栏当前角色 chip → 写 `localStorage` → 派发 `storyforge:active-role-changed`。
- 「查看详情」：关闭面板后调用 `StoryForgeRoleMap.openDetail({ projectId, roleId, apiBase })`。

### 3.4 工具 Agent 命令（动态）

- 数据源：`GET /api/agents/tools?project_id=<id>`，返回 `[{ tool_name, agents, default_agent_id }]`。
- 每个候选 Agent 一条命令：`title = "<工具名> / <Agent 名>"`，`subtitle` 显示平台与状态；当前默认项标注「当前默认」。
- 仅 `status === 'active'` 可执行；其余置灰并标注原因。
- 执行：`POST /api/agents/tools/<tool_name>/switch`，body `{ project_id, agent_id }`；成功后更新本地缓存中的 `default_agent_id` 并 toast「已切换：<工具> → <Agent>」。

---

## 四、交互设计

### 4.1 唤起与关闭

- 入口按钮：`#command-palette-entry` 挂载「命令面板」按钮，文案带 `Ctrl+K` 提示。
- 快捷键：`keydown` 监听 `(ctrlKey || metaKey) && key.toLowerCase() === 'k'`，`preventDefault()` 后 `toggle()`；`event.isComposing` 时忽略，避免中文输入法误触。
- 关闭：`Esc`、点击遮罩、执行跳转类命令后自动关闭；关闭后焦点回到唤起前元素。

### 4.2 列表与键盘

- 顶部搜索框自动聚焦；输入即按 `title + subtitle + keywords + category` 过滤（不防抖，命令量级小）。
- 结果按分类分组渲染，组标题为「工具 / 导航 / 角色 / 工具 Agent」；默认选中首项。
- `↑/↓` 移动选中项并滚动到可视区；`Enter` 执行；角色行内「详情」按钮可 `Tab` 聚焦后 `Enter` 触发。
- 空结果显示「无匹配命令」。

### 4.3 工具参数步骤

- 选中工具后面板原地切到参数步骤：工具名、描述、默认 Agent 只读行、当前角色只读行、参数表单、「执行」「返回」按钮。
- 默认 Agent 只读行：来自 `/api/agents/tools` 缓存，显示 `默认 Agent：<name>（<platform>）`；无候选时显示「未配置默认 Agent」。
- 当前角色只读行：`role_link` 工具显示 `将以角色 <name> 调用`；未选角色时显示「未选择角色」。`gen_character_image` 未选角色时禁用执行并提示先选择角色。
- `Enter` 或点击「执行」提交；执行中禁用重复提交；`Esc` 在参数步骤先返回列表，再次 `Esc` 才关闭面板。

### 4.4 结果反馈

- 同步工具：结果区展示 `执行成功` + 结果摘要（`JSON.stringify` 截断 500 字）。
- 长任务：结果区展示 `已排队，task_id=<id>`。
- 失败：结果区展示后端 `message`；网络异常展示 `请求失败：<message>`。
- Agent 切换、角色切换用轻量 toast，不打断列表。

### 4.5 无作品上下文

- 未进入作品或作品未绑定项目时，`requiresProject` 的工具、角色、Agent、导航命令置灰，点击提示「请先进入作品」。
- `new_project` / `open_project` / `open_settings` 始终可用。

---

## 五、组件架构与改动面

### 5.1 新增 `static/js/tool_panel.js`

- 结构对齐 `role_map_panel.js`：IIFE + `'use strict'`，内部 `_request` / `_toast` / `_el` / `_escapeHtml` / `_ensureStyle`，导出 `window.StoryForgeCommandPalette`。
- 导出 API：
  - `createButton({ mountEl })` → 挂载入口按钮，返回按钮元素；
  - `open()` / `close()` / `toggle()`；
  - `isOpen()`；
  - `getActiveRole(projectId)` → `{ id, name } | null`；
  - `setActiveRole(projectId, role)` → 供外部同步当前角色；
  - `getLastRenderMs()` → 最近一次 `open()` 的本地渲染耗时（验收测量用）。
- 单例：全页仅一个面板根节点 `.cp-panel`；重复 `open()` 复用 DOM。
- 项目上下文：每次 `open()` 经 `window.StoryForgeApp.getCurrentProjectId()` 动态读取，不缓存旧值。
- 样式：`_ensureStyle()` 注入一次，`cp-` 前缀，全部使用既有 CSS 变量（`--bg-card`、`--text-primary`、`--accent` 等），天然兼容双主题。

### 5.2 改动 `static/js/role_map_panel.js`（约 15 行）

- `mount(opts)` 支持 `openRoleId`：`loadGraph()` 在 `_renderGraph()` 之后，若 `this.openRoleId` 存在，则按 id 在 `this._nodes` 中找节点并调用既有 `_openRoleDetail(node)`，随后清空 `openRoleId`；找不到时 toast「未找到角色」且不影响版图。
- 工厂新增 `openDetail({ projectId, roleId, roleName, apiBase })`：`mount({ ..., mountEl: document.body, openRoleId: roleId })`，不复制详情逻辑。

### 5.3 改动 `templates/index.html`

- 在 `#role-map-entry`（第 93 行）之后新增 `<div id="command-palette-entry" class="command-palette-entry"></div>`。
- 在 `role_map_panel.js` 之后加载 `tool_panel.js?v=1`。
- 新增 `mountCommandEntry()` 小脚本：复用 `mountPlotEntry` 模式，在 `hashchange`、`storyforge:work-loaded` 与初始加载时刷新入口。

---

## 六、状态同步与缓存

| 状态 | 存储/来源 | 同步方式 |
| --- | --- | --- |
| 当前角色 | `localStorage["storyforge:active-role:<projectId>"] = { id, name }` | 写入后派发 `storyforge:active-role-changed`；进入作品自动恢复 |
| 工具默认 Agent | 后端为准，前端缓存 `/api/agents/tools` 响应 | 切换成功后更新缓存；面板打开时若缓存失效则重取 |
| 角色列表 | 前端缓存 `/api/role-map/graph` 的 `nodes` | 按 `projectId` 缓存；项目切换失效 |
| 面板开关 | 组件内 `_open` | `open()`/`close()`/`toggle()` 统一入口 |

- 预取：`open()` 完成首屏渲染后异步拉取角色与 Agent 数据；失败仅在对应分组显示「加载失败，点击重试」。
- 项目切换（`storyforge:work-loaded` 或 `getCurrentProjectId()` 变化）使缓存失效并重新预取。
- 所有列表更新用 `replaceChildren` 一次性提交；不先清空再异步填充，避免闪烁（沿用 P5-T5a 结论）。

---

## 七、性能设计与测量口径

- 首屏零网络：工具/导航命令为静态清单，样式随组件注入；`open()` 内不发起请求。
- 首次 `open()` 构建骨架 + 渲染静态命令；后续 `open()` 仅切换显示并刷新列表。
- 列表构建用 `DocumentFragment` 一次性插入；不为每条命令注册独立全局监听（事件委托到列表容器）。
- 埋点：`open()` 开始记录 `t0 = performance.now()`，到面板可见且首项 `aria-selected="true"` 记录 `lastRenderMs = performance.now() - t0`。
- 验收口径：冷启动（首次 `open()`）与热启动（再次 `open()`）各 30 次，分别取 P95，均 < 100ms；不含角色/Agent 网络耗时；Chrome 与 Edge 各测一轮。

---

## 八、错误与边界

| 场景 | 行为 |
| --- | --- |
| 无 `projectId` | 相关命令置灰，点击提示「请先进入作品」 |
| 角色/Agent 预取失败 | 分组内显示「加载失败，点击重试」，不影响其它命令 |
| 工具返回 404/400/业务错误 | 结果区展示 `message`，面板保持打开 |
| 长任务 | 结果区展示 `task_id` + `queued`，不轮询 |
| 执行中重复提交 | 执行按钮禁用，忽略重复 `Enter` |
| `openDetail` 找不到角色 | toast「未找到角色」，版图正常打开 |
| 输入法组合中 | 忽略 `Ctrl+K` 与 `Enter` 快捷键 |

## 九、安全与合规

- 不使用 `innerHTML` 拼接数据；动态文本一律 `textContent`（`_el` 的 `html` 分支仅经 `_escapeHtml`）。
- 所有按钮显式 `type="button"`；不新增裸 `fetch`（统一 `_request`）；不写 `console.log`；不使用内联事件属性。
- `localStorage` 仅保存角色 id/name，不存任何凭据；Agent 数据不含敏感字段（后端已过滤）。

---

## 十、测试与验收

### 10.1 前端不变量守卫（新增 `tests/test_command_palette.py`）

1. 组件文件存在、IIFE 包裹、导出 `StoryForgeCommandPalette`。
2. 11 个注册工具 id 全部出现在静态清单，且 3 个 route 命令 id 存在。
3. 快捷键监听包含 `ctrlKey`、`metaKey`、`preventDefault`、`isComposing`。
4. 列表更新使用 `replaceChildren`，无 `innerHTML =` 赋值。
5. `/api/agents/tools` 与 `/switch` 路径常量存在；`active` 状态过滤存在。
6. `getLastRenderMs`、`storyforge:active-role-changed`、`localStorage` 键前缀存在。
7. `role_map_panel.js` 工厂含 `openDetail`，且支持 `openRoleId`。
8. `index.html` 含 `#command-palette-entry` 且加载 `tool_panel.js`。

### 10.2 真实浏览器 CDP 验证（脚本放 `scripts/cdp_tmp/`，gitignored）

- 冷/热启动各 30 次渲染耗时，P95 < 100ms（Chrome、Edge）。
- 快捷键开合、焦点回归、`Esc` 在参数步骤先返回列表。
- 100 角色数据下过滤与「设为当前角色 / 查看详情」两操作。
- 工具 Agent 切换后 `GET /api/agents/tools` 默认项变更且面板同步；切换前后工具调用均成功。
- 角色切换与 Agent 切换交叉 30 轮，无状态错位、无空白帧。
- 四档宽度 × 双主题无横向溢出。
- 工具参数提交：同步结果、长任务排队、失败信息三类反馈各至少一例。

### 10.3 回归

- 全量 `pytest -q` 通过；`scripts/run_checks.py` 0 违规。

### 10.4 验收标准

| 指标 | 目标 |
| --- | --- |
| 命令面板渲染 | 冷/热各 30 次 P95 < 100ms（不含网络） |
| 工具命令 | 14 项可检索；11 项可带参数调用，3 项正确跳转 |
| 角色命令 | 设为当前角色 + 查看详情均可用；刷新后当前角色恢复 |
| 工具 Agent 命令 | 可切换默认 Agent，切换后工具调用使用新默认 |
| 状态一致性 | 交叉切换 30 轮无错位、无闪烁 |
| 合规 | `run_checks.py` 0 违规，全量 pytest 通过 |

---

## 十一、交付物与文档同步

- 代码：`static/js/tool_panel.js`（新增）、`static/js/role_map_panel.js`、`templates/index.html`。
- 测试：`tests/test_command_palette.py`（新增）、CDP 验证脚本（gitignored）。
- 文档：本设计、实施计划（`docs/superpowers/plans/`）、验收报告、路线图 §7.4 登记「P5-T5b 命令面板（含工具 Agent 切换）」。
