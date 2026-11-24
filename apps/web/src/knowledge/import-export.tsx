// ============================================================================
// M3c-3 知识库 · 导入导出面板（T35）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.6、§5.9
//
// 职责：Markdown 导出（范围：当前筛选 / 全部）；Markdown 导入两段式——
//       选择 .md 文件生成预览（preview_id + 统计 + 冲突），再选冲突策略
//       overwrite/rename/skip 提交。错误按 T04 错误码由上层映射后传入。
// ============================================================================

import { useState } from 'react';
import { Button } from '@storyforge/ui';
import type { KnowledgeConflictPolicy, KnowledgeImportPreviewResponse } from '@storyforge/contracts';

export type ExportRange = 'selection' | 'all';

const POLICY_OPTIONS: Array<{ value: KnowledgeConflictPolicy; label: string }> = [
  { value: 'overwrite', label: '覆盖' },
  { value: 'rename', label: '重命名' },
  { value: 'skip', label: '跳过' }
];

interface Props {
  scope: 'global' | 'work';
  /** 导出 Markdown（range：当前筛选 / 全部） */
  onExport?: (range: ExportRange) => void | Promise<void>;
  /** 选择文件生成导入预览（importPreview） */
  onImportPreview?: (files: File[]) => void | Promise<void>;
  /** 导入预览结果 */
  preview?: KnowledgeImportPreviewResponse;
  /** 提交导入（commitImport） */
  onImportCommit?: (opts: { preview_id: string; policy: KnowledgeConflictPolicy }) => void | Promise<void>;
  loading?: boolean;
  error?: string;
  committing?: boolean;
}

/** 导入导出面板（M3c-3 T35）。 */
export function ImportExport({
  scope,
  onExport,
  onImportPreview,
  preview,
  onImportCommit,
  loading = false,
  error,
  committing = false
}: Props) {
  const [range, setRange] = useState<ExportRange>('selection');
  const [policy, setPolicy] = useState<KnowledgeConflictPolicy>('overwrite');

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    onImportPreview?.(Array.from(files));
  };

  return (
    <div className="import-export">
      <section className="import-export__export" aria-label="Markdown 导出">
        <h4>Markdown 导出</h4>
        <div className="import-export__range" role="radiogroup" aria-label="导出范围">
          <button
            type="button"
            role="radio"
            aria-checked={range === 'selection'}
            onClick={() => setRange('selection')}
          >
            导出当前筛选
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={range === 'all'}
            onClick={() => setRange('all')}
          >
            导出全部
          </button>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => onExport?.(range)}
          disabled={loading || !onExport}
          loading={loading}
        >
          导出 Markdown
        </Button>
      </section>

      <section className="import-export__import" aria-label="Markdown 导入">
        <h4>Markdown 导入</h4>
        <label className="import-export__file" htmlFor={`import-files-${scope}`}>
          选择 Markdown 文件
        </label>
        <input
          id={`import-files-${scope}`}
          className="import-export__file-input"
          type="file"
          accept=".md,.markdown"
          multiple
          aria-label="选择 Markdown 文件"
          onChange={(e) => handleFiles(e.target.files)}
        />
        {preview && (
          <div className="import-export__preview">
            <p className="import-export__preview-summary" role="status">
              共 {preview.summary.total} 个文件
            </p>
            <ul className="import-export__preview-stats">
              <li>重复 {preview.summary.duplicate}</li>
              <li>同名冲突 {preview.summary.name_collision}</li>
              <li>新增 {preview.summary.new}</li>
              {preview.summary.failed > 0 && <li>失败 {preview.summary.failed}</li>}
            </ul>
            <div className="import-export__policy" role="radiogroup" aria-label="冲突策略">
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
            {onImportCommit && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => onImportCommit({ preview_id: preview.preview_id, policy })}
                disabled={committing}
                loading={committing}
              >
                确认导入
              </Button>
            )}
          </div>
        )}
      </section>

      {error && (
        <div className="import-export__error" role="alert">
          <p>{error}</p>
        </div>
      )}
    </div>
  );
}
