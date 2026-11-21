import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { collabErrorMessage, COLLAB_FIELD_LABEL } from './collab-state';

// T20 前端状态与错误映射：409/422 错误码 → 可读中文提示

function makeApiError(code: string, status: number, message = 'x', details?: unknown): ApiError {
  return new ApiError(status, code, message, details, 'req-1');
}

describe('collabErrorMessage（409/422 可读提示映射）', () => {
  it('COLLAB_DISABLED → 协同未启用提示', () => {
    expect(collabErrorMessage(makeApiError('COLLAB_DISABLED', 409))).toBe('协同未启用，请先在运行配置中开启');
  });

  it('COLLAB_TEST_ROLE_MISMATCH → 角色提示', () => {
    expect(collabErrorMessage(makeApiError('COLLAB_TEST_ROLE_MISMATCH', 409))).toBe('角色不是配置的测试角色，无法发起协同');
  });

  it('COLLAB_CHANNEL_NOT_CONFIGURED → 通道提示', () => {
    expect(collabErrorMessage(makeApiError('COLLAB_CHANNEL_NOT_CONFIGURED', 409))).toBe('执行通道未就绪，请先在 Agent 配置中设置平台参数');
  });

  it('COLLAB_FIELD_NOT_ALLOWED（422 无 details）→ 通用白名单提示', () => {
    expect(collabErrorMessage(makeApiError('COLLAB_FIELD_NOT_ALLOWED', 422))).toBe('所选字段不在白名单内，请重新勾选');
  });

  it('COLLAB_FIELD_NOT_ALLOWED（422 含 fields）→ 列出具体字段', () => {
    const error = makeApiError('COLLAB_FIELD_NOT_ALLOWED', 422, 'x', { fields: ['experience', 'personality'] });
    expect(collabErrorMessage(error)).toBe('所选字段不在白名单内：经历与成长、性格特征');
  });

  it('COLLAB_FIELD_CONFLICT（409 字段冲突）→ 冲突提示', () => {
    expect(collabErrorMessage(makeApiError('COLLAB_FIELD_CONFLICT', 409))).toBe('该字段已被修改，请刷新后重试');
  });

  it('非 Collab 错误码 → 回退到服务端 message', () => {
    expect(collabErrorMessage(makeApiError('OTHER_CODE', 400, '上游不可用'))).toBe('上游不可用');
  });

  it('普通 Error → 返回 message', () => {
    expect(collabErrorMessage(new Error('网络错误'))).toBe('网络错误');
  });

  it('未知异常 → 兜底文案', () => {
    expect(collabErrorMessage('boom')).toBe('协同操作失败');
  });

  it('字段标签映射完整', () => {
    expect(COLLAB_FIELD_LABEL.identity).toBe('身份定位');
    expect(COLLAB_FIELD_LABEL.personality).toBe('性格特征');
    expect(COLLAB_FIELD_LABEL.experience).toBe('经历与成长');
  });
});
