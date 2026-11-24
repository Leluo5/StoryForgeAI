// M3c-3 知识库 T20 整库备份 v1（纯函数，无 DB）
// 依据：F2 §3.7、§4.7、§5.9；T03 契约 knowledgeBackupSchema；T20 完成标准
// 边界（L2 服务层）：JSON→gzip→Buffer 序列化、gzip→校验反序列化、恢复判重分类；不写 DB、不写 controller。
import { gunzipSync, gzipSync } from 'node:zlib';
import { UnprocessableEntityException } from '@nestjs/common';
import { knowledgeErrorCode, knowledgeBackupSchema } from '@storyforge/contracts';
import type { KnowledgeBackup, KnowledgeBackupEntry } from '@storyforge/contracts';

const { KNOWLEDGE_BACKUP_INVALID } = knowledgeErrorCode;

// 导出固定 schema_version=1（契约）
export function serializeBackupV1(backup: KnowledgeBackup): Buffer {
  const json = JSON.stringify(backup);
  return gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
}

// 反序列化：gzip→JSON→契约严格校验（版本/结构/悬空关联/数量上限）；失败 422
export function parseBackupV1(buf: Buffer): KnowledgeBackup {
  let text: string;
  try {
    text = gunzipSync(buf).toString('utf8');
  } catch {
    throw invalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid();
  }
  const result = knowledgeBackupSchema.safeParse(parsed);
  if (!result.success) throw invalid();
  return result.data;
}

// 恢复判重分类：同 content_hash→same_content；同标题不同内容→same_title_diff_content；否则 new
export interface BackupRestoreExisting {
  title: string;
  content_hash: string;
}
export interface BackupRestoreClassification {
  entry_index: number;
  conflict_type: 'same_content' | 'same_title_diff_content' | 'new';
  matched_hash?: string;
}

export function classifyBackupRestore(
  entries: KnowledgeBackupEntry[],
  existing: BackupRestoreExisting[]
): BackupRestoreClassification[] {
  const existingByHash = new Map(existing.map((e) => [e.content_hash, e]));
  const existingByTitle = new Map<string, BackupRestoreExisting>();
  for (const e of existing) {
    if (!existingByTitle.has(e.title)) existingByTitle.set(e.title, e);
  }

  return entries.map((entry, entry_index) => {
    const byHash = existingByHash.get(entry.content_hash);
    if (byHash) {
      return { entry_index, conflict_type: 'same_content', matched_hash: entry.content_hash } as const;
    }
    const byTitle = existingByTitle.get(entry.title);
    if (byTitle) {
      return { entry_index, conflict_type: 'same_title_diff_content', matched_hash: byTitle.content_hash } as const;
    }
    return { entry_index, conflict_type: 'new' } as const;
  });
}

function invalid(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: KNOWLEDGE_BACKUP_INVALID,
    message: '备份文件无效或版本不兼容'
  });
}
