import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_BACKUP_ENTRIES_MAX,
  KNOWLEDGE_BACKUP_LINKS_MAX,
  KNOWLEDGE_BACKUP_TAGS_MAX,
  knowledgeBackupSchema,
  knowledgeFrontMatterSchema,
  knowledgeRestoreCommitRequestSchema,
  knowledgeRestorePreviewResponseSchema
} from './knowledge-portability';

const uuid = () => crypto.randomUUID();
const now = new Date().toISOString();

function entry(localId: string, overrides: Record<string, unknown> = {}) {
  return {
    local_id: localId,
    entry_type: 'article',
    title: '示例标题',
    original_text: '原文',
    content_hash: 'sha256:abc',
    structured: { entry_type: 'article', sections: [], key_points: [], tags: [] },
    outline: null,
    structure_status: 'ready',
    outline_status: null,
    origin: 'manual',
    favorite: false,
    pinned: false,
    tags: ['素材'],
    created_at: now,
    ...overrides
  };
}

function backup(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    kind: 'knowledge-backup',
    exported_at: now,
    library: { scope: 'global', work_id: null, work_title: null },
    entries: [entry('e1'), entry('e2')],
    tags: [{ name: '素材' }],
    links: [{ source_local_id: 'e1', target_local_id: 'e2', kind: 'manual' }],
    refs: [],
    ...overrides
  };
}

describe('knowledge backup v1', () => {
  it('accepts a valid v1 backup', () => {
    expect(knowledgeBackupSchema.safeParse(backup()).success).toBe(true);
  });

  it('rejects schema_version other than 1', () => {
    expect(knowledgeBackupSchema.safeParse(backup({ schema_version: 2 })).success).toBe(false);
    expect(knowledgeBackupSchema.safeParse(backup({ schema_version: 0 })).success).toBe(false);
  });

  it('rejects kind mismatch', () => {
    expect(knowledgeBackupSchema.safeParse(backup({ kind: 'character-backup' })).success).toBe(false);
  });

  it('rejects unknown root fields', () => {
    expect(knowledgeBackupSchema.safeParse(backup({ extra: true })).success).toBe(false);
  });

  it('rejects unknown fields in library and entry', () => {
    expect(knowledgeBackupSchema.safeParse(backup({ library: { scope: 'global', work_id: null, work_title: null, extra: 1 } })).success).toBe(false);
    expect(knowledgeBackupSchema.safeParse(backup({ entries: [entry('e1', { extra: 1 })] })).success).toBe(false);
  });

  it('rejects dangling link (unknown local_id)', () => {
    expect(
      knowledgeBackupSchema.safeParse(backup({ links: [{ source_local_id: 'e1', target_local_id: 'ghost', kind: 'manual' }] })).success
    ).toBe(false);
  });

  it('rejects self link', () => {
    expect(
      knowledgeBackupSchema.safeParse(backup({ links: [{ source_local_id: 'e1', target_local_id: 'e1', kind: 'manual' }] })).success
    ).toBe(false);
  });

  it('rejects duplicate local_id', () => {
    expect(
      knowledgeBackupSchema.safeParse(backup({ entries: [entry('e1'), entry('e1')] })).success
    ).toBe(false);
  });

  it('rejects entry count over 2000', () => {
    const entries = Array.from({ length: KNOWLEDGE_BACKUP_ENTRIES_MAX + 1 }, (_, i) => entry(`e${i}`));
    expect(knowledgeBackupSchema.safeParse(backup({ entries, links: [] })).success).toBe(false);
  });

  it('rejects tag count over 1000', () => {
    const tags = Array.from({ length: KNOWLEDGE_BACKUP_TAGS_MAX + 1 }, (_, i) => ({ name: `t${i}` }));
    expect(knowledgeBackupSchema.safeParse(backup({ tags })).success).toBe(false);
  });

  it('rejects link count over 5000', () => {
    const links = Array.from({ length: KNOWLEDGE_BACKUP_LINKS_MAX + 1 }, (_, i) => ({
      source_local_id: 'e1',
      target_local_id: `e${i + 1}`,
      kind: 'manual' as const
    }));
    expect(knowledgeBackupSchema.safeParse(backup({ links })).success).toBe(false);
  });

  it('rejects structured with unknown entry_type', () => {
    expect(knowledgeBackupSchema.safeParse(backup({ entries: [entry('e1', { structured: { entry_type: 'bogus' } })] })).success).toBe(false);
  });
});

describe('knowledge front matter', () => {
  it('accepts YAML subset and rejects unknown fields', () => {
    expect(knowledgeFrontMatterSchema.safeParse({ title: 't', type: 'article' }).success).toBe(true);
    expect(knowledgeFrontMatterSchema.safeParse({ title: 't', type: 'article', extra: 1 }).success).toBe(false);
  });

  it('limits type to five and title to 200', () => {
    expect(knowledgeFrontMatterSchema.safeParse({ title: 't', type: 'setting' }).success).toBe(true);
    expect(knowledgeFrontMatterSchema.safeParse({ title: 't', type: 'bogus' }).success).toBe(false);
    expect(knowledgeFrontMatterSchema.safeParse({ title: 'x'.repeat(201), type: 'article' }).success).toBe(false);
  });
});

describe('knowledge restore preview/commit', () => {
  it('accepts preview response and commit', () => {
    const preview = {
      preview_id: uuid(),
      file_name: 'backup.sfkb.json.gz',
      uncompressed_bytes: 1024,
      summary: { total: 2, same_content: 1, same_title_diff_content: 1, new: 0 },
      conflicts: []
    };
    expect(knowledgeRestorePreviewResponseSchema.safeParse(preview).success).toBe(true);
    expect(knowledgeRestoreCommitRequestSchema.safeParse({ preview_id: uuid(), policy: 'skip' }).success).toBe(true);
    expect(
      knowledgeRestoreCommitRequestSchema.safeParse({ preview_id: uuid(), policy: 'rename', resolutions: [{ entry_index: 0, action: 'overwrite' }] }).success
    ).toBe(true);
  });

  it('rejects unknown fields and bad policy', () => {
    expect(knowledgeRestorePreviewResponseSchema.safeParse({ preview_id: uuid(), file_name: 'f', uncompressed_bytes: 0, summary: { total: 0, same_content: 0, same_title_diff_content: 0, new: 0 }, conflicts: [], extra: 1 }).success).toBe(false);
    expect(knowledgeRestoreCommitRequestSchema.safeParse({ preview_id: uuid(), policy: 'bogus' }).success).toBe(false);
  });
});
