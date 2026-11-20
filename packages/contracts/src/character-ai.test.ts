import { describe, expect, it } from 'vitest';
import {
  characterAiCandidateItemSchema,
  characterAiDraftSchema,
  confirmCharacterAiItemsRequestSchema,
  confirmCharacterAiItemRequestSchema,
  createCharacterAiDraftRequestSchema,
  growthCandidatePayloadSchema,
  relationCandidatePayloadSchema
} from './character-ai';

const uuid = () => crypto.randomUUID();
const now = new Date().toISOString();

const dossier = {
  name: '林昭',
  identity: '剑修',
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
  attributes: [{ key: '境界', value: '筑基' }]
};

function item(overrides: Record<string, unknown>) {
  return {
    id: uuid(),
    draft_id: uuid(),
    item_index: 0,
    dependencies: [],
    suspected_duplicates: [],
    status: 'pending',
    resolution: null,
    resolved_entity_id: null,
    resolved_at: null,
    ...overrides
  };
}

describe('character ai contracts', () => {
  it('accepts character, relation and growth payloads by kind', () => {
    expect(
      characterAiCandidateItemSchema.safeParse(item({ kind: 'character', payload: dossier })).success
    ).toBe(true);
    expect(
      characterAiCandidateItemSchema.safeParse({
        ...item({ kind: 'character', payload: dossier }),
        item_index: 1
      }).success
    ).toBe(true);
    expect(
      characterAiCandidateItemSchema.safeParse(
        item({
          kind: 'relation',
          payload: {
            source_ref: { kind: 'item', id: uuid() },
            target_ref: { kind: 'existing', id: uuid() },
            type_code: 'master_apprentice',
            directed: true,
            label: '师徒'
          }
        })
      ).success
    ).toBe(true);
    expect(
      characterAiCandidateItemSchema.safeParse(
        item({
          kind: 'growth',
          payload: { character_ref: { kind: 'item', id: uuid() }, title: '初入宗门' }
        })
      ).success
    ).toBe(true);
  });

  it('rejects payloads missing required fields or carrying unknown fields', () => {
    expect(
      relationCandidatePayloadSchema.safeParse({
        source_ref: { kind: 'item', id: uuid() },
        target_ref: { kind: 'existing', id: uuid() },
        id: 'extra'
      }).success
    ).toBe(false);
    expect(growthCandidatePayloadSchema.safeParse({ character_ref: { kind: 'item', id: uuid() } }).success).toBe(false);
    expect(
      characterAiCandidateItemSchema.safeParse(item({ kind: 'character', payload: { ...dossier, name: '' } })).success
    ).toBe(false);
    expect(
      characterAiCandidateItemSchema.safeParse(item({ kind: 'character', payload: { ...dossier, unknown: 1 } })).success
    ).toBe(false);
  });

  it('caps batch confirmation at 50 items', () => {
    expect(
      confirmCharacterAiItemsRequestSchema.safeParse({ item_ids: [uuid()] }).success
    ).toBe(true);
    expect(
      confirmCharacterAiItemsRequestSchema.safeParse({ item_ids: Array.from({ length: 51 }, () => uuid()) }).success
    ).toBe(false);
  });

  it('requires a target only for merge and rejects expected_version elsewhere', () => {
    expect(confirmCharacterAiItemRequestSchema.safeParse({ mode: 'merge' }).success).toBe(false);
    expect(
      confirmCharacterAiItemRequestSchema.safeParse({ mode: 'merge', target_character_id: uuid(), expected_version: 3 })
        .success
    ).toBe(true);
    expect(confirmCharacterAiItemRequestSchema.safeParse({ mode: 'create', expected_version: 3 }).success).toBe(false);
    expect(confirmCharacterAiItemRequestSchema.safeParse({ mode: 'create' }).success).toBe(true);
  });

  it('requires chapter_id for chapter drafts and character_ids for growth drafts', () => {
    expect(
      createCharacterAiDraftRequestSchema.safeParse({ kind: 'characters_relations', source: 'chapter' }).success
    ).toBe(false);
    expect(
      createCharacterAiDraftRequestSchema.safeParse({ kind: 'characters_relations', source: 'work' }).success
    ).toBe(true);
    expect(
      createCharacterAiDraftRequestSchema.safeParse({ kind: 'growth_events', source: 'work', character_ids: [] }).success
    ).toBe(false);
    expect(
      createCharacterAiDraftRequestSchema.safeParse({
        kind: 'growth_events',
        source: 'work',
        character_ids: [uuid()]
      }).success
    ).toBe(true);
  });

  it('validates draft status enum boundaries', () => {
    const draft = {
      id: uuid(),
      work_id: uuid(),
      kind: 'characters_relations',
      input_scope: 'work',
      input_chapter_id: null,
      status: 'succeeded',
      summary: null,
      error: null,
      task_id: null,
      idempotency_key: 'key-1',
      created_at: now,
      updated_at: now
    };
    expect(characterAiDraftSchema.safeParse(draft).success).toBe(true);
    expect(characterAiDraftSchema.safeParse({ ...draft, status: 'running' }).success).toBe(false);
  });
});
