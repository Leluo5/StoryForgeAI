import { describe, expect, it } from 'vitest';
import { modelConfigV2Schema } from '@storyforge/contracts';
import { DEFAULT_MODEL_CONFIG, normalizeModelConfig } from './model-config';

describe('normalizeModelConfig（M4-T6 完整 LLM 参数）', () => {
  // 验收 1：范围校验
  it('temperature>2 拒绝', () => {
    expect(() => normalizeModelConfig({ temperature: 2.1 })).toThrow();
  });
  it('top_p>1 拒绝', () => {
    expect(() => normalizeModelConfig({ top_p: 1.1 })).toThrow();
  });
  it('max_tokens>32768 拒绝', () => {
    expect(() => normalizeModelConfig({ max_tokens: 40000 })).toThrow();
  });
  it('max_tokens<1 拒绝', () => {
    expect(() => normalizeModelConfig({ max_tokens: 0 })).toThrow();
  });
  it('stop>4 项拒绝', () => {
    expect(() => normalizeModelConfig({ stop: ['a', 'b', 'c', 'd', 'e'] })).toThrow();
  });
  it('frequency_penalty 越界拒绝（-2..2）', () => {
    expect(() => normalizeModelConfig({ frequency_penalty: 3 })).toThrow();
  });

  // 验收 2：类型校验
  it('max_tokens=boolean 拒绝（非整数）', () => {
    expect(() => normalizeModelConfig({ max_tokens: true })).toThrow();
  });
  it('stop 项 >64 字符拒绝', () => {
    expect(() => normalizeModelConfig({ stop: ['x'.repeat(65)] })).toThrow();
  });
  it('response_format 非法枚举拒绝', () => {
    expect(() => normalizeModelConfig({ response_format: 'xml' })).toThrow();
  });

  // 验收 3：默认合并（缺省字段自动补默认值）
  it('空对象补齐全部默认值', () => {
    const cfg = normalizeModelConfig({});
    expect(cfg).toEqual(DEFAULT_MODEL_CONFIG);
  });
  it('部分字段补齐其余默认', () => {
    const cfg = normalizeModelConfig({ temperature: 0.3, max_tokens: 4096 });
    expect(cfg.temperature).toBe(0.3);
    expect(cfg.max_tokens).toBe(4096);
    expect(cfg.top_p).toBe(1.0);
    expect(cfg.system_prompt).toBe('');
    expect(cfg.stream).toBe(false);
    expect(cfg.frequency_penalty).toBe(0);
    expect(cfg.presence_penalty).toBe(0);
    expect(cfg.response_format).toBe('text');
    expect(cfg.stop).toEqual([]);
  });

  // 验收 4：向后兼容（旧记录仅 {temperature, max_tokens} 可读，缺省补齐）
  it('旧记录仅 temperature/max_tokens 读出不报错并补齐', () => {
    const cfg = normalizeModelConfig({ temperature: 0.7, max_tokens: 2048 });
    expect(cfg.temperature).toBe(0.7);
    expect(cfg.max_tokens).toBe(2048);
    expect(cfg.top_p).toBe(1.0);
  });

  // 验收 5：完整写入后读取一致
  it('完整参数写入读取一致', () => {
    const full = {
      temperature: 0.5,
      top_p: 0.9,
      max_tokens: 8192,
      system_prompt: '你是助手',
      stream: true,
      frequency_penalty: 0.5,
      presence_penalty: -0.2,
      response_format: 'json',
      stop: ['\n', 'END']
    };
    expect(normalizeModelConfig(full)).toEqual(full);
  });

  // 验收 6：契约层 schema 导出且校验可用
  it('契约 modelConfigV2Schema 校验合法值', () => {
    const parsed = modelConfigV2Schema.parse({ temperature: 0.7 });
    expect(parsed.max_tokens).toBe(2048);
  });
  it('契约 schema 拒绝越界（strict 且 default）', () => {
    expect(() => modelConfigV2Schema.parse({ temperature: 5 })).toThrow();
  });
});
