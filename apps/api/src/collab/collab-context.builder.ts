import type { CollabCitation } from '@storyforge/contracts';

// F11 上下文构建器（F2 §7.2 上下文最小化）：
// 发送给外部模型的内容仅包括：任务指令、目标角色名、本次请求字段的当前值与引用摘录。
// 禁止发送：其他角色资料、章节正文、剧情树、完整知识库、作者信息、会话令牌、其他任务结果。
// 本构建器集中处理字段裁剪，单测断言白名单，防止后续扩散。

// 角色上下文来源：服务端从 DB 读取后传入（字段值已由上层按白名单初步过滤，此处再兜底裁剪）
export interface CharacterContextSource {
  name: string;
  /** 角色资料字段（key → 当前值）。构建器只允许透出白名单内的键 */
  fields: Record<string, unknown>;
}

export interface BuildRoleContextInput {
  instruction: string;
  character: CharacterContextSource;
  /** 本次任务请求的字段集合（服务端已校验在白名单内） */
  outputFields: string[];
  /** 检索引用摘录（来源、标题、摘录），仅透出这三项 */
  citations: Array<Pick<CollabCitation, 'source_id' | 'title' | 'snippet'>>;
}

export interface RoleProfileContext {
  instruction: string;
  character: {
    name: string;
    fields: Record<string, unknown>;
  };
  citations: Array<{ source_id: string; title: string; snippet: string }>;
}

/** 构建发送给外部模型的上下文：仅白名单字段 + 指令 + 角色名 + 引用摘录 */
export function buildRoleContext(input: BuildRoleContextInput): RoleProfileContext {
  const allowed = new Set(input.outputFields);
  // 只透出白名单键，禁止其他角色资料泄漏
  const fields: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(input.character.fields, key)) {
      fields[key] = input.character.fields[key];
    }
  }

  return {
    instruction: input.instruction,
    character: {
      name: input.character.name,
      fields
    },
    citations: input.citations.map((c) => ({
      source_id: c.source_id,
      title: c.title,
      snippet: c.snippet
    }))
  };
}
