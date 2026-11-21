import { z } from 'zod';
import type { CollabRoleField } from '@storyforge/contracts';
import { CollabUpstreamError } from './channel/collab-upstream.error';

// F11 结果校验器（F2 §5.3）：
// 上游必须返回单个 JSON 对象 { fields: { <field>: "<value>" }, notes?: string }。
// 校验顺序：1) 去围栏后解析；2) fields 键集合必须等于请求字段集合（禁止缺项/多项）；
// 3) 每个值必须为字符串；4) 空白/仅标点/超长值拒绝；5) 服务端不信任模型字段名，写回目标来自 DB 白名单。
// 任一步失败抛 COLLAB_INVALID_RESULT，任务失败不写回。

export const collabFieldLengthLimits: Record<CollabRoleField, number> = {
  identity: 80,
  personality: 2000,
  experience: 20000
};

// 上游结果：只接受 fields + notes，额外键（strict）拒绝
const resultSchema = z
  .object({
    fields: z.record(z.string(), z.unknown()),
    notes: z.string().max(2000).optional().default('')
  })
  .strict();

export interface ValidateResultInput {
  rawText: string;
  /** 服务端白名单/请求字段集合（权威） */
  expectedFields: CollabRoleField[];
  /** 字段长度上限（默认按 collabFieldLengthLimits） */
  limits?: Partial<Record<CollabRoleField, number>>;
}

export interface ValidatedResult {
  fields: Record<CollabRoleField, string>;
  notes: string;
}

/** 去除 ```json 围栏（若存在） */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline !== -1) {
      const body = trimmed.slice(firstNewline + 1);
      return body.replace(/```\s*$/, '').trim();
    }
  }
  return trimmed;
}

/** 仅标点（无字母/数字/汉字）视为无效 */
function isPunctuationOnly(value: string): boolean {
  return value.length > 0 && !/[\p{L}\p{N}]/u.test(value);
}

function invalid(message: string): CollabUpstreamError {
  return new CollabUpstreamError(message, false, 'COLLAB_INVALID_RESULT');
}

export function validateGeneratedResult(input: ValidateResultInput): ValidatedResult {
  const expected = new Set<string>(input.expectedFields);
  const limits = { ...collabFieldLengthLimits, ...input.limits };

  // 1) 去围栏后解析 JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(input.rawText));
  } catch {
    throw invalid('结果不是合法 JSON');
  }

  // strict 解析：结构非法（非对象、含额外键）抛 ZodError → 统一 invalid
  let data: z.infer<typeof resultSchema>;
  try {
    data = resultSchema.parse(parsed);
  } catch {
    throw invalid('结果结构非法（仅允许 fields 与 notes）');
  }

  // 2) 字段键集合必须等于请求字段集合
  const actualKeys = Object.keys(data.fields);
  const actual = new Set(actualKeys);
  if (actualKeys.length !== expected.size) {
    throw invalid('结果字段集合与请求不一致');
  }
  for (const key of actualKeys) {
    if (!expected.has(key)) {
      throw invalid(`结果包含未请求字段: ${key}`);
    }
  }
  for (const key of expected) {
    if (!actual.has(key)) {
      throw invalid(`结果缺少字段: ${key}`);
    }
  }

  // 3) 每个值必须为字符串
  const fields: Record<CollabRoleField, string> = {} as Record<CollabRoleField, string>;
  for (const key of expected) {
    const value = data.fields[key];
    if (typeof value !== 'string') {
      throw invalid(`字段 ${key} 值不是字符串`);
    }
    // 4) 空白/仅标点/超长值拒绝
    const trimmed = value.trim();
    if (trimmed === '') {
      throw invalid(`字段 ${key} 为空`);
    }
    if (isPunctuationOnly(trimmed)) {
      throw invalid(`字段 ${key} 仅包含标点`);
    }
    const limit = limits[key as CollabRoleField];
    if (limit !== undefined && value.length > limit) {
      throw invalid(`字段 ${key} 超长`);
    }
    fields[key as CollabRoleField] = value;
  }

  return { fields, notes: data.notes };
}
