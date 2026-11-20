import { useCallback, useEffect, useId, useState, type JSX } from 'react';
import type {
  AiDraftStatus,
  AiItemKind,
  AiItemRef,
  AiItemStatus,
  CharacterAiCandidateItem,
  CharacterAiDraft,
  DuplicateResolution
} from '@storyforge/contracts';
import { characterClient, type CharacterClient } from './character-client';
import { characterErrorMessage } from './character-state';
import './character-ai-preview.css';

// T37 AI 候选预览：草稿进度 + 角色/关系/成长/合并分组 + 疑似重复决策 + 逐条/批量确认

const DRAFT_STATUS_LABEL: Record<AiDraftStatus, string> = {
  pending: '生成中',
  succeeded: '已生成',
  failed: '生成失败',
  committed: '已确认',
  discarded: '已丢弃'
};

const ITEM_STATUS_LABEL: Record<AiItemStatus, string> = {
  pending: '待处理',
  confirmed: '已确认',
  rejected: '已拒绝',
  skipped: '已跳过'
};

const RESOLUTION_LABEL: Record<DuplicateResolution, string> = {
  create: '创建新角色',
  merge: '合并到已有角色',
  keep_independent: '保持独立'
};

const GROUPS: { kind: AiItemKind; label: string }[] = [
  { kind: 'character', label: '角色' },
  { kind: 'relation', label: '关系' },
  { kind: 'growth', label: '成长' },
  { kind: 'merge', label: '合并' }
];

type CandidateItem = CharacterAiCandidateItem;
type ConfirmInput = Parameters<CharacterClient['confirmAiItem']>[3];
type BatchInput = Parameters<CharacterClient['confirmAiBatch']>[2];
type BatchResolution = NonNullable<BatchInput['resolutions']>[number];

function shortenId(value: string): string {
  return value.slice(0, 8);
}

function compareDraftDesc(a: CharacterAiDraft, b: CharacterAiDraft): number {
  if (a.created_at === b.created_at) return 0;
  return a.created_at < b.created_at ? 1 : -1;
}

export interface CharacterAiPreviewProps {
  workId: string;
  chapterId?: string | null;
  client?: CharacterClient;
  /** 主控在确认成功后刷新 board */
  onCommitted?: (() => void) | undefined;
}

export function CharacterAiPreview(props: CharacterAiPreviewProps): JSX.Element {
  const { workId, chapterId = null, client = characterClient, onCommitted } = props;
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const batchHintId = `ai-batch-hint-${rawId}`;

  const [draft, setDraft] = useState<CharacterAiDraft | null>(null);
  const [items, setItems] = useState<CandidateItem[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [modes, setModes] = useState<Record<string, DuplicateResolution>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});

  // 角色名映射：失败只降级为 id 前 8 位，不阻塞页面
  useEffect(() => {
    let cancelled = false;
    client
      .listCharacters(workId, { limit: 100 })
      .then((result) => {
        if (cancelled) return;
        setNames(new Map(result.items.map((character) => [character.id, character.name])));
      })
      .catch(() => {
        if (!cancelled) setNames(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [client, workId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setNotice('');
    setSelectedIds([]);
    setModes({});
    setTargets({});
    (async () => {
      try {
        const drafts = await client.listAiDrafts(workId);
        const sorted = [...drafts].sort(compareDraftDesc);
        const scoped = chapterId ? sorted.find((entry) => entry.input_chapter_id === chapterId) : undefined;
        const target = scoped ?? sorted[0];
        if (!target) {
          if (!cancelled) {
            setDraft(null);
            setItems([]);
          }
          return;
        }
        const detail = await client.getAiDraft(workId, target.id);
        if (cancelled) return;
        setDraft(detail.draft);
        setItems(detail.items);
      } catch (cause) {
        if (!cancelled) setError(characterErrorMessage(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workId, chapterId]);

  const referenceName = useCallback(
    (ref: AiItemRef): string => {
      if (ref.kind === 'existing') return names.get(ref.id) ?? shortenId(ref.id);
      const candidate = items.find((entry) => entry.id === ref.id);
      if (candidate && candidate.kind === 'character') return candidate.payload.name;
      const index = items.findIndex((entry) => entry.id === ref.id);
      return index >= 0 ? `候选 #${index + 1}` : shortenId(ref.id);
    },
    [names, items]
  );

  const candidateLabel = useCallback(
    (item: CandidateItem): string => {
      switch (item.kind) {
        case 'character':
          return item.payload.name;
        case 'relation':
          return `${referenceName(item.payload.source_ref)} ${item.payload.label} ${referenceName(item.payload.target_ref)}`;
        case 'growth':
          return item.payload.title;
        case 'merge':
          return `合并 ${referenceName(item.payload.source_ref)} → ${referenceName(item.payload.target_ref)}`;
      }
      return '';
    },
    [referenceName]
  );

  /** 已选决策；疑似重复未选模式（或 merge 未选目标）时返回 null */
  const resolvedMode = useCallback(
    (item: CandidateItem): DuplicateResolution | null => {
      if (item.suspected_duplicates.length === 0) return null;
      const mode = modes[item.id];
      if (!mode) return null;
      if (mode === 'merge' && !targets[item.id]) return null;
      return mode;
    },
    [modes, targets]
  );

  const canConfirm = useCallback(
    (item: CandidateItem): boolean => {
      if (item.status !== 'pending') return false;
      if (item.suspected_duplicates.length === 0) return true;
      return resolvedMode(item) !== null;
    },
    [resolvedMode]
  );

  const clearResolution = useCallback((itemId: string) => {
    setModes((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
    setTargets((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
  }, []);

  const confirmItem = useCallback(
    async (item: CandidateItem) => {
      if (!draft || !canConfirm(item)) return;
      const mode = resolvedMode(item);
      const target = targets[item.id];
      let input: ConfirmInput = {};
      if (mode === 'merge' && target) input = { mode, target_character_id: target };
      else if (mode) input = { mode };

      setBusy(true);
      setError('');
      try {
        const result = await client.confirmAiItem(workId, draft.id, item.id, input);
        setItems((prev) => prev.map((entry) => (entry.id === result.item.id ? result.item : entry)));
        setSelectedIds((prev) => prev.filter((id) => id !== item.id));
        clearResolution(item.id);
        setNotice('候选已确认');
        onCommitted?.();
      } catch (cause) {
        setError(characterErrorMessage(cause));
      } finally {
        setBusy(false);
      }
    },
    [draft, workId, client, canConfirm, resolvedMode, targets, clearResolution, onCommitted]
  );

  const rejectItem = useCallback(
    async (item: CandidateItem) => {
      if (!draft || item.status !== 'pending') return;
      setBusy(true);
      setError('');
      try {
        const result = await client.rejectAiItem(workId, draft.id, item.id);
        setItems((prev) => prev.map((entry) => (entry.id === result.item.id ? result.item : entry)));
        setSelectedIds((prev) => prev.filter((id) => id !== item.id));
        clearResolution(item.id);
        setNotice('候选已拒绝，正式版图未改变');
        onCommitted?.();
      } catch (cause) {
        setError(characterErrorMessage(cause));
      } finally {
        setBusy(false);
      }
    },
    [draft, workId, client, clearResolution, onCommitted]
  );

  const pendingItems = items.filter((item) => item.status === 'pending');
  const selectedItems = pendingItems.filter((item) => selectedIds.includes(item.id));
  const allSelected = pendingItems.length > 0 && selectedIds.length === pendingItems.length;
  const unresolvedSelected = selectedItems.filter((item) => !canConfirm(item));
  const batchReady = selectedItems.length > 0 && unresolvedSelected.length === 0;

  const toggleAll = useCallback(() => {
    setSelectedIds(allSelected ? [] : pendingItems.map((item) => item.id));
  }, [allSelected, pendingItems]);

  const toggleSelect = useCallback((itemId: string) => {
    setSelectedIds((prev) => (prev.includes(itemId) ? prev.filter((id) => id !== itemId) : [...prev, itemId]));
  }, []);

  const confirmBatch = useCallback(async () => {
    if (!draft || !batchReady || selectedItems.length === 0) return;
    const resolutions: BatchResolution[] = [];
    for (const item of selectedItems) {
      const mode = resolvedMode(item);
      if (!mode) continue;
      const target = targets[item.id];
      if (mode === 'merge') {
        if (!target) continue;
        resolutions.push({ item_id: item.id, action: mode, target_character_id: target });
      } else {
        resolutions.push({ item_id: item.id, action: mode });
      }
    }
    const itemIds = selectedItems.map((item) => item.id);
    const input: BatchInput = resolutions.length > 0 ? { item_ids: itemIds, resolutions } : { item_ids: itemIds };

    setBusy(true);
    setError('');
    try {
      const result = await client.confirmAiBatch(workId, draft.id, input);
      const confirmedIds = new Set(itemIds);
      setItems((prev) =>
        prev.map((entry) => (confirmedIds.has(entry.id) ? { ...entry, status: 'confirmed' as const } : entry))
      );
      setSelectedIds([]);
      setNotice(`已批量确认 ${result.confirmed} 条候选`);
      onCommitted?.();
    } catch (cause) {
      setError(characterErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [draft, batchReady, selectedItems, resolvedMode, targets, workId, client, onCommitted]);

  const renderItem = (item: CandidateItem): JSX.Element => {
    const label = candidateLabel(item);
    const statusLabel = ITEM_STATUS_LABEL[item.status];
    const isPending = item.status === 'pending';
    const mode = modes[item.id];
    const target = targets[item.id] ?? '';

    return (
      <li key={item.id} className="character-ai-item" data-ai-item={item.id} data-ai-status={item.status}>
        <div className="character-ai-item__head">
          {isPending ? (
            <input
              type="checkbox"
              aria-label={`选择 ${label}`}
              checked={selectedIds.includes(item.id)}
              onChange={() => toggleSelect(item.id)}
            />
          ) : null}
          <span className="character-ai-item__label">{label}</span>
          <span className={`character-ai-item__status is-${item.status}`}>{statusLabel}</span>
        </div>

        {item.suspected_duplicates.length > 0 ? (
          <fieldset className="character-ai-item__duplicates">
            <legend>{label} 疑似与已有角色重复，请选择处理方式</legend>
            {(['create', 'merge', 'keep_independent'] as const).map((option) => (
              <label key={option}>
                <input
                  type="radio"
                  name={`duplicate-${item.id}`}
                  value={option}
                  checked={mode === option}
                  disabled={!isPending || busy}
                  onChange={() => setModes((prev) => ({ ...prev, [item.id]: option }))}
                />
                {RESOLUTION_LABEL[option]}
              </label>
            ))}
            {mode === 'merge' ? (
              <label>
                合并目标
                <select
                  aria-label={`${label} 的合并目标`}
                  value={target}
                  disabled={!isPending || busy}
                  onChange={(changeEvent) =>
                    setTargets((prev) => ({ ...prev, [item.id]: changeEvent.target.value }))
                  }
                >
                  <option value="">请选择合并目标</option>
                  {item.suspected_duplicates.map((duplicate) => (
                    <option key={duplicate.character_id} value={duplicate.character_id}>
                      {duplicate.name}（{duplicate.matched_on === 'name' ? '名称相同' : '别名相同'}）
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </fieldset>
        ) : null}

        <div className="character-ai-item__actions">
          {isPending ? (
            <>
              <button type="button" disabled={busy || !canConfirm(item)} onClick={() => void confirmItem(item)}>
                确认「{label}」
              </button>
              <button type="button" disabled={busy} onClick={() => void rejectItem(item)}>
                拒绝「{label}」
              </button>
            </>
          ) : (
            <button type="button" disabled>
              {statusLabel}
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <section className="character-ai-preview" aria-label="AI 候选预览">
      <header className="character-ai-preview__header">
        <h2 className="character-ai-preview__title">AI 候选预览</h2>
        <p className="character-ai-preview__hint">候选需逐条或批量确认后才写入正式版图；拒绝不会改变正式版图。</p>
      </header>

      {loading ? (
        <p className="character-ai-preview__status" role="status">
          正在加载 AI 候选…
        </p>
      ) : null}
      {error ? (
        <p className="character-ai-preview__error" role="alert">
          {error}
        </p>
      ) : null}
      {draft ? (
        <p className="character-ai-preview__progress" role="status">
          草稿进度：{DRAFT_STATUS_LABEL[draft.status]}（共 {items.length} 条候选）
        </p>
      ) : null}
      {draft && draft.status === 'failed' ? (
        <p className="character-ai-preview__error" role="alert">
          草稿生成失败，请重新生成候选。
        </p>
      ) : null}
      {notice ? (
        <p className="character-ai-preview__notice" role="status">
          {notice}
        </p>
      ) : null}

      {!loading && !error && !draft ? (
        <p className="character-ai-preview__empty" role="status">
          暂无 AI 候选草稿，请先在写作页生成候选。
        </p>
      ) : null}
      {!loading && draft && items.length === 0 ? (
        <p className="character-ai-preview__empty" role="status">
          本次没有可确认的候选。
        </p>
      ) : null}

      {pendingItems.length > 0 ? (
        <div className="character-ai-batch" role="group" aria-label="批量确认">
          <button type="button" onClick={toggleAll} disabled={busy}>
            {allSelected ? '取消全选' : '全选待处理候选'}
          </button>
          <span className="character-ai-batch__count">
            已选 {selectedItems.length} / {pendingItems.length} 条
          </span>
          <button
            type="button"
            disabled={busy || !batchReady}
            aria-describedby={batchHintId}
            onClick={() => void confirmBatch()}
          >
            批量确认所选
          </button>
        </div>
      ) : null}
      <p id={batchHintId} className="character-ai-batch__hint">
        {unresolvedSelected.length > 0
          ? '选中的疑似重复候选需先选择处理方式，才能批量确认。'
          : '只勾选待处理条目；已确认或已拒绝的条目无法重复提交。'}
      </p>

      {GROUPS.map((group) => {
        const groupItems = items.filter((item) => item.kind === group.kind);
        if (groupItems.length === 0) return null;
        return (
          <section
            key={group.kind}
            className="character-ai-group"
            aria-label={`${group.label}候选`}
            data-ai-group={group.kind}
          >
            <h3 className="character-ai-group__title">
              {group.label}候选（{groupItems.length}）
            </h3>
            <ul className="character-ai-group__list">{groupItems.map(renderItem)}</ul>
          </section>
        );
      })}
    </section>
  );
}
