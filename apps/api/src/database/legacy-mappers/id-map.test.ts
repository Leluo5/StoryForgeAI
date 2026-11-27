import { describe, expect, it } from 'vitest';
import { isUuid, uuidFromHash } from './id-map';

// M4-T11 id-map 纯函数单测（无 DB 依赖）
describe('id-map 纯函数', () => {
  it('isUuid 识别合法 UUID', () => {
    expect(isUuid('31601c93-f2f5-4b0d-9cd8-5f8a0ee6de1d')).toBe(true);
    expect(isUuid('a350c26d-6bda-484f-b019-e088b9fc0aec')).toBe(true);
  });

  it('isUuid 拒绝非 UUID', () => {
    expect(isUuid('31601c93f2f54b0d9cd85f8a0ee6de1d')).toBe(false); // 无连字符
    expect(isUuid('b3b869c00f4345a9bc32c6a3a8952065')).toBe(false);
    expect(isUuid('_global')).toBe(false);
    expect(isUuid('')).toBe(false);
  });

  it('uuidFromHash 生成合法 UUID v5', () => {
    const id = uuidFromHash('work:31601c93f2f54b0d9cd85f8a0ee6de1d');
    expect(isUuid(id)).toBe(true);
    // version 位应为 5
    expect(id.charAt(14)).toBe('5');
  });

  it('uuidFromHash 确定性：同 key 同结果', () => {
    expect(uuidFromHash('character:abc')).toBe(uuidFromHash('character:abc'));
  });

  it('uuidFromHash 不同 key 不同结果', () => {
    expect(uuidFromHash('character:abc')).not.toBe(uuidFromHash('character:def'));
  });

  it('uuidFromHash 域隔离：同 legacyId 不同 domain 不同 UUID', () => {
    expect(uuidFromHash('work:123')).not.toBe(uuidFromHash('agent:123'));
  });
});
