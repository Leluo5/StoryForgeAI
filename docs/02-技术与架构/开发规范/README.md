# StoryForgeAI · 开发规范 · 分册索引

> 版本：v1.1 · 状态：生效（2026-11-12）
> 适用范围：StoryForgeAI 全体研发与 AI 协作（后端 app.py/modules/、前端 static/、数据 data/、测试 tests/）
> 维护：02-技术与架构｜关联：[文档中心](../../README.md)
> 说明：本目录由原合订文档《StoryForgeAI 开发规范》按逻辑章节拆分而成（原文 208 行）；原文完整归档至 [docs-archive/预拆分-2026-11-12/02-技术与架构/开发规范.md](../../../docs-archive/预拆分-2026-11-12/02-技术与架构/开发规范.md)。

---

## 篇章导航

| # | 篇章 | 内容概要 | 原文章节 |
| --- | --- | --- | --- |
| 01 | [基础约定与后端规范](./01-基础约定与后端规范.md) | 规则分级、目录文件、Python/Flask、函数设计、错误处理、路由/SSE | 原 L11–L74 |
| 02 | [前端规范与API约定](./02-前端规范与API约定.md) | 原生 JS/CSS/HTML、状态管理、API 封装、模块前端组件约定 | 原 L76–L120 |
| 03 | [Git 与文档规范](./03-Git与文档规范.md) | 分支模型、Conventional Commits、提交前检查、AI 协作、文档同步 | 原 L122–L205 |
| 04 | [安全与数据规范](./04-安全与数据规范.md) | 统一错误码、安全硬约束、JSON 存储与文件锁、敏感字段过滤 | 原 L41–L53、L170–L182 |
| 05 | [依赖与模块规范](./05-依赖与模块规范.md) | 依赖版本、模块拆分、数据契约、测试规范 | 原 L15–L16、新增 |

## 阅读路径

- **顺序阅读**：按上表编号依次阅读，可获得原合订本的完整上下文。
- **按需跳读**：每个分册开头均提供上一篇 / 下一篇导航，可直接跳转到相邻主题。
- **回溯原文**：如需核对拆分前版本，请访问上方归档链接。

## 适用范围

- **后端**：`app.py` + `config_loader.py` + `coze_client.py` + `work_manager.py` + `modules/`（含 knowledge_base、novel_creation）。
- **前端**：`static/js/app.js` + `static/js/knowledge_panel.js` + `static/js/novel_editor.js` + `static/css/*.css` + `templates/index.html`。
- **数据**：`data/`（global_config.json、works/、knowledge/、projects/）。
- **测试**：`tests/`（pytest / unittest）。
