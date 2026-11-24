import { useState } from 'react';
import { Button, Spinner } from '@storyforge/ui';
import type {
  KnowledgeEntryDetail,
  KnowledgeEntryStructured,
  KnowledgeArticleStructured,
  KnowledgePaperStructured,
  KnowledgeNovelStructured,
  KnowledgeInspirationStructured
} from '@storyforge/contracts';
import { EntryViewToggle, type KnowledgeEntryView } from './entry-view-toggle';

interface Props {
  detail: KnowledgeEntryDetail | null;
  loading: boolean;
  /** 版本冲突信息（409 VERSION_CONFLICT）：非 null 时展示版本提示 */
  versionConflict: { currentVersion: number } | null;
  onReload: () => void;
}

/** 五类型结构化分块渲染（M3c-3 T31） */
function StructuredBlocks({ structured }: { structured: KnowledgeEntryStructured }) {
  switch (structured.entry_type) {
    case 'article':
    case 'setting': {
      const s = structured as KnowledgeArticleStructured;
      return (
        <div className="structured-blocks">
          {s.sections.length > 0 && s.sections.map((sec, i) => (
            <section key={i} className="structured-block"><h4>{sec.heading}</h4><p>{sec.content}</p></section>
          ))}
          {s.key_points.length > 0 && (
            <section className="structured-block">
              <h4>核心观点</h4>
              <ul>{s.key_points.map((point, i) => <li key={i}>{point}</li>)}</ul>
            </section>
          )}
          {s.tags.length > 0 && <section className="structured-block"><h4>标签</h4><p>{s.tags.join('、')}</p></section>}
        </div>
      );
    }
    case 'paper': {
      const s = structured as KnowledgePaperStructured;
      const fields: Array<[string, string]> = [
        ['研究问题', s.research_question],
        ['方法', s.method],
        ['发现', s.findings],
        ['贡献', s.contributions],
        ['局限', s.limitations]
      ];
      return (
        <div className="structured-blocks">
          {fields.map(([label, text]) => text && (
            <section key={label} className="structured-block"><h4>{label}</h4><p>{text}</p></section>
          ))}
          {s.keywords.length > 0 && <section className="structured-block"><h4>关键词</h4><p>{s.keywords.join('、')}</p></section>}
        </div>
      );
    }
    case 'novel': {
      const s = structured as KnowledgeNovelStructured;
      return (
        <div className="structured-blocks">
          {s.plot_summary && <section className="structured-block"><h4>情节概要</h4><p>{s.plot_summary}</p></section>}
          {s.narrative_style && <section className="structured-block"><h4>叙事风格</h4><p>{s.narrative_style}</p></section>}
          {s.worldview && <section className="structured-block"><h4>世界观</h4><p>{s.worldview}</p></section>}
          {s.characters.length > 0 && (
            <section className="structured-block">
              <h4>角色（{s.characters.length}）</h4>
              <ul>{s.characters.map((c, i) => <li key={i}><strong>{c.name}</strong>（{c.role}）{c.description && <p className="muted">{c.description}</p>}</li>)}</ul>
            </section>
          )}
        </div>
      );
    }
    case 'inspiration': {
      const s = structured as KnowledgeInspirationStructured;
      return (
        <div className="structured-blocks">
          {s.completion && <section className="structured-block"><h4>上下文补全</h4><p>{s.completion}</p></section>}
          <section className="structured-block"><h4>独立灵感</h4><p>{s.independent ? '是' : '否'}</p></section>
          {s.matched_entry_ids.length > 0 && <section className="structured-block"><h4>匹配条目</h4><p>{s.matched_entry_ids.join('、')}</p></section>}
        </div>
      );
    }
    default:
      return null;
  }
}

/**
 * 条目详情（M3c-3 T31）：原文 / 结构化双视图 + 五类型分块 + 版本冲突提示。
 * 满足 F2 §8.1：切换保留阅读位置（视图内容不卸载，滚动由容器持有）；
 * 409 VERSION_CONFLICT 展示「重新加载」，不覆盖用户本地编辑。
 */
export function EntryDetail({ detail, loading, versionConflict, onReload }: Props) {
  const [view, setView] = useState<KnowledgeEntryView>('original');

  if (loading) {
    return <div className="entry-detail knowledge-loading" role="status"><Spinner label="正在加载详情…" /></div>;
  }
  if (!detail) {
    return <p className="entry-detail knowledge-empty" role="status">选择左侧条目查看详情。</p>;
  }

  const structuredDisabled = !detail.structured || detail.structure_status !== 'ready';

  return (
    <div className="entry-detail">
      <header className="entry-detail__header">
        <h3>{detail.title}</h3>
        <div className="entry-detail__meta">
          <span>{detail.entry_type}</span>
          <span>{detail.tags.join('、') || '无标签'}</span>
          {detail.favorite && <span>已收藏</span>}
          {detail.pinned && <span>已置顶</span>}
        </div>
      </header>

      {versionConflict && (
        <div className="entry-version-conflict" role="alert">
          <p>该条目已在别处被更新（服务器版本 {versionConflict.currentVersion}）。重新加载可获取最新内容；你当前的本地编辑不会丢失。</p>
          <Button variant="primary" size="sm" onClick={onReload}>重新加载</Button>
        </div>
      )}

      <EntryViewToggle value={view} structuredDisabled={structuredDisabled} onChange={setView} />

      {view === 'original' ? (
        <div className="entry-detail__original" data-view="original">
          {detail.original_text.split('\n').map((line, i) => (
            <p key={i} className="entry-original-line">{line || '\u00A0'}</p>
          ))}
        </div>
      ) : (
        <div className="entry-detail__structured" data-view="structured">
          {detail.structured ? <StructuredBlocks structured={detail.structured} /> : (
            <p className="knowledge-empty" role="status">暂无结构化结果。</p>
          )}
        </div>
      )}
    </div>
  );
}
