// ============================================================================
// M3c-3 知识库 · 备份恢复面板（T35）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.7、§5.9
//
// 职责：整库备份两段式——备份导出（createBackup → 下载产物）；恢复
//       preview→commit：选备份文件生成预览（preview_id + 三类统计 + 冲突），
//       再选合并策略 overwrite/rename/skip 提交。同内容/同名不同内容必须给
//       策略，否则服务端返回 409 KNOWLEDGE_RESTORE_NEEDS_RESOLUTION（上层映射）。
// ============================================================================

import { useState } from 'react';
import { Button } from '@storyforge/ui';
import type { KnowledgeConflictPolicy, KnowledgeRestorePreviewResponse } from '@storyforge/contracts';

const POLICY_OPTIONS: Array<{ value: KnowledgeConflictPolicy; label: string }> = [
  { value: 'overwrite', label: '覆盖' },
  { value: 'rename', label: '重命名' },
  { value: 'skip', label: '跳过' }
];

interface Props {
  scope: 'global' | 'work';
  /** 导出整库备份（createBackup） */
  onBackup?: (scope: 'global' | 'work') => void | Promise<void>;
  /** 选择备份文件生成恢复预览（restorePreview） */
  onRestorePreview?: (files: File[]) => void | Promise<void>;
  /** 恢复预览结果 */
  restorePreview?: KnowledgeRestorePreviewResponse;
  /** 提交恢复（restoreCommit） */
  onRestoreCommit?: (opts: { preview_id: string; policy: KnowledgeConflictPolicy }) => void | Promise<void>;
  loading?: boolean;
  error?: string;
  committing?: boolean;
}

/** 备份恢复面板（M3c-3 T35）。 */
export function BackupPanel({
  scope,
  onBackup,
  onRestorePreview,
  restorePreview,
  onRestoreCommit,
  loading = false,
  error,
  committing = false
}: Props) {
  const [policy, setPolicy] = useState<KnowledgeConflictPolicy>('overwrite');

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    onRestorePreview?.(Array.from(files));
  };

  return (
    <div className="backup-panel">
      <section className="backup-panel__export" aria-label="整库备份">
        <h4>整库备份</h4>
        <Button
          variant="primary"
          size="sm"
          onClick={() => onBackup?.(scope)}
          disabled={loading || !onBackup}
          loading={loading}
        >
          导出整库备份
        </Button>
      </section>

      <section className="backup-panel__restore" aria-label="整库恢复">
        <h4>整库恢复</h4>
        <label className="backup-panel__file" htmlFor={`backup-file-${scope}`}>
          选择备份文件
        </label>
        <input
          id={`backup-file-${scope}`}
          className="backup-panel__file-input"
          type="file"
          accept=".json.gz,.gz"
          aria-label="选择备份文件"
          onChange={(e) => handleFiles(e.target.files)}
        />
        {restorePreview && (
          <div className="backup-panel__preview">
            <p className="backup-panel__preview-summary" role="status">
              共 {restorePreview.summary.total} 条
            </p>
            <ul className="backup-panel__preview-stats">
              <li>同内容 {restorePreview.summary.same_content}</li>
              <li>同名不同内容 {restorePreview.summary.same_title_diff_content}</li>
              <li>新增 {restorePreview.summary.new}</li>
            </ul>
            <div className="backup-panel__policy" role="radiogroup" aria-label="合并策略">
              {POLICY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={policy === opt.value}
                  onClick={() => setPolicy(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {onRestoreCommit && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => onRestoreCommit({ preview_id: restorePreview.preview_id, policy })}
                disabled={committing}
                loading={committing}
              >
                确认恢复
              </Button>
            )}
          </div>
        )}
      </section>

      {error && (
        <div className="backup-panel__error" role="alert">
          <p>{error}</p>
        </div>
      )}
    </div>
  );
}
