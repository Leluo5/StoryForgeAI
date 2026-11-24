// ============================================================================
// M3c-3 知识库 · 粘贴录入表单（T32）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §6.4
//
// 职责：手动粘贴录入（标题 + 正文 + 类型 + 标签）。前端校验：
//       标题必填 ≤200、正文必填 ≤20000、标签 ≤20 个且每个 ≤40 字符。
//       提交走 knowledgeClient.createEntry（同步建条目 + 入队结构化）。
//       409 KNOWLEDGE_ENTRY_DUPLICATE 由 knowledgeErrorMessage 映射为友好提示。
// ============================================================================

import { useState } from 'react';
import { Button, Input, Textarea } from '@storyforge/ui';
import type { KnowledgeEntryCreateRequest, KnowledgeScope } from '@storyforge/contracts';
import { knowledgeErrorMessage } from './knowledge-state';
import { knowledgeClient } from './knowledge-client';
import { TypeSelector, type KnowledgeTypeValue } from './type-selector';

const TITLE_MAX = 200;
const TEXT_MAX = 20_000;
const TAG_MAX = 20;
const TAG_NAME_MAX = 40;

interface Props {
  /** 当前库作用域 */
  scope: KnowledgeScope;
  /** 作品库时必须传入 workId */
  workId?: string;
  /** 创建成功后回调（返回新条目 id 供上层选中） */
  onCreated?: (entryId: string) => void;
  /** 提交失败回调（用于上层统一展示） */
  onError?: (message: string) => void;
}

/** 标签输入解析：逗号 / 顿号 / 换行分隔，去空白去重 */
export function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,，、\n]/)) {
    const tag = part.trim();
    if (!tag) continue;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** 粘贴录入表单（M3c-3 T32）。 */
export function EntryCreate({ scope, workId, onCreated, onError }: Props) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [typeValue, setTypeValue] = useState<KnowledgeTypeValue>('auto');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const titleError = title.length > TITLE_MAX ? `标题不能超过 ${TITLE_MAX} 字` : undefined;
  const textError = text.length > TEXT_MAX ? `正文不能超过 ${TEXT_MAX} 字` : undefined;
  const tags = parseTags(tagsRaw);
  const tagsError = tags.length > TAG_MAX ? `标签不能超过 ${TAG_MAX} 个` : undefined;
  const tagTooLong = tags.some((t) => t.length > TAG_NAME_MAX) ? `单个标签不能超过 ${TAG_NAME_MAX} 字` : undefined;

  const canSubmit = title.trim().length > 0 && text.trim().length > 0 && !titleError && !textError && !tagsError && !tagTooLong && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const payload: KnowledgeEntryCreateRequest = {
      scope,
      text,
      ...(workId ? { work_id: workId } : {}),
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(typeValue !== 'auto' ? { entry_type: typeValue } : {}),
      ...(tags.length > 0 ? { tags } : {})
    };
    try {
      const detail = await knowledgeClient.createEntry(payload);
      setTitle('');
      setText('');
      setTagsRaw('');
      setTypeValue('auto');
      onCreated?.(detail.id);
    } catch (cause) {
      const message = knowledgeErrorMessage(cause);
      setError(message);
      onError?.(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="entry-create" onSubmit={handleSubmit} noValidate>
      <div className="entry-create__fields">
        <Input
          label="标题"
          placeholder="素材标题"
          value={title}
          maxLength={TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
          {...(titleError ? { error: titleError } : {})}
        />
        <Textarea
          label="正文"
          placeholder="粘贴或输入素材正文…"
          value={text}
          maxLength={TEXT_MAX}
          rows={8}
          onChange={(e) => setText(e.target.value)}
          {...(textError ? { error: textError } : {})}
        />
        <div className="entry-create__counter" aria-live="polite">
          {text.length.toLocaleString()} / {TEXT_MAX.toLocaleString()} 字
        </div>
        <TypeSelector value={typeValue} onChange={setTypeValue} disabled={submitting} />
        <Input
          label="标签（可选，逗号分隔）"
          placeholder="世界观, 人物"
          value={tagsRaw}
          onChange={(e) => setTagsRaw(e.target.value)}
          {...(tagsError ? { error: tagsError } : tagTooLong ? { error: tagTooLong } : {})}
        />
      </div>
      {error && (
        <p className="entry-create__error" role="alert">{error}</p>
      )}
      <div className="entry-create__actions">
        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {submitting ? '录入中…' : '录入素材'}
        </Button>
      </div>
    </form>
  );
}
