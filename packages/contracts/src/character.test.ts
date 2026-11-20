import { describe, expect, it } from 'vitest';
import {
  characterAttributesSchema,
  characterDossierSchema,
  characterRelationSchema,
  characterSchema,
  characterViewFiltersSchema,
  createCharacterRelationRequestSchema,
  createCharacterRequestSchema,
  randomCharacterResponseSchema,
  updateCharacterRequestSchema
} from './character';

const uuid = () => crypto.randomUUID();
const now = new Date().toISOString();

function character(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    work_id: uuid(),
    name: '林昭',
    aliases: ['昭儿'],
    identity: '剑修',
    age: 27,
    gender: '男',
    personality: '',
    experience: '',
    country_region: '东洲',
    faith: null,
    faction: '青云宗',
    race: '人族',
    occupation: '剑客',
    age_band: '青年',
    attributes: [{ key: '境界', value: '筑基' }],
    avatar_asset_id: null,
    status: 'active',
    merged_into_id: null,
    archived_at: null,
    origin: 'manual',
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

describe('character contracts', () => {
  it('accepts a full character and rejects unknown status or merged without target', () => {
    expect(characterSchema.safeParse(character()).success).toBe(true);
    expect(characterSchema.safeParse(character({ status: 'bogus' })).success).toBe(false);
  });

  it('enforces attribute key/value limits and rejects unknown attribute fields', () => {
    expect(characterAttributesSchema.safeParse([{ key: '境界', value: '筑基' }]).success).toBe(true);
    expect(characterAttributesSchema.safeParse([{ key: '境'.repeat(21), value: '' }]).success).toBe(false);
    expect(characterAttributesSchema.safeParse([{ key: '境界', value: 'x', extra: true }]).success).toBe(false);
    expect(
      characterAttributesSchema.safeParse(Array.from({ length: 21 }, () => ({ key: 'k', value: 'v' }))).success
    ).toBe(false);
  });

  it('enforces dossier field limits including aliases cap on create', () => {
    const dossier = {
      name: '林昭',
      identity: null,
      age: 27,
      gender: '男',
      personality: '',
      experience: '',
      country_region: null,
      faith: null,
      faction: null,
      race: null,
      occupation: null,
      age_band: null,
      attributes: []
    };
    expect(characterDossierSchema.safeParse(dossier).success).toBe(true);
    expect(characterDossierSchema.safeParse({ ...dossier, name: '名'.repeat(61) }).success).toBe(false);
    expect(characterDossierSchema.safeParse({ ...dossier, age: 10_001 }).success).toBe(false);
    expect(createCharacterRequestSchema.safeParse({ ...dossier, aliases: [] }).success).toBe(true);
    expect(
      createCharacterRequestSchema.safeParse({ ...dossier, aliases: Array.from({ length: 11 }, (_, i) => `别名${i}`) })
        .success
    ).toBe(false);
  });

  it('keeps view filters strict and expected_version nonnegative', () => {
    expect(characterViewFiltersSchema.safeParse({ faction: '青云宗' }).success).toBe(true);
    expect(characterViewFiltersSchema.safeParse({ unknown: 'x' }).success).toBe(false);
    expect(updateCharacterRequestSchema.safeParse({ expected_version: 2 }).success).toBe(true);
    expect(updateCharacterRequestSchema.safeParse({ expected_version: -1 }).success).toBe(false);
  });

  it('rejects self relations and invalid relation colors', () => {
    const characterId = uuid();
    expect(
      createCharacterRelationRequestSchema.safeParse({
        source_id: characterId,
        target_id: characterId,
        type_id: uuid()
      }).success
    ).toBe(false);
    expect(
      createCharacterRelationRequestSchema.safeParse({
        source_id: uuid(),
        target_id: uuid(),
        type_id: uuid(),
        color: '#ABCDEF'
      }).success
    ).toBe(true);
    expect(
      createCharacterRelationRequestSchema.safeParse({
        source_id: uuid(),
        target_id: uuid(),
        type_id: uuid(),
        color: 'blue'
      }).success
    ).toBe(false);
  });

  it('validates relation entity self reference and reverse label rules', () => {
    const characterId = uuid();
    const relation = {
      id: uuid(),
      work_id: uuid(),
      source_id: characterId,
      target_id: characterId,
      type_id: uuid(),
      directed: false,
      label: '同门',
      reverse_label: null,
      color: '#5b8def',
      line_style: 'solid',
      tag: '同门',
      origin: 'manual',
      created_at: now,
      updated_at: now
    };
    expect(characterRelationSchema.safeParse(relation).success).toBe(false);
    expect(
      characterRelationSchema.safeParse({ ...relation, target_id: uuid(), reverse_label: '师' }).success
    ).toBe(false);
  });

  it('requires a seed echo and 13-item dossier in random profile response', () => {
    const dossier = {
      name: '林昭',
      identity: '剑修',
      age: 27,
      gender: '男',
      personality: '沉稳',
      experience: '',
      country_region: '东洲',
      faith: null,
      faction: '青云宗',
      race: '人族',
      occupation: '剑客',
      age_band: '青年',
      attributes: [{ key: '境界', value: '筑基' }]
    };
    expect(randomCharacterResponseSchema.safeParse({ seed: 'seed-1', dossier }).success).toBe(true);
    const missing: Record<string, unknown> = { ...dossier };
    delete missing.attributes;
    expect(randomCharacterResponseSchema.safeParse({ seed: 'seed-1', dossier: missing }).success).toBe(false);
  });
});
