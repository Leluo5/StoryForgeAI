import { describe, expect, it } from 'vitest';
import {
  archiveScanSchema,
  chapterRoleMarksSchema,
  characterTextAnchorSchema,
  dismissAnchorsRequestSchema
} from './character-anchor';

const uuid = () => crypto.randomUUID();
const now = new Date().toISOString();

describe('character anchor contracts', () => {
  it('parses paragraph marks, chapter fallback and scan progress', () => {
    const payload = {
      paragraph_marks: [
        {
          id: uuid(),
          character_id: uuid(),
          character_name: '林昭',
          paragraph_pid: uuid(),
          matched_name: '昭儿',
          status: 'active',
          excerpt: '林昭拔剑而立。'
        }
      ],
      chapter_marks: [
        { character_id: uuid(), character_name: '林昭', reason: 'text_changed', label: '关联角色已归档（原文已修改）' }
      ],
      scan: { scan_id: uuid(), status: 'succeeded', scanned_chapters: 12, total_chapters: 12 }
    };
    expect(chapterRoleMarksSchema.safeParse(payload).success).toBe(true);
    expect(
      chapterRoleMarksSchema.safeParse({ ...payload, scan: { status: 'paused', scanned_chapters: 0, total_chapters: 0 } })
        .success
    ).toBe(false);
  });

  it('does not expose excerpt_hash on anchor responses', () => {
    const parsed = characterTextAnchorSchema.parse({
      id: uuid(),
      character_id: uuid(),
      chapter_id: uuid(),
      paragraph_pid: uuid(),
      matched_name: '林昭',
      excerpt: '林昭拔剑而立。',
      status: 'active',
      invalid_reason: null,
      created_at: now,
      excerpt_hash: 'a'.repeat(64)
    });
    expect('excerpt_hash' in parsed).toBe(false);
    expect(
      characterTextAnchorSchema.safeParse({
        id: uuid(),
        character_id: uuid(),
        chapter_id: uuid(),
        paragraph_pid: 'not-a-uuid',
        matched_name: '林昭',
        excerpt: '',
        status: 'active',
        created_at: now
      }).success
    ).toBe(false);
  });

  it('caps batch dismissal at 100 anchors', () => {
    expect(dismissAnchorsRequestSchema.safeParse({ anchor_ids: [uuid()] }).success).toBe(true);
    expect(dismissAnchorsRequestSchema.safeParse({ anchor_ids: [] }).success).toBe(false);
    expect(
      dismissAnchorsRequestSchema.safeParse({ anchor_ids: Array.from({ length: 101 }, () => uuid()) }).success
    ).toBe(false);
  });

  it('validates scan entity status and counters', () => {
    const scan = {
      id: uuid(),
      character_id: uuid(),
      status: 'running',
      total_chapters: 20,
      scanned_chapters: 5,
      matched_paragraphs: 8,
      error: null,
      created_at: now
    };
    expect(archiveScanSchema.safeParse(scan).success).toBe(true);
    expect(archiveScanSchema.safeParse({ ...scan, status: 'done' }).success).toBe(false);
    expect(archiveScanSchema.safeParse({ ...scan, scanned_chapters: -1 }).success).toBe(false);
  });
});
