import { describe, expect, it } from 'vitest';
import {
  createWorkRequestSchema,
  proseMirrorDocumentSchema,
  reorderRequestSchema,
  saveChangeRequestSchema,
  updateWorkRequestSchema,
  versionConflictDetailsSchema,
  workSchema
} from './writing';

const change = {
  change_id: crypto.randomUUID(),
  client_id: crypto.randomUUID(),
  sequence: 1,
  base_version: 0,
  operations: [{ stepType: 'replace', from: 1, to: 1 }]
};

describe('writing contracts', () => {
  it('rejects blank titles, duplicate reorder ids and invalid WAL sequences', () => {
    expect(createWorkRequestSchema.safeParse({ title: ' ', description: '' }).success).toBe(false);
    expect(saveChangeRequestSchema.safeParse({ ...change, sequence: 0 }).success).toBe(false);
    const id = crypto.randomUUID();
    expect(reorderRequestSchema.safeParse({ ordered_ids: [id, id] }).success).toBe(false);
  });

  it('accepts a versioned ProseMirror change and typed conflict details', () => {
    expect(saveChangeRequestSchema.parse(change).base_version).toBe(0);
    const document = proseMirrorDocumentSchema.parse({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(versionConflictDetailsSchema.parse({
      server_version: 1,
      server_document: document,
      server_content_hash: 'a'.repeat(64)
    }).server_document.type).toBe('doc');
  });

  it('defaults is_public to true and access_code to empty string on work responses', () => {
    const work = workSchema.parse({
      id: crypto.randomUUID(),
      author_id: crypto.randomUUID(),
      title: '测试',
      description: '',
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    expect(work.is_public).toBe(true);
    expect(work.access_code).toBe('');
  });

  it('accepts optional access fields on create/update requests and trims access_code', () => {
    expect(createWorkRequestSchema.safeParse({
      title: '新书', description: '', is_public: false, access_code: '  abc  '
    }).success).toBe(true);
    expect(updateWorkRequestSchema.parse({ access_code: '  xyz  ' }).access_code).toBe('xyz');
  });
});
