import { describe, expect, it } from 'vitest';
import type { FastGptHit } from './fastgpt.client';
import { mapCitations } from './citation.mapper';

function hit(partial: Partial<FastGptHit>): FastGptHit {
  return { id: 'doc-x', title: '标题', content: '内容', score: 0.5, ...partial };
}

describe('mapCitations (T11)', () => {
  it('truncates snippet to 500 chars and title to 200', () => {
    const long = '字'.repeat(700);
    const longTitle = '题'.repeat(300);
    const [c] = mapCitations([hit({ id: 'd1', content: long, title: longTitle })], 'ds-1');
    expect(c!.snippet).toHaveLength(500);
    expect(c!.title).toHaveLength(200);
  });

  it('falls back title to source_id when title is blank', () => {
    const [c] = mapCitations([hit({ id: 'd2', title: '  ' })], 'ds-1');
    expect(c!.title).toBe('d2');
  });

  it('caps citation count at max', () => {
    const hits = Array.from({ length: 12 }, (_, i) => hit({ id: `d${i}` }));
    const mapped = mapCitations(hits, 'ds-1', 8);
    expect(mapped).toHaveLength(8);
  });

  it('throws COLLAB_NO_CITATION on zero hits', () => {
    expect(() => mapCitations([], 'ds-1')).toThrowError(
      expect.objectContaining({ code: 'COLLAB_NO_CITATION' })
    );
  });

  it('keeps score as null when missing', () => {
    const [c] = mapCitations([hit({ id: 'd3', score: null })], 'ds-1');
    expect(c!.score).toBeNull();
  });
});
