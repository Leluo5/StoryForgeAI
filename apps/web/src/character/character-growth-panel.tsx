import { useCallback, useEffect, useId, useState, type FormEvent, type JSX } from 'react';
import type { CharacterGrowthEvent } from '@storyforge/contracts';
import { characterClient, type CharacterClient } from './character-client';
import { characterErrorMessage } from './character-state';
import './character-growth-panel.css';

// T36 成长线面板：时间序列表 + 新增/编辑（关联剧情节点与章节）+ 章节深链跳转
// 「返回后仍为角色页签与同一角色」由上层 URL 深链保持，组件不写 URL；
// 这里只保证 characterId 变化时重新加载。

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface GrowthFormState {
  title: string;
  content: string;
  eventTime: string;
  plotNodeId: string;
  chapterId: string;
}

const EMPTY_FORM: GrowthFormState = {
  title: '',
  content: '',
  eventTime: '',
  plotNodeId: '',
  chapterId: ''
};

/** 时间升序；event_time 为空的排最后（字符串比较，不解析日期） */
function sortGrowthEvents(events: CharacterGrowthEvent[]): CharacterGrowthEvent[] {
  return [...events].sort((a, b) => {
    if (a.event_time === b.event_time) return 0;
    if (a.event_time === null) return 1;
    if (b.event_time === null) return -1;
    if (a.event_time < b.event_time) return -1;
    if (a.event_time > b.event_time) return 1;
    return 0;
  });
}

function shortenId(value: string): string {
  return value.slice(0, 8);
}

export interface CharacterGrowthPanelProps {
  workId: string;
  characterId: string;
  client?: CharacterClient;
  /** 主控接入 navigate('/works/:workId/write/:chapterId?tab=roles&panel=role&characterId=...') */
  onOpenChapter?: ((chapterId: string, characterId: string) => void) | undefined;
}

export function CharacterGrowthPanel(props: CharacterGrowthPanelProps): JSX.Element {
  const { workId, characterId, client = characterClient, onOpenChapter } = props;
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const titleFieldId = `growth-title-${rawId}`;
  const contentFieldId = `growth-content-${rawId}`;
  const timeFieldId = `growth-time-${rawId}`;
  const plotFieldId = `growth-plot-${rawId}`;
  const chapterFieldId = `growth-chapter-${rawId}`;
  const deleteTextId = `growth-delete-${rawId}`;

  const [events, setEvents] = useState<CharacterGrowthEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [form, setForm] = useState<GrowthFormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CharacterGrowthEvent | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setNotice('');
    setWarnings([]);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setPendingDelete(null);
    client
      .listGrowthEvents(workId, characterId)
      .then((list) => {
        if (cancelled) return;
        setEvents(sortGrowthEvents(list));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(characterErrorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, workId, characterId]);

  const updateField = useCallback((patch: Partial<GrowthFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const beginEdit = useCallback((event: CharacterGrowthEvent) => {
    setEditingId(event.id);
    setForm({
      title: event.title,
      content: event.content,
      eventTime: event.event_time ?? '',
      plotNodeId: event.plot_node_id ?? '',
      chapterId: event.chapter_id ?? ''
    });
    setError('');
    setWarnings([]);
    setNotice('');
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError('');
  }, []);

  const handleSubmit = useCallback(
    async (submitEvent: FormEvent<HTMLFormElement>) => {
      submitEvent.preventDefault();
      setError('');
      const title = form.title.trim();
      if (!title) {
        setError('请填写成长事件标题');
        return;
      }
      const plotNodeId = form.plotNodeId.trim();
      if (plotNodeId && !UUID_PATTERN.test(plotNodeId)) {
        setError('剧情节点 ID 必须是合法的 UUID');
        return;
      }
      const chapterId = form.chapterId.trim();
      if (chapterId && !UUID_PATTERN.test(chapterId)) {
        setError('章节 ID 必须是合法的 UUID');
        return;
      }

      const payload = {
        title,
        content: form.content,
        event_time: form.eventTime.trim() ? form.eventTime.trim() : null,
        plot_node_id: plotNodeId ? plotNodeId : null,
        chapter_id: chapterId ? chapterId : null
      };

      setBusy(true);
      try {
        if (editingId) {
          const result = await client.updateGrowthEvent(workId, characterId, editingId, payload);
          setEvents((prev) =>
            sortGrowthEvents(prev.map((item) => (item.id === result.event.id ? result.event : item)))
          );
          setNotice(`已更新成长事件「${result.event.title}」`);
        } else {
          const result = await client.createGrowthEvent(workId, characterId, payload);
          setEvents((prev) => sortGrowthEvents([...prev, result.event]));
          // 节点缺失等 warning 必须对用户可见
          setWarnings(result.warnings);
          setNotice(`已新增成长事件「${result.event.title}」`);
        }
        setForm(EMPTY_FORM);
        setEditingId(null);
      } catch (cause) {
        setError(characterErrorMessage(cause));
      } finally {
        setBusy(false);
      }
    },
    [client, workId, characterId, form, editingId]
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    setBusy(true);
    setError('');
    try {
      await client.deleteGrowthEvent(workId, characterId, target.id);
      setEvents((prev) => prev.filter((item) => item.id !== target.id));
      setNotice(`已删除成长事件「${target.title}」`);
      if (editingId === target.id) {
        setEditingId(null);
        setForm(EMPTY_FORM);
      }
    } catch (cause) {
      setError(characterErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [client, workId, characterId, pendingDelete, editingId]);

  return (
    <section className="character-growth-panel" aria-label="角色成长线">
      <header className="character-growth-panel__header">
        <h2 className="character-growth-panel__title">成长线</h2>
        <p className="character-growth-panel__hint">事件按时间排序；可关联剧情节点与章节，并跳转到对应章节。</p>
      </header>

      {loading ? (
        <p className="character-growth-panel__status" role="status">
          正在加载成长线…
        </p>
      ) : null}
      {error ? (
        <p className="character-growth-panel__error" role="alert">
          {error}
        </p>
      ) : null}
      {warnings.length > 0 ? (
        <div className="character-growth-panel__warnings" role="status" aria-label="成长事件提示">
          <p>成长事件已保存，但有以下提示：</p>
          <ul>
            {warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {notice ? (
        <p className="character-growth-panel__notice" role="status">
          {notice}
        </p>
      ) : null}

      {!loading && !error && events.length === 0 ? (
        <p className="character-growth-panel__empty" role="status">
          还没有成长事件，新增后按时间顺序展示。
        </p>
      ) : null}

      {events.length > 0 ? (
        <ol className="character-growth-list" aria-label="成长事件时间线">
          {events.map((event) => (
            <li key={event.id} className="character-growth-item" data-growth-event={event.id}>
              <div className="character-growth-item__head">
                <h3>{event.title}</h3>
                <span className="character-growth-item__time">{event.event_time ?? '未标注时间'}</span>
              </div>
              {event.content ? <p className="character-growth-item__content">{event.content}</p> : null}
              <div className="character-growth-item__meta">
                {event.plot_node_id ? (
                  <span className="character-growth-item__node">
                    剧情节点：{event.plot_node_title ?? shortenId(event.plot_node_id)}
                  </span>
                ) : null}
                <span className="character-growth-item__chapter">
                  {event.chapter_id ? `章节：${shortenId(event.chapter_id)}` : '未关联章节'}
                </span>
              </div>
              <div className="character-growth-item__actions">
                <button type="button" onClick={() => beginEdit(event)} disabled={busy}>
                  编辑
                </button>
                <button type="button" onClick={() => setPendingDelete(event)} disabled={busy}>
                  删除
                </button>
                <button
                  type="button"
                  disabled={busy || !event.chapter_id}
                  title={event.chapter_id ? '在写作页打开该章节' : '该事件未关联章节'}
                  onClick={() => {
                    if (event.chapter_id) onOpenChapter?.(event.chapter_id, characterId);
                  }}
                >
                  跳转章节
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      <form className="character-growth-form" aria-label={editingId ? '编辑成长事件' : '新增成长事件'} onSubmit={handleSubmit}>
        <h3>{editingId ? '编辑成长事件' : '新增成长事件'}</h3>
        <div className="character-growth-form__row">
          <label htmlFor={titleFieldId}>标题</label>
          <input
            id={titleFieldId}
            value={form.title}
            maxLength={120}
            onChange={(changeEvent) => updateField({ title: changeEvent.target.value })}
          />
        </div>
        <div className="character-growth-form__row">
          <label htmlFor={contentFieldId}>内容</label>
          <textarea
            id={contentFieldId}
            value={form.content}
            rows={3}
            onChange={(changeEvent) => updateField({ content: changeEvent.target.value })}
          />
        </div>
        <div className="character-growth-form__row">
          <label htmlFor={timeFieldId}>时间</label>
          <input
            id={timeFieldId}
            value={form.eventTime}
            placeholder="如 第三卷·春"
            onChange={(changeEvent) => updateField({ eventTime: changeEvent.target.value })}
          />
        </div>
        <div className="character-growth-form__row">
          <label htmlFor={plotFieldId}>剧情节点 ID</label>
          <input
            id={plotFieldId}
            value={form.plotNodeId}
            placeholder="粘贴剧情节点 UUID"
            onChange={(changeEvent) => updateField({ plotNodeId: changeEvent.target.value })}
          />
        </div>
        <div className="character-growth-form__row">
          <label htmlFor={chapterFieldId}>章节 ID</label>
          <input
            id={chapterFieldId}
            value={form.chapterId}
            placeholder="粘贴章节 UUID"
            onChange={(changeEvent) => updateField({ chapterId: changeEvent.target.value })}
          />
        </div>
        <p className="character-growth-form__note">没有下拉数据源时手动填写 UUID；格式不合法会在保存前提示。</p>
        <div className="character-growth-form__actions">
          <button type="submit" disabled={busy}>
            {editingId ? '保存修改' : '新增事件'}
          </button>
          {editingId ? (
            <button type="button" onClick={cancelEdit} disabled={busy}>
              取消编辑
            </button>
          ) : null}
        </div>
      </form>

      {pendingDelete ? (
        <div className="character-growth-confirm">
          <div
            className="character-growth-confirm__card"
            role="alertdialog"
            aria-label="确认删除成长事件"
            aria-describedby={deleteTextId}
            onKeyDown={(keyEvent) => {
              if (keyEvent.key !== 'Escape') return;
              keyEvent.preventDefault();
              setPendingDelete(null);
            }}
          >
            <p id={deleteTextId}>删除「{pendingDelete.title}」后不可恢复，确认删除吗？</p>
            <div className="character-growth-confirm__actions">
              <button type="button" autoFocus onClick={() => setPendingDelete(null)}>
                取消
              </button>
              <button type="button" onClick={() => void confirmDelete()}>
                确认删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
