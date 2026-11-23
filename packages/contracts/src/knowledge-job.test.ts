import { describe, expect, it } from 'vitest';
import {
  knowledgeExportRequestSchema,
  knowledgeImportCommitRequestSchema,
  knowledgeImportPreviewResponseSchema,
  knowledgeJobEventSchema,
  knowledgeJobEventTypeSchema,
  knowledgeJobKindSchema,
  knowledgeJobProgressSchema,
  knowledgeJobReplayQuerySchema,
  knowledgeJobSchema,
  knowledgeJobStatusSchema,
  knowledgeUploadResponseSchema
} from './knowledge-job';

const uuid = () => crypto.randomUUID();
const now = new Date().toISOString();

describe('knowledge job enums', () => {
  it('has seven kinds', () => {
    expect(knowledgeJobKindSchema.options).toEqual([
      'ingest',
      'structure',
      'outline',
      'export_markdown',
      'export_backup',
      'import_markdown',
      'restore_backup'
    ]);
  });

  it('has five statuses', () => {
    expect(knowledgeJobStatusSchema.options).toEqual(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
  });

  it('has six SSE event types', () => {
    expect(knowledgeJobEventTypeSchema.options).toEqual(['queued', 'running', 'progress', 'succeeded', 'failed', 'cancelled']);
  });
});

describe('knowledge job progress', () => {
  it('accepts valid progress and rejects out-of-range percent', () => {
    expect(knowledgeJobProgressSchema.safeParse({ stage: '结构化', processed: 1, total: 10, percent: 10 }).success).toBe(true);
    expect(knowledgeJobProgressSchema.safeParse({ stage: '结构化', processed: 1, total: 10, percent: 101 }).success).toBe(false);
    expect(knowledgeJobProgressSchema.safeParse({ stage: '结构化', processed: 1, total: 10, percent: -1 }).success).toBe(false);
  });

  it('rejects unknown progress fields', () => {
    expect(
      knowledgeJobProgressSchema.safeParse({ stage: 's', processed: 0, total: 0, percent: 0, extra: 1 }).success
    ).toBe(false);
  });
});

describe('knowledge job entity', () => {
  function job(overrides: Record<string, unknown> = {}) {
    return {
      id: uuid(),
      kind: 'ingest',
      status: 'queued',
      library_scope: 'global',
      progress: { stage: '等待', processed: 0, total: 0, percent: 0 },
      result: {},
      error: null,
      created_at: now,
      finished_at: null,
      ...overrides
    };
  }

  it('accepts a full job', () => {
    expect(knowledgeJobSchema.safeParse(job()).success).toBe(true);
    expect(knowledgeJobSchema.safeParse(job({ error: { code: 'X', message: 'm' } })).success).toBe(true);
  });

  it('rejects unknown fields and bad error code', () => {
    expect(knowledgeJobSchema.safeParse(job({ extra: 1 })).success).toBe(false);
    expect(knowledgeJobSchema.safeParse(job({ error: { message: 'm' } })).success).toBe(false);
  });
});

describe('knowledge SSE event', () => {
  it('accepts events with optional progress/payload', () => {
    expect(knowledgeJobEventSchema.safeParse({ seq: 1, type: 'queued', job_id: uuid(), at: now }).success).toBe(true);
    expect(
      knowledgeJobEventSchema.safeParse({ seq: 2, type: 'progress', job_id: uuid(), progress: { stage: 's', processed: 1, total: 2, percent: 50 }, at: now }).success
    ).toBe(true);
    expect(knowledgeJobEventSchema.safeParse({ seq: 3, type: 'failed', job_id: uuid(), payload: { code: 'X' }, at: now }).success).toBe(true);
  });

  it('rejects unknown event type and seq negative', () => {
    expect(knowledgeJobEventSchema.safeParse({ seq: 1, type: 'bogus', job_id: uuid(), at: now }).success).toBe(false);
    expect(knowledgeJobEventSchema.safeParse({ seq: -1, type: 'queued', job_id: uuid(), at: now }).success).toBe(false);
  });
});

describe('knowledge replay query', () => {
  it('accepts after_seq and rejects unknown fields', () => {
    expect(knowledgeJobReplayQuerySchema.safeParse({}).success).toBe(true);
    expect(knowledgeJobReplayQuerySchema.safeParse({ after_seq: 5 }).success).toBe(true);
    expect(knowledgeJobReplayQuerySchema.safeParse({ after_seq: '5' }).success).toBe(true);
    expect(knowledgeJobReplayQuerySchema.safeParse({ after_seq: -1 }).success).toBe(false);
    expect(knowledgeJobReplayQuerySchema.safeParse({ unknown: 'x' }).success).toBe(false);
  });
});

describe('knowledge upload response', () => {
  it('accepts jobs and rejected arrays', () => {
    expect(
      knowledgeUploadResponseSchema.safeParse({
        jobs: [{ job_id: uuid(), file_name: 'a.pdf', status: 'queued' }],
        rejected: []
      }).success
    ).toBe(true);
    expect(
      knowledgeUploadResponseSchema.safeParse({
        jobs: [],
        rejected: [{ file_name: 'b.exe', code: 'KNOWLEDGE_FILE_TYPE_UNSUPPORTED', message: 'm' }]
      }).success
    ).toBe(true);
  });

  it('rejects unknown fields', () => {
    expect(knowledgeUploadResponseSchema.safeParse({ jobs: [], rejected: [], extra: 1 }).success).toBe(false);
  });
});

describe('knowledge export request', () => {
  it('requires markdown format', () => {
    expect(knowledgeExportRequestSchema.safeParse({ scope: 'global', format: 'markdown' }).success).toBe(true);
    expect(knowledgeExportRequestSchema.safeParse({ scope: 'global', format: 'zip' }).success).toBe(false);
  });

  it('caps entry_ids at 200', () => {
    expect(
      knowledgeExportRequestSchema.safeParse({ scope: 'global', format: 'markdown', entry_ids: Array.from({ length: 201 }, () => uuid()) }).success
    ).toBe(false);
    expect(
      knowledgeExportRequestSchema.safeParse({ scope: 'global', format: 'markdown', entry_ids: Array.from({ length: 200 }, () => uuid()) }).success
    ).toBe(true);
  });
});

describe('knowledge import preview/commit', () => {
  it('accepts preview response and rejects unknown fields', () => {
    const preview = {
      preview_id: uuid(),
      files: [{ file_name: 'a.md', title: 't', entry_type: 'article', excerpt: 'e', size: 10, conflict: 'new' }],
      conflicts: [],
      summary: { total: 1, duplicate: 0, name_collision: 0, new: 1, failed: 0 }
    };
    expect(knowledgeImportPreviewResponseSchema.safeParse(preview).success).toBe(true);
    expect(knowledgeImportPreviewResponseSchema.safeParse({ ...preview, extra: 1 }).success).toBe(false);
  });

  it('accepts commit with policy and resolutions', () => {
    expect(knowledgeImportCommitRequestSchema.safeParse({ preview_id: uuid(), policy: 'overwrite' }).success).toBe(true);
    expect(
      knowledgeImportCommitRequestSchema.safeParse({ preview_id: uuid(), policy: 'rename', resolutions: [{ file_index: 0, action: 'skip' }] }).success
    ).toBe(true);
    expect(knowledgeImportCommitRequestSchema.safeParse({ preview_id: uuid(), policy: 'bogus' }).success).toBe(false);
  });
});
