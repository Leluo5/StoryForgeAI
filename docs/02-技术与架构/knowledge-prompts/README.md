# knowledge-prompts

知识库类型判定与结构化拆分的 **TypeScript 提示词常量**，与产品文档 v2.0 对齐。

## 文件

| 文件 | 说明 |
|------|------|
| `types.ts` | 类型枚举、`CHARACTER_P0_FIELDS` |
| `typeDetection.ts` | 类型判定 system prompt + `buildTypeDetectionUserPrompt` |
| `structuredPrompts.ts` | 十一类结构化拆分 prompt + 组装函数 |
| `index.ts` | 统一导出 |

## 使用示例

```ts
import {
  TYPE_DETECTION_SYSTEM_PROMPT,
  buildTypeDetectionUserPrompt,
  getStructuredSystemPrompt,
  buildStructuredUserPrompt,
  type KnowledgeEntryType,
} from './knowledge-prompts';

// 1) 判定类型
const detectUser = buildTypeDetectionUserPrompt(title, rawContent);
// messages: [{ role: 'system', content: TYPE_DETECTION_SYSTEM_PROMPT }, { role: 'user', content: detectUser }]

// 2) 按类型结构化
const type: KnowledgeEntryType = 'character';
const system = getStructuredSystemPrompt(type);
const user = buildStructuredUserPrompt(type, title, rawContent);
```

## 文档同源

- `01-产品与设计/知识库提示词Few-shot增强版.md`（v2.0）
- `01-产品与设计/知识库提示词判定与拆分示例.md`（v2.0，已同步）

修改提示词时请 **同时更新文档与本目录常量**，避免漂移。
