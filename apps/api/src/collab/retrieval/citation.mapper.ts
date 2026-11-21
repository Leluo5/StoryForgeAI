import type { CollabCitation } from '@storyforge/contracts';
import { CollabUpstreamError } from '../channel/collab-upstream.error';
import type { FastGptHit } from './fastgpt.client';

// F11 引用映射（F2 §5.2）：
// 1. snippet 截断到 500 字；2. title 缺失用 source_id 兜底；
// 3. 引用数量上限由 max 控制；4. 零引用视为检索失败，抛 COLLAB_NO_CITATION。
export function mapCitations(hits: FastGptHit[], datasetId: string, max = 8): CollabCitation[] {
  const trimmed = hits.slice(0, max).map((hit) => {
    const sourceId = hit.id;
    const title = hit.title.trim() !== '' ? hit.title.trim() : sourceId;
    const snippet = hit.content.slice(0, 500);
    return {
      source_id: sourceId.slice(0, 128),
      title: title.slice(0, 200),
      snippet,
      score: hit.score
    } satisfies CollabCitation;
  });

  if (trimmed.length === 0) {
    throw new CollabUpstreamError('FastGPT 检索无可用引用', false, 'COLLAB_NO_CITATION');
  }

  return trimmed;
}
