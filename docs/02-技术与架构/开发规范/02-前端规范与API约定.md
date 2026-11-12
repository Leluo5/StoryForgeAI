# 前端规范与 API 约定

> 版本：v1.1 · 状态：生效（2026-11-12）
> 适用范围：前端（static/js/、static/css/、templates/）
> 维护：02-技术与架构｜关联：[文档中心](../README.md)、[分册索引](./README.md)
> 所属：[《开发规范》分册索引](./README.md)｜第 2 / 5 篇
> 上一篇：[01 · 基础约定与后端规范](./01-基础约定与后端规范.md)｜下一篇：[03 · Git 与文档规范](./03-Git与文档规范.md)

---

## 一、技术形态说明

StoryForgeAI 前端为 **原生 JavaScript + CSS + HTML**（无构建链、无 TypeScript、无框架）。所有规范基于该形态，不得引入需要构建步骤的依赖（见 [05-依赖与模块规范](./05-依赖与模块规范.md)）。

---

## 二、JavaScript 规范

### 2.1 编码风格

| 规则 | 正确示例 | 错误示例 |
|------|---------|---------|
| 声明 | `const` / `let`（禁 `var`） | `var x = 1` |
| 命名（函数/变量） | `camelCase`：`renderWorkList()` | `render_work_list`、`RenderWorkList` |
| 命名（类/构造器） | `PascalCase`：`KnowledgeStorePanel` | `knowledgeStorePanel` |
| 命名（常量） | `UPPER_SNAKE_CASE`：`API_BASE` | `apiBase` |
| 字符串 | 单引号 `'`（或统一模板串） | 混用 |
| 分号 | 每语句末尾加分号 | 省略 |
| 缩进 | 2 空格（禁 Tab） | 4 空格 |
| 相等比较 | `===` / `!==`（禁 `==`） | `if (a == b)` |
| 严格模式 | 文件顶部 `'use strict';` | 缺失 |

### 2.2 DOM 与安全

- **禁止 `innerHTML` 直接拼接用户/外部数据**（XSS 风险）。必须用 `textContent` 赋值，或经 `DOMParser`/转义函数。
- 动态节点：用 `document.createElement` + `textContent`。
- 事件绑定：`addEventListener`，禁止内联 `onclick="..."`。
- 避免 `eval` / `new Function` / `document.write`。

```javascript
// ✅ 推荐：安全渲染
const li = document.createElement('li');
li.textContent = item.title;  // 不解析 HTML
listEl.appendChild(li);

// ❌ 禁止：XSS 风险
listEl.innerHTML = item.title;
```

### 2.3 状态管理

- 全局状态收敛到单一入口（如 `window.AppState` 或模块内 state 对象），禁止散落全局变量。
- 跨组件共享状态通过**事件/回调**传递，禁止直接改对方 DOM。
- 状态变更后统一调用 `render()`，避免多处手动改 DOM 造成不一致。

---

## 三、API 封装约定

### 3.1 统一请求封装

前端统一走 `fetch` 封装（如 `apiRequest(path, options)`），禁止散落裸 `fetch`：

| 约定 | 说明 |
|------|------|
| 方法 | `GET` / `POST` / `PUT` / `DELETE` |
| 请求头 | `Content-Type: application/json`（body 为对象时） |
| 响应解析 | 统一解包 `{code, data, message}`；`code !== 0` 视为业务失败 |
| 错误处理 | 网络异常/HTTP 非 2xx 统一抛 `ApiError`；UI 层 `showToast(message)` |
| 超时 | 用 `AbortController` 设置超时（默认 10s，大文件可延长） |
| 取消 | 页面卸载/重复请求时 `abort()` 避免竞态 |

```javascript
// ✅ 推荐：统一封装
async function apiRequest(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (json.code !== 0) throw new ApiError(json.message, json.code);
  return json.data;
}
```

### 3.2 路径约定

- 前端 API 路径一律以 `/api/` 开头，与后端蓝图 `url_prefix` 一致（如 `/api/knowledge/...`）。
- 不得硬编码完整后端地址（除开发代理配置）；用相对路径或 `API_BASE` 常量。

### 3.3 SSE 消费

- 使用 `EventSource` 或 `fetch` + `ReadableStream` 消费流式接口（见 [01-基础约定与后端规范](./01-基础约定与后端规范.md#35-sse-流式接口约定)）。
- 必须监听 `error`/`close` 事件，断线重连策略由组件决定。
- 收到 `done` 事件后关闭连接并清理状态。

---

## 四、CSS 规范

| 规则 | 正确示例 | 错误示例 |
|------|---------|---------|
| 类命名 | BEM 风格 `block__element--modifier` | `style1`、`.red` |
| ID 选择器 | 仅限单例布局，不用于样式复用 | 频繁用 `#id` 选择器 |
| 单位 | 优先 `px`（固定）/ `rem`（响应式） | 混杂无规则 |
| 颜色 | 统一用 CSS 变量（`:root` 定义） | 散落十六进制字面量 |
| 布局 | 优先 flex/grid | 滥用 float |
| 层级 | 用 `z-index` 分级（0/10/100/1000） | 随意设大数 |

### 4.1 CSS 变量定义（:root）

```css
:root {
  --color-primary: #4f8cff;
  --color-danger: #e5484d;
  --radius-md: 8px;
  --spacing-md: 16px;
}
```

---

## 五、HTML / 模板规范

- 语义化标签优先（`<button>`、`<section>`、`<nav>`），避免滥用 `<div>`。
- 表单控件必须带 `label`（`for` 关联）或 `aria-label`。
- 所有交互元素需有 `type`（`type="button"` 防止误提交）。
- 页面模板统一由 `templates/` 下 Jinja2 渲染，动态内容由 JS 挂载到 `id` 容器。
- 避免内联样式（`style="..."`），用 class + CSS 文件。

---

## 六、模块化前端组件约定

> 【来源】参照 `knowledge_panel.js` 的 `StoryForgeKnowledgeMarkdownIO`（IIFE + `mount`/`createButton`）模式。

| 约定 | 说明 |
|------|------|
| 封装 | 每个功能组件用一个 **IIFE** 包裹，挂到 `window`（如 `window.StoryForgeKnowledgeMarkdownIO`），避免污染全局 |
| 暴露接口 | `mount({ apiBase, onClose })` / `createButton({ mountEl, apiBase })` |
| 依赖 | 组件不直接 `fetch`，统一走 `apiRequest` 封装；`apiBase` 由调用方注入 |
| 生命周期 | `mount` 创建 DOM 并绑定事件；`onClose` 回调清理监听器 |
| 样式 | 组件样式写入对应 CSS 文件，类名带组件前缀（如 `kb-mdio-*`） |
| 事件 | 内部事件不冒泡到全局，避免影响其他组件 |
