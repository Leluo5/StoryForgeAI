import { describe, expect, it } from 'vitest';
import { ageToBand, normalizeName } from './character-candidate.normalize';
import { generateRandomDossier } from './character-random';

describe('character-candidate.normalize', () => {
  describe('normalizeName', () => {
    it('NFKC 折叠后统一为小写并去除所有间隔符', () => {
      // 全角／半角混排 + 多类间隔符
      expect(normalizeName(' 江-离＿A.L I　S A ')).toBe('江离alisa');
    });

    it('空值与空串返回空串', () => {
      expect(normalizeName('')).toBe('');
      expect(normalizeName(null)).toBe('');
      expect(normalizeName(undefined)).toBe('');
    });

    it('只含间隔符的串返回空串', () => {
      expect(normalizeName(' -_ .　\t')).toBe('');
    });
  });

  describe('ageToBand', () => {
    it('按区间映射', () => {
      expect(ageToBand(0)).toBe('baby');
      expect(ageToBand(2)).toBe('baby');
      expect(ageToBand(3)).toBe('child');
      expect(ageToBand(12)).toBe('child');
      expect(ageToBand(13)).toBe('teen');
      expect(ageToBand(17)).toBe('teen');
      expect(ageToBand(18)).toBe('young');
      expect(ageToBand(35)).toBe('young');
      expect(ageToBand(36)).toBe('middle');
      expect(ageToBand(55)).toBe('middle');
      expect(ageToBand(56)).toBe('senior');
      expect(ageToBand(75)).toBe('senior');
      expect(ageToBand(76)).toBe('elder');
      expect(ageToBand(999)).toBe('elder');
    });

    it('空值返回 null', () => {
      expect(ageToBand(null)).toBeNull();
      expect(ageToBand(undefined)).toBeNull();
    });
  });
});

describe('character-random', () => {
  it('同 seed 返回完全相同的 13 项资料', () => {
    const a = generateRandomDossier('seed-abc');
    const b = generateRandomDossier('seed-abc');
    expect(a.seed).toBe(b.seed);
    expect(a.dossier).toEqual(b.dossier);
    expect(a.avatar_asset_id).toBe(b.avatar_asset_id);
  });

  it('不同 seed 产生不同结果（极大概率）', () => {
    const a = generateRandomDossier('seed-one');
    const b = generateRandomDossier('seed-two');
    expect(a.seed).not.toBe(b.seed);
    expect(a.dossier.name).not.toBe(b.dossier.name);
  });

  it('13 项资料字段齐全', () => {
    const { dossier } = generateRandomDossier('seed-full');
    expect(Object.keys(dossier).sort()).toEqual([
      'age', 'age_band', 'attributes', 'country_region', 'experience', 'faction',
      'faith', 'gender', 'identity', 'name', 'occupation', 'personality', 'race'
    ]);
    expect(typeof dossier.name).toBe('string');
    expect(dossier.name.length).toBeGreaterThan(0);
  });

  it('age_band 与 age 保持一致', () => {
    for (const seed of ['seed-age-0', 'seed-age-1', 'seed-age-2', 'seed-age-3']) {
      const { dossier } = generateRandomDossier(seed);
      expect(ageToBand(dossier.age)).toBe(dossier.age_band);
    }
  });

  it('attributes 数量在 2~5 之间且每键≤20字、每值≤200字', () => {
    for (const seed of Array.from({ length: 20 }, (_, i) => `seed-attr-${i}`)) {
      const { dossier } = generateRandomDossier(seed);
      expect(dossier.attributes.length).toBeGreaterThanOrEqual(2);
      expect(dossier.attributes.length).toBeLessThanOrEqual(5);
      for (const attr of dossier.attributes) {
        expect(attr.key.length).toBeGreaterThanOrEqual(1);
        expect(attr.key.length).toBeLessThanOrEqual(20);
        expect(attr.value.length).toBeLessThanOrEqual(200);
      }
    }
  });

  it('自动生成 seed（不传时）', () => {
    const a = generateRandomDossier();
    const b = generateRandomDossier();
    expect(a.seed.length).toBeGreaterThan(0);
    expect(b.seed.length).toBeGreaterThan(0);
    expect(a.seed).not.toBe(b.seed);
  });
});
