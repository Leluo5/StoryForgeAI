// ============================================================================
// M3c-3 知识库 · 大纲面板（T33）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §6.5、§5.4
//
// 职责：展示条目四维大纲（章节 / 情节节点 / 人物关系 / 故事线）。
//       no_chapters 降级：chapters 为空且 ready 时提示「未提取到章节」+ 重新提取。
//       outline_status=pending/structuring 时显示提取进度（progress 0-100）。
//       编辑保存走 OutlineEditor（patchEntry 乐观锁），重新提取走 restructureEntry。
// ============================================================================

import { Button, Spinner } from '@storyforge/ui';
import type { KnowledgeEntryDetail, KnowledgeEntryOutline } from '@storyforge/contracts';
import { OutlineEditor } from './outline-editor';

interface Props {
  detail: KnowledgeEntryDetail;
  /** 提取进度（0-100），pending/structuring 时提供 */
  progress?: number;
  /** 保存大纲（patchEntry { outline, expected_version }） */
  onSave?: (outline: KnowledgeEntryOutline, expectedVersion: number) => void | Promise<void>;
  /** 重新提取（restructureEntry 触发 outline 作业） */
  onRestructure?: (entryType?: KnowledgeEntryDetail['entry_type']) => void;
  /** 是否正在保存 */
  saving?: boolean;
}

const EMPTY_OUTLINE: KnowledgeEntryOutline = { chapters: [], plot_nodes: [], character_relations: [], story_lines: [] };

function isStructuring(status: KnowledgeEntryDetail['outline_status']): boolean {
  return status === 'pending';
}

/** 大纲面板（M3c-3 T33）。 */
export function OutlinePanel({ detail, progress, onSave, onRestructure, saving = false }: Props) {
  const { outline, outline_status, version } = detail;

  if (isStructuring(outline_status)) {
    return (
      <div className="outline-panel outline-panel--loading" role="status">
        <Spinner size="sm" />
        <p className="outline-panel__loading-text">提取中…{typeof progress === 'number' ? ` ${Math.round(progress)}%` : ''}</p>
      </div>
    );
  }

  if (!outline) {
    return (
      <div className="outline-panel outline-panel--empty">
        <p className="outline-panel__empty-text">暂无大纲。</p>
        {onRestructure && (
          <Button variant="secondary" size="sm" onClick={() => onRestructure(detail.entry_type)}>重新提取</Button>
        )}
      </div>
    );
  }

  const noChapters = outline.chapters.length === 0;

  return (
    <div className="outline-panel">
      {noChapters && (
        <div className="outline-panel__degraded" role="note">
          <p>未提取到章节（可能原文未按章节组织）。</p>
          {onRestructure && (
            <Button variant="secondary" size="sm" onClick={() => onRestructure(detail.entry_type)}>重新提取</Button>
          )}
        </div>
      )}

      <OutlineEditor
        outline={outline}
        version={version}
        {...(onSave ? { onSave } : {})}
        {...(saving ? { saving } : {})}
      />

      <section className="outline-dimension">
        <h4>情节节点</h4>
        {outline.plot_nodes.length === 0 ? (
          <p className="outline-dimension__empty">暂无情节节点。</p>
        ) : (
          <ul className="outline-dimension__list">
            {outline.plot_nodes.map((node, i) => (
              <li key={i} className="outline-dimension__item">
                <strong>{node.title}</strong>
                <span className="outline-dimension__meta">第 {node.chapter_index + 1} 章</span>
                {node.summary && <p className="outline-dimension__summary">{node.summary}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="outline-dimension">
        <h4>人物关系</h4>
        {outline.character_relations.length === 0 ? (
          <p className="outline-dimension__empty">暂无人物关系。</p>
        ) : (
          <ul className="outline-dimension__list">
            {outline.character_relations.map((rel, i) => (
              <li key={i} className="outline-dimension__item">
                <strong>{rel.source}</strong> <span>—</span> <strong>{rel.target}</strong>
                {rel.relation && <span className="outline-dimension__meta">（{rel.relation}）</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="outline-dimension">
        <h4>故事线</h4>
        {outline.story_lines.length === 0 ? (
          <p className="outline-dimension__empty">暂无故事线。</p>
        ) : (
          <ul className="outline-dimension__list">
            {outline.story_lines.map((line, i) => (
              <li key={i} className="outline-dimension__item">
                <strong>{line.name}</strong>
                <span className="outline-dimension__meta">
                  涉及 {line.chapter_indexes.length} 章
                </span>
                {line.description && <p className="outline-dimension__summary">{line.description}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** 导出空大纲常量供编辑器复用 */
export { EMPTY_OUTLINE };
