import { describe, expect, it } from 'vitest';
import {
  articleStructuredSchema,
  decodeCursor,
  encodeCursor,
  inspirationStructuredSchema,
  knowledgeEntryCreateRequestSchema,
  knowledgeEntryDetailSchema,
  knowledgeEntryPatchRequestSchema,
  knowledgeEntrySummarySchema,
  knowledgeErrorCode,
  knowledgeExpectedVersionSchema,
  knowledgeFlagsRequestSchema,
  knowledgeLinkCreateRequestSchema,
  knowledgeLinkSchema,
  knowledgeOutlineSchema,
  knowledgeRefCreateRequestSchema,
  knowledgeRefSchema,
  knowledgeSearchQuerySchema,
  knowledgeSearchResponseSchema,
  knowledgeStructuredSchema,
  knowledgeTagRequestSchema,
  knowledgeTagSchema,
  novelStructuredSchema,
  paperStructuredSchema,
  settingStructuredSchema
} from './knowledge';

const uuid = () => crypto.randomUUID();
const now = new Date().toISOString();

function summary(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'entry',
    id: uuid(),
    entry_type: 'article',
    title: '示例标题',
    excerpt: '摘要',
    tags: ['素材'],
    structure_status: 'ready',
    favorite: false,
    pinned: false,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    ...summary(),
    original_text: '原文内容',
    structured: { entry_type: 'article', sections: [], key_points: [], tags: [] },
    outline: { chapters: [], plot_nodes: [], character_relations: [], story_lines: [] },
    version: 1,
    content_hash: 'abc123',
    ...overrides
  };
}

describe('knowledge enums', () => {
  it('accepts five entry types including setting', () => {
    for (const type of ['article', 'paper', 'novel', 'inspiration', 'setting']) {
      expect(knowledgeEntryCreateRequestSchema.safeParse({ scope: 'global', text: 'x', entry_type: type }).success).toBe(true);
    }
    expect(knowledgeEntryCreateRequestSchema.safeParse({ scope: 'global', text: 'x', entry_type: 'bogus' }).success).toBe(false);
  });

  it('rejects unknown scope', () => {
    expect(knowledgeSearchQuerySchema.safeParse({ scope: 'bogus' }).success).toBe(false);
    expect(knowledgeSearchQuerySchema.safeParse({ scope: 'work' }).success).toBe(true);
  });
});

describe('knowledge structured discriminated union', () => {
  it('accepts article structured and rejects unknown fields', () => {
    expect(articleStructuredSchema.safeParse({ sections: [], key_points: [], tags: [] }).success).toBe(true);
    expect(articleStructuredSchema.safeParse({ sections: [], key_points: [], tags: [], extra: true }).success).toBe(false);
  });

  it('setting reuses article structure', () => {
    expect(settingStructuredSchema.safeParse({ sections: [], key_points: [], tags: [] }).success).toBe(true);
  });

  it('accepts paper and enforces keyword limit', () => {
    expect(paperStructuredSchema.safeParse({ research_question: 'r', method: 'm', findings: 'f', contributions: 'c', limitations: 'l', keywords: ['k'] }).success).toBe(true);
    expect(
      paperStructuredSchema.safeParse({ research_question: 'r', method: 'm', findings: 'f', contributions: 'c', limitations: 'l', keywords: Array.from({ length: 21 }, () => 'k') }).success
    ).toBe(false);
  });

  it('accepts novel characters and rejects unknown character fields', () => {
    expect(
      novelStructuredSchema.safeParse({ characters: [{ name: '林昭', role: '主角', description: '' }], plot_summary: 'p', narrative_style: 's', worldview: 'w' }).success
    ).toBe(true);
    expect(
      novelStructuredSchema.safeParse({ characters: [{ name: '林昭', role: '主角', description: '', extra: 1 }], plot_summary: 'p', narrative_style: 's', worldview: 'w' }).success
    ).toBe(false);
  });

  it('accepts inspiration with matched ids and rejects bad id', () => {
    expect(inspirationStructuredSchema.safeParse({ completion: 'c', matched_entry_ids: [uuid()], independent: false }).success).toBe(true);
    expect(inspirationStructuredSchema.safeParse({ completion: 'c', matched_entry_ids: ['not-a-uuid'], independent: false }).success).toBe(false);
    expect(
      inspirationStructuredSchema.safeParse({ completion: 'c', matched_entry_ids: [uuid(), uuid(), uuid(), uuid()], independent: false }).success
    ).toBe(false);
  });

  it('discriminated union rejects unknown entry_type and unknown per-branch fields', () => {
    expect(knowledgeStructuredSchema.safeParse({ entry_type: 'article', sections: [], key_points: [], tags: [] }).success).toBe(true);
    expect(knowledgeStructuredSchema.safeParse({ entry_type: 'bogus', sections: [] }).success).toBe(false);
    expect(
      knowledgeStructuredSchema.safeParse({ entry_type: 'paper', research_question: 'r', method: 'm', findings: 'f', contributions: 'c', limitations: 'l', keywords: [], extra: true }).success
    ).toBe(false);
  });
});

describe('knowledge outline', () => {
  it('accepts a valid four-dimension outline', () => {
    const outline = {
      chapters: [{ title: '第一章', summary: 's' }],
      plot_nodes: [{ title: '事件', summary: 's', chapter_index: 0 }],
      character_relations: [{ source: 'A', target: 'B', relation: '同场' }],
      story_lines: [{ name: '主线', description: 'd', chapter_indexes: [0, 1] }]
    };
    expect(knowledgeOutlineSchema.safeParse(outline).success).toBe(true);
    expect(knowledgeOutlineSchema.safeParse({ ...outline, extra: true }).success).toBe(false);
  });

  it('enforces chapter_index nonnegative', () => {
    expect(
      knowledgeOutlineSchema.safeParse({
        chapters: [],
        plot_nodes: [{ title: '事件', summary: 's', chapter_index: -1 }],
        character_relations: [],
        story_lines: []
      }).success
    ).toBe(false);
  });
});

describe('knowledge entities', () => {
  it('accepts summary and rejects unknown fields', () => {
    expect(knowledgeEntrySummarySchema.safeParse(summary()).success).toBe(true);
    expect(knowledgeEntrySummarySchema.safeParse(summary({ extra: true })).success).toBe(false);
  });

  it('enforces excerpt cap of 160', () => {
    expect(knowledgeEntrySummarySchema.safeParse(summary({ excerpt: 'x'.repeat(161) })).success).toBe(false);
    expect(knowledgeEntrySummarySchema.safeParse(summary({ excerpt: 'x'.repeat(160) })).success).toBe(true);
  });

  it('accepts reference kind with optional ref_id and ref_status (per §3.3)', () => {
    expect(
      knowledgeEntrySummarySchema.safeParse(summary({ kind: 'reference', ref_id: uuid(), ref_status: 'active' })).success
    ).toBe(true);
    // ref_id / ref_status 均为可选（§3.3 标注 `ref_id?`、`ref_status?`），缺失不拒绝
    expect(knowledgeEntrySummarySchema.safeParse(summary({ kind: 'reference', ref_id: uuid() })).success).toBe(true);
    expect(knowledgeEntrySummarySchema.safeParse(summary({ kind: 'entry' })).success).toBe(true);
  });

  it('accepts detail with structured and outline', () => {
    expect(knowledgeEntryDetailSchema.safeParse(detail()).success).toBe(true);
    expect(knowledgeEntryDetailSchema.safeParse(detail({ structured: { entry_type: 'article', sections: [], key_points: [], tags: [], extra: true } })).success).toBe(false);
  });

  it('validates tag name length and entry_count', () => {
    expect(knowledgeTagSchema.safeParse({ id: uuid(), name: '素材', entry_count: 3 }).success).toBe(true);
    expect(knowledgeTagSchema.safeParse({ id: uuid(), name: 'x'.repeat(41), entry_count: 3 }).success).toBe(false);
  });

  it('validates link self-reject at schema level via refine? links do not self-check', () => {
    const link = { id: uuid(), source_entry_id: uuid(), target_entry_id: uuid(), kind: 'manual', source_title: 'a', target_title: 'b', created_at: now };
    expect(knowledgeLinkSchema.safeParse(link).success).toBe(true);
    // 未知字段拒绝
    expect(knowledgeLinkSchema.safeParse({ ...link, extra: 1 }).success).toBe(false);
  });

  it('validates ref snapshot', () => {
    expect(
      knowledgeRefSchema.safeParse({ id: uuid(), title: 't', entry_type: 'article', tags: [], excerpt: 'e', status: 'active', favorite: false, pinned: false, created_at: now }).success
    ).toBe(true);
    expect(
      knowledgeRefSchema.safeParse({ id: uuid(), title: 't', entry_type: 'article', tags: [], excerpt: 'e', status: 'bogus', favorite: false, pinned: false, created_at: now }).success
    ).toBe(false);
  });
});

describe('knowledge requests', () => {
  it('enforces text min/max on create', () => {
    expect(knowledgeEntryCreateRequestSchema.safeParse({ scope: 'global', text: '' }).success).toBe(false);
    expect(knowledgeEntryCreateRequestSchema.safeParse({ scope: 'global', text: 'x'.repeat(20_000_001) }).success).toBe(false);
    expect(knowledgeEntryCreateRequestSchema.safeParse({ scope: 'global', text: 'x' }).success).toBe(true);
  });

  it('enforces tags cap of 20 on create', () => {
    expect(
      knowledgeEntryCreateRequestSchema.safeParse({ scope: 'global', text: 'x', tags: Array.from({ length: 21 }, () => 't') }).success
    ).toBe(false);
    expect(
      knowledgeEntryCreateRequestSchema.safeParse({ scope: 'global', text: 'x', tags: Array.from({ length: 20 }, () => 't') }).success
    ).toBe(true);
  });

  it('rejects unknown fields on create and patch', () => {
    expect(knowledgeEntryCreateRequestSchema.safeParse({ scope: 'global', text: 'x', extra: 1 }).success).toBe(false);
    expect(knowledgeEntryPatchRequestSchema.safeParse({ expected_version: 1, extra: 1 }).success).toBe(false);
  });

  it('validates expected_version nonnegative', () => {
    expect(knowledgeExpectedVersionSchema.safeParse(0).success).toBe(true);
    expect(knowledgeExpectedVersionSchema.safeParse(2).success).toBe(true);
    expect(knowledgeExpectedVersionSchema.safeParse(-1).success).toBe(false);
  });

  it('patch rejects unknown structured entry_type', () => {
    expect(knowledgeEntryPatchRequestSchema.safeParse({ structured: { entry_type: 'bogus', sections: [] } }).success).toBe(false);
  });
});

describe('knowledge search query', () => {
  it('defaults time_field and limit', () => {
    const parsed = knowledgeSearchQuerySchema.parse({ scope: 'global' });
    expect(parsed.time_field).toBe('created_at');
    expect(parsed.limit).toBe(50);
  });

  it('rejects limit out of 1~100', () => {
    expect(knowledgeSearchQuerySchema.safeParse({ scope: 'global', limit: 0 }).success).toBe(false);
    expect(knowledgeSearchQuerySchema.safeParse({ scope: 'global', limit: 101 }).success).toBe(false);
    expect(knowledgeSearchQuerySchema.safeParse({ scope: 'global', limit: 1 }).success).toBe(true);
    expect(knowledgeSearchQuerySchema.safeParse({ scope: 'global', limit: 100 }).success).toBe(true);
  });

  it('rejects time_field outside enum and tag_ids over 20', () => {
    expect(knowledgeSearchQuerySchema.safeParse({ scope: 'global', time_field: 'bogus' }).success).toBe(false);
    expect(
      knowledgeSearchQuerySchema.safeParse({ scope: 'global', tag_ids: Array.from({ length: 21 }, () => uuid()) }).success
    ).toBe(false);
  });

  it('rejects keyword over 80', () => {
    expect(knowledgeSearchQuerySchema.safeParse({ scope: 'global', keyword: 'x'.repeat(81) }).success).toBe(false);
  });

  it('accepts cursor as string', () => {
    expect(knowledgeSearchQuerySchema.safeParse({ scope: 'global', cursor: 'abc' }).success).toBe(true);
  });

  it('validates search response', () => {
    expect(knowledgeSearchResponseSchema.safeParse({ items: [summary()], total: 1, next_cursor: null }).success).toBe(true);
    expect(knowledgeSearchResponseSchema.safeParse({ items: [], total: 0, next_cursor: 'abc' }).success).toBe(true);
  });
});

describe('knowledge flags / tag / link / ref requests', () => {
  it('validates flags request', () => {
    expect(knowledgeFlagsRequestSchema.safeParse({ favorite: true }).success).toBe(true);
    expect(knowledgeFlagsRequestSchema.safeParse({ pinned: false }).success).toBe(true);
    expect(knowledgeFlagsRequestSchema.safeParse({ favorite: true, extra: 1 }).success).toBe(false);
  });

  it('validates tag request name length', () => {
    expect(knowledgeTagRequestSchema.safeParse({ scope: 'global', name: '素材' }).success).toBe(true);
    expect(knowledgeTagRequestSchema.safeParse({ scope: 'global', name: 'x'.repeat(41) }).success).toBe(false);
  });

  it('validates link create', () => {
    expect(knowledgeLinkCreateRequestSchema.safeParse({ source_entry_id: uuid(), target_entry_id: uuid() }).success).toBe(true);
    expect(knowledgeLinkCreateRequestSchema.safeParse({ source_entry_id: uuid() }).success).toBe(false);
  });

  it('enforces ref batch entry_ids cap of 50', () => {
    expect(knowledgeRefCreateRequestSchema.safeParse({ entry_ids: [uuid()] }).success).toBe(true);
    expect(knowledgeRefCreateRequestSchema.safeParse({ entry_ids: Array.from({ length: 51 }, () => uuid()) }).success).toBe(false);
    expect(knowledgeRefCreateRequestSchema.safeParse({ entry_ids: [] }).success).toBe(false);
  });
});

describe('knowledge error codes (T04)', () => {
  it('has exactly 22 codes matching §4.8 (14x409 + 1x413 + 1x415 + 6x422)', () => {
    const codes = Object.values(knowledgeErrorCode);
    expect(codes).toHaveLength(22);
  });

  it('contains all 14 conflict codes', () => {
    const conflictCodes = [
      'KNOWLEDGE_ENTRY_DUPLICATE',
      'KNOWLEDGE_VERSION_CONFLICT',
      'KNOWLEDGE_JOB_RUNNING',
      'KNOWLEDGE_REF_READONLY',
      'KNOWLEDGE_REF_EXISTS',
      'KNOWLEDGE_LINK_EXISTS',
      'KNOWLEDGE_LINK_SELF',
      'KNOWLEDGE_LINK_CROSS_LIBRARY',
      'KNOWLEDGE_TAG_NAME_EXISTS',
      'KNOWLEDGE_ENTRY_DELETED',
      'KNOWLEDGE_ENTRY_NOT_DELETED',
      'KNOWLEDGE_ENTRY_REFERENCED',
      'KNOWLEDGE_RESTORE_NEEDS_RESOLUTION',
      'KNOWLEDGE_BACKUP_VERSION_UNSUPPORTED'
    ];
    for (const code of conflictCodes) {
      expect(knowledgeErrorCode[code as keyof typeof knowledgeErrorCode]).toBe(code);
    }
  });

  it('contains 413/415/422 codes', () => {
    expect(knowledgeErrorCode.KNOWLEDGE_FILE_TOO_LARGE).toBe('KNOWLEDGE_FILE_TOO_LARGE');
    expect(knowledgeErrorCode.KNOWLEDGE_FILE_TYPE_UNSUPPORTED).toBe('KNOWLEDGE_FILE_TYPE_UNSUPPORTED');
    expect(knowledgeErrorCode.KNOWLEDGE_TEXT_EMPTY).toBe('KNOWLEDGE_TEXT_EMPTY');
    expect(knowledgeErrorCode.KNOWLEDGE_TEXT_TOO_LARGE).toBe('KNOWLEDGE_TEXT_TOO_LARGE');
    expect(knowledgeErrorCode.KNOWLEDGE_PARSE_FAILED).toBe('KNOWLEDGE_PARSE_FAILED');
    expect(knowledgeErrorCode.KNOWLEDGE_MARKDOWN_INVALID).toBe('KNOWLEDGE_MARKDOWN_INVALID');
    expect(knowledgeErrorCode.KNOWLEDGE_BACKUP_INVALID).toBe('KNOWLEDGE_BACKUP_INVALID');
    expect(knowledgeErrorCode.KNOWLEDGE_IMPORT_INVALID).toBe('KNOWLEDGE_IMPORT_INVALID');
  });
});

describe('cursor codec (T04)', () => {
  it('encodes and decodes round-trip', () => {
    const updatedAt = now;
    const entryId = uuid();
    const encoded = encodeCursor(updatedAt, entryId);
    expect(encoded).not.toBeNull();
    const decoded = decodeCursor(encoded!);
    expect(decoded).toEqual({ updatedAt, id: entryId });
  });

  it('round-trips multiple distinct cursors', () => {
    const samples = [
      { updatedAt: new Date('2026-11-21T10:00:00.000Z').toISOString(), id: uuid() },
      { updatedAt: new Date('2026-11-22T00:00:00.000Z').toISOString(), id: uuid() }
    ];
    for (const s of samples) {
      const enc = encodeCursor(s.updatedAt, s.id)!;
      expect(decodeCursor(enc)).toEqual({ updatedAt: s.updatedAt, id: s.id });
    }
  });

  it('returns null for invalid input instead of throwing', () => {
    expect(encodeCursor('not-a-date', uuid())).toBeNull();
    expect(encodeCursor(now, 'not-a-uuid')).toBeNull();
    expect(encodeCursor('', '')).toBeNull();
    expect(encodeCursor(123 as unknown as string, uuid() as unknown as string)).toBeNull();
    expect(encodeCursor(now, undefined as unknown as string)).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('!!!not-base64url!!!')).toBeNull();
    expect(decodeCursor('no-separator')).toBeNull();
    expect(decodeCursor('abc123')).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('does not expose SQL internal format (no raw pipe in encoded output)', () => {
    const encoded = encodeCursor(now, uuid())!;
    expect(encoded).not.toContain('|');
    expect(encoded).not.toContain(now);
  });
});
