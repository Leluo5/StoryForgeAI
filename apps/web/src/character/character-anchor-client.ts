import { z } from 'zod';
import {
  archiveScanSchema,
  chapterRoleMarksSchema,
  type ArchiveScan,
  type ChapterRoleMarks
} from '@storyforge/contracts';
import { apiRequest } from '../api/client';

// T38：归档锚点的类型化客户端。
// 复用 apiRequest 与 @storyforge/contracts 的 Schema，禁止直接写 fetch。
// 端点与 character-client.ts 的 T27 保持一致，便于调用方按端点归类。

export interface CharacterAnchorClient {
  getChapterRoleMarks(workId: string, chapterId: string): Promise<ChapterRoleMarks>;
  dismissAnchor(
    workId: string,
    chapterId: string,
    anchorId: string,
    reason?: string
  ): Promise<{ anchor_id: string; dismissed: true }>;
  dismissAnchorsBatch(workId: string, chapterId: string, anchorIds: string[]): Promise<{ dismissed: number }>;
  rescanArchive(workId: string, characterId: string): Promise<{ scan: ArchiveScan }>;
}

const anchorDismissResultSchema = z.object({
  anchor_id: z.string().uuid(),
  dismissed: z.literal(true)
});

const anchorDismissBatchResultSchema = z.object({
  dismissed: z.number().int().nonnegative()
});

const scanRescanResultSchema = z.object({ scan: archiveScanSchema });

const part = encodeURIComponent;
const root = '/api/v1/works';

export const characterAnchorClient: CharacterAnchorClient = {
  getChapterRoleMarks(workId, chapterId) {
    return apiRequest(`${root}/${part(workId)}/chapters/${part(chapterId)}/role-marks`, chapterRoleMarksSchema);
  },
  dismissAnchor(workId, chapterId, anchorId, reason) {
    return apiRequest(
      `${root}/${part(workId)}/chapters/${part(chapterId)}/role-marks/${part(anchorId)}/dismiss`,
      anchorDismissResultSchema,
      { method: 'POST', body: JSON.stringify({ reason }) }
    );
  },
  dismissAnchorsBatch(workId, chapterId, anchorIds) {
    return apiRequest(
      `${root}/${part(workId)}/chapters/${part(chapterId)}/role-marks/dismiss-batch`,
      anchorDismissBatchResultSchema,
      { method: 'POST', body: JSON.stringify({ anchor_ids: anchorIds }) }
    );
  },
  rescanArchive(workId, characterId) {
    return apiRequest(
      `${root}/${part(workId)}/characters/${part(characterId)}/archive-scans`,
      scanRescanResultSchema,
      { method: 'POST' }
    );
  }
};
