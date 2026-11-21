import type { CollabRoleField } from '@storyforge/contracts';
import { ApiError } from '../api/client';

// F11 多平台 Agent 协同 · 前端状态与错误映射（T20）
// 409/422 等接口错误码 → 可操作的中文提示；字段标签供写回/撤销复用。

export const COLLAB_FIELD_LABEL: Record<CollabRoleField, string> = {
  identity: '身份定位',
  personality: '性格特征',
  experience: '经历与成长'
};

const ERROR_LABEL: Record<string, string> = {
  COLLAB_DISABLED: '协同未启用，请先在运行配置中开启',
  COLLAB_TEST_ROLE_MISMATCH: '角色不是配置的测试角色，无法发起协同',
  COLLAB_FIELD_NOT_ALLOWED: '所选字段不在白名单内，请重新勾选',
  COLLAB_CHANNEL_NOT_CONFIGURED: '执行通道未就绪，请先在 Agent 配置中设置平台参数',
  COLLAB_NO_CITATION: '未检索到有效引用，任务已失败',
  COLLAB_UPSTREAM_TIMEOUT: '上游执行超时，请稍后重试',
  COLLAB_UPSTREAM_FAILED: '上游执行失败，请查看任务详情',
  COLLAB_INVALID_RESULT: '生成结果结构非法，任务已失败',
  COLLAB_FIELD_CONFLICT: '该字段已被修改，请刷新后重试'
};

/**
 * 把接口错误翻译成可操作的中文提示。
 * 409/422 返回明确原因，不创建任务；其余回退到服务端 message。
 */
export function collabErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    // 422 字段白名单：优先附具体字段名
    if (cause.status === 422 && cause.code === 'COLLAB_FIELD_NOT_ALLOWED') {
      const details = cause.details as { fields?: string[] } | undefined;
      if (details?.fields?.length) {
        const names = details.fields.map((field) => COLLAB_FIELD_LABEL[field as CollabRoleField] ?? field);
        return `所选字段不在白名单内：${names.join('、')}`;
      }
    }
    const mapped = ERROR_LABEL[cause.code];
    if (mapped) return mapped;
    return cause.message || '协同操作失败';
  }
  if (cause instanceof Error && cause.message) return cause.message;
  return '协同操作失败';
}

/** 把任意异常规范化为字符串（供 setError/loadError 使用） */
export function collabErrorText(cause: unknown): string {
  return collabErrorMessage(cause);
}
