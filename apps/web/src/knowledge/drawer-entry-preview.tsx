// ============================================================================
// M3c-3 知识库 · 抽屉内简易详情（方案 D §3.3）
// 依据：docs/01-产品与设计/知识库工作台抽屉设计-方案D.md §3.3
//
// 职责：抽屉底部展开的轻量详情——标题 + 类型 + 标签 + 摘要（3–4 行）；
//       小说条目额外显示「大纲」折叠区（四维简化预览）；底部操作
//       「引用到当前作品」/「查看完整」/「编辑」，不跳转全页。
// ============================================================================

import { useState } from 'react';
import { Button, Spinner } from '@storyforge/ui';
import type { KnowledgeEntryDetail, KnowledgeEntryType } from '@storyforge/contracts';

const TYPE_LABELS: Record<KnowledgeEntryType, string> = {
  article: '文章',
  paper: '论文',
  novel: '小说',
  inspiration: '灵感',
  setting: '设定集'
};

/** 摘要预览：原文前 4 行（`-webkit-line-clamp: 4` 负责视觉截断） */
function previewText(detail: KnowledgeEntryDetail): string {
  return detail.original_text.split('\n').slice(0, 4).join('\n').trim();
}

/** 小说四维大纲简化预览（章节 + 情节节点 + 人物关系 + 故事线） */
function OutlinePreview({ detail }: { detail: KnowledgeEntryDetail }) {
  const [open, setOpen] = useState(false);
  const outline = detail.outline;
  if (!outline) return null;

  return (
    <div className="kb-drawer__outline">
      <button
        type="button"
        className="kb-drawer__outline-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        大纲（{outline.chapters.length} 章 / {outline.plot_nodes.length} 节点 / {outline.character_relations.length} 关系 / {outline.story_lines.length} 故事线）
      </button>
      {open && (
        <div className="kb-drawer__outline-body">
          {outline.chapters.length > 0 && (
            <>
              <p className="kb-drawer__outline-heading">章节</p>
              {outline.chapters.slice(0, 5).map((chapter) => (
                <p key={chapter.title}>{chapter.title}</p>
              ))}
            </>
          )}
          {outline.plot_nodes.length > 0 && (
            <>
              <p className="kb-drawer__outline-heading">情节节点</p>
              {outline.plot_nodes.slice(0, 5).map((node, index) => (
                <p key={`${node.chapter_index}-${index}`}>第{node.chapter_index + 1}章 · {node.title}</p>
              ))}
            </>
          )}
          {outline.character_relations.length > 0 && (
            <>
              <p className="kb-drawer__outline-heading">人物关系</p>
              {outline.character_relations.slice(0, 5).map((relation, index) => (
                <p key={`${index}-${relation.source}`}>{relation.source} — {relation.relation} — {relation.target}</p>
              ))}
            </>
          )}
          {outline.story_lines.length > 0 && (
            <>
              <p className="kb-drawer__outline-heading">故事线</p>
              {outline.story_lines.slice(0, 5).map((line) => <p key={line.name}>{line.name}</p>)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface Props {
  detail: KnowledgeEntryDetail | null;
  loading: boolean;
  error: string | null;
  /** 无作品上下文时禁用「引用到当前作品」 */
  canReference: boolean;
  referencing: boolean;
  onClose: () => void;
  onReference: () => void;
  /** 跳转方案 C 全页并定位该条目 */
  onOpenFull: () => void;
  onEdit: () => void;
}

/** 抽屉内简易详情（方案 D §3.3），不跳转全页。 */
export function DrawerEntryPreview({
  detail,
  loading,
  error,
  canReference,
  referencing,
  onClose,
  onReference,
  onOpenFull,
  onEdit
}: Props) {
  if (loading) {
    return (
      <div className="kb-drawer__preview" role="status">
        <Spinner label="正在加载详情…" />
      </div>
    );
  }
  if (!detail) return null;
  if (error && !detail.original_text) {
    return (
      <div className="kb-drawer__preview">
        <p className="kb-drawer__preview-error" role="alert">{error}</p>
      </div>
    );
  }

  const summary = previewText(detail);

  return (
    <section className="kb-drawer__preview" aria-label="条目简易详情">
      <div className="kb-drawer__preview-head">
        <h3 className="kb-drawer__preview-title">{detail.title || '未命名条目'}</h3>
        <button type="button" className="kb-drawer__preview-close" onClick={onClose} aria-label="收起详情">
          ✕
        </button>
      </div>
      <div className="kb-drawer__preview-meta">
        <span>{TYPE_LABELS[detail.entry_type] ?? detail.entry_type}</span>
        <span>更新 {new Date(detail.updated_at).toLocaleDateString('zh-CN')}</span>
        {detail.tags.length > 0 && <span>{detail.tags.join('、')}</span>}
      </div>
      {summary ? (
        <p className="kb-drawer__preview-summary">{summary}</p>
      ) : (
        <p className="kb-drawer__preview-summary">暂无正文预览。</p>
      )}
      {detail.entry_type === 'novel' && <OutlinePreview detail={detail} />}
      {error && <p className="kb-drawer__preview-error" role="alert">{error}</p>}
      <div className="kb-drawer__preview-actions">
        <Button
          variant="primary"
          size="sm"
          disabled={!canReference}
          loading={referencing}
          onClick={onReference}
        >
          引用到当前作品
        </Button>
        <Button variant="ghost" size="sm" onClick={onOpenFull}>查看完整</Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={detail.ref_status === 'source_deleted' || detail.ref_status === 'invalid'}
          onClick={onEdit}
        >
          编辑
        </Button>
      </div>
    </section>
  );
}