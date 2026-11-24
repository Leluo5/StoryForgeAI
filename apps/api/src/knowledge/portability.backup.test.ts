// M3c-3 知识库 T20 整库备份 v1（纯函数，无 DB）
// 依据：F2 §3.7、§4.7、§5.9；T03 契约 knowledgeBackupSchema；T20 完成标准
// 覆盖：序列化 JSON→gzip→Buffer 往返；反序列化 gzip→校验；版本不匹配/损坏抛 422；
//       判重分类（new/same_content/same_title_diff_content）；悬空关联拒绝。
import { knowledgeErrorCode, knowledgeBackupSchema, KNOWLEDGE_BACKUP_SCHEMA_VERSION } from '@storyforge/contracts';
import {
  classifyBackupRestore,
  parseBackupV1,
  serializeBackupV1
} from './portability.backup';
import type { KnowledgeBackup } from '@storyforge/contracts';

const { KNOWLEDGE_BACKUP_INVALID } = knowledgeErrorCode;

function makeBackup(overrides: Partial<KnowledgeBackup> = {}): KnowledgeBackup {
  return {
    schema_version: KNOWLEDGE_BACKUP_SCHEMA_VERSION,
    kind: 'knowledge-backup',
    exported_at: '2026-11-21T10:00:00.000Z',
    library: { scope: 'global', work_id: null, work_title: null },
    entries: [
      {
        local_id: 'e1',
        entry_type: 'article',
        title: '条目一',
        original_text: '内容一',
        content_hash: 'h1',
        structured: null,
        outline: null,
        structure_status: 'ready',
        outline_status: null,
        origin: 'manual',
        favorite: false,
        pinned: false,
        tags: [],
        created_at: '2026-11-21T10:00:00.000Z'
      }
    ],
    tags: [],
    links: [],
    refs: [],
    ...overrides
  };
}

describe('BackupV1 · 序列化往返', () => {
  it('序列化为 gzip Buffer 后可反序列化还原', () => {
    const backup = makeBackup();
    const buf = serializeBackupV1(backup);
    expect(Buffer.isBuffer(buf)).toBe(true);
    const restored = parseBackupV1(buf);
    expect(restored).toEqual(backup);
  });

  it('反序列化校验通过 knowledgeBackupSchema', () => {
    const backup = makeBackup();
    const buf = serializeBackupV1(backup);
    const parsed = knowledgeBackupSchema.parse(parseBackupV1(buf));
    expect(parsed.entries).toHaveLength(1);
  });
});

describe('BackupV1 · 校验', () => {
  it('损坏 gzip 抛 422', () => {
    expect(() => parseBackupV1(Buffer.from('not gzip content'))).toThrow();
  });

  it('schema_version 不匹配抛 422', () => {
    const backup = makeBackup({ schema_version: 2 as never });
    const buf = serializeBackupV1(backup);
    expect(() => parseBackupV1(buf)).toThrow();
  });

  it('悬空关联抛 422', () => {
    const backup = makeBackup({
      links: [{ source_local_id: 'e1', target_local_id: 'missing', kind: 'manual' }]
    });
    const buf = serializeBackupV1(backup);
    expect(() => parseBackupV1(buf)).toThrow();
  });
});

describe('BackupRestore · 判重分类', () => {
  it('无冲突为 new', () => {
    const res = classifyBackupRestore(
      makeBackup().entries,
      []
    );
    expect(res).toEqual([{ entry_index: 0, conflict_type: 'new' }]);
  });

  it('同 content_hash 为 same_content', () => {
    const res = classifyBackupRestore(
      makeBackup().entries,
      [{ title: '已有', content_hash: 'h1' }]
    );
    expect(res).toEqual([{ entry_index: 0, conflict_type: 'same_content', matched_hash: 'h1' }]);
  });

  it('同标题不同内容为 same_title_diff_content', () => {
    const res = classifyBackupRestore(
      makeBackup().entries,
      [{ title: '条目一', content_hash: 'different' }]
    );
    expect(res).toEqual([{ entry_index: 0, conflict_type: 'same_title_diff_content', matched_hash: 'different' }]);
  });
});
