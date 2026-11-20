import { describe, expect, it } from 'vitest';
import {
  characterExportFileSchema,
  characterExportQuerySchema,
  characterImportCommitRequestSchema,
  characterImportFileSchema
} from './character-portability';

const uuid = () => crypto.randomUUID();
const now = new Date().toISOString();

function character(localId: string, name: string) {
  return {
    local_id: localId,
    name,
    aliases: [],
    identity: null,
    age: 27,
    gender: null,
    personality: '',
    experience: '',
    country_region: null,
    faith: null,
    faction: null,
    race: null,
    occupation: null,
    age_band: null,
    attributes: [],
    origin: 'manual'
  };
}

function file(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    exported_at: now,
    work: { id: uuid(), title: '测试作品' },
    relation_types: [],
    characters: [character('c1', '林昭'), character('c2', '沈砚')],
    relations: [
      {
        source_local_id: 'c1',
        target_local_id: 'c2',
        type_code: 'master_apprentice',
        directed: true,
        label: '师徒'
      }
    ],
    growth_events: [],
    views: [],
    anchors: [],
    ...overrides
  };
}

describe('character portability contracts', () => {
  it('accepts v1 and v2 import files and rejects unknown root fields', () => {
    expect(characterImportFileSchema.safeParse(file()).success).toBe(true);
    expect(characterImportFileSchema.safeParse(file({ schema_version: 1, anchors: undefined })).success).toBe(true);
    expect(characterImportFileSchema.safeParse(file({ schema_version: 3 })).success).toBe(false);
    expect(characterImportFileSchema.safeParse(file({ extra: true })).success).toBe(false);
  });

  it('rejects dangling references, self relations and duplicate local ids', () => {
    expect(
      characterImportFileSchema.safeParse(
        file({
          relations: [
            { source_local_id: 'c1', target_local_id: 'c9', type_code: 'master_apprentice', directed: true, label: '师徒' }
          ]
        })
      ).success
    ).toBe(false);
    expect(
      characterImportFileSchema.safeParse(
        file({
          relations: [
            { source_local_id: 'c1', target_local_id: 'c1', type_code: 'master_apprentice', directed: true, label: '师徒' }
          ]
        })
      ).success
    ).toBe(false);
    expect(
      characterImportFileSchema.safeParse(file({ characters: [character('c1', '林昭'), character('c1', '沈砚')] })).success
    ).toBe(false);
  });

  it('rejects growth events and view layouts referencing unknown characters', () => {
    expect(
      characterImportFileSchema.safeParse(
        file({ growth_events: [{ character_local_id: 'c9', title: '初入宗门' }] })
      ).success
    ).toBe(false);
    expect(
      characterImportFileSchema.safeParse(
        file({ views: [{ name: '主线', filters: {}, layout: [{ character_local_id: 'c9', x: 0, y: 0 }] }] })
      ).success
    ).toBe(false);
  });

  it('caps character count at 500', () => {
    const characters = Array.from({ length: 501 }, (_, index) => character(`c${index}`, `角色${index}`));
    expect(characterImportFileSchema.safeParse(file({ characters, relations: [] })).success).toBe(false);
  });

  it('requires overwrite confirmation for replace commits', () => {
    const base = {
      preview_job_id: uuid(),
      idempotency_key: 'key-1',
      file: file()
    };
    expect(characterImportCommitRequestSchema.safeParse({ ...base, mode: 'replace' }).success).toBe(false);
    expect(
      characterImportCommitRequestSchema.safeParse({ ...base, mode: 'replace', confirm_overwrite: true }).success
    ).toBe(true);
    expect(characterImportCommitRequestSchema.safeParse({ ...base, mode: 'merge' }).success).toBe(true);
  });

  it('requires a merge target in resolutions', () => {
    const base = {
      preview_job_id: uuid(),
      idempotency_key: 'key-1',
      mode: 'merge',
      file: file()
    };
    expect(
      characterImportCommitRequestSchema.safeParse({
        ...base,
        resolutions: [{ local_id: 'c1', action: 'merge' }]
      }).success
    ).toBe(false);
    expect(
      characterImportCommitRequestSchema.safeParse({
        ...base,
        resolutions: [{ local_id: 'c1', action: 'merge', target_character_id: uuid() }]
      }).success
    ).toBe(true);
  });

  it('keeps export at v2 and defaults export flags to true', () => {
    expect(characterExportFileSchema.safeParse(file()).success).toBe(true);
    expect(characterExportFileSchema.safeParse(file({ schema_version: 1 })).success).toBe(false);
    expect(characterExportQuerySchema.parse({})).toEqual({ include_archived: true, include_anchors: true });
    expect(characterExportQuerySchema.parse({ include_archived: 'false' })).toEqual({
      include_archived: false,
      include_anchors: true
    });
  });
});
