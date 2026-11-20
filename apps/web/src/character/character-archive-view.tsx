import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { Character } from '@storyforge/contracts';
import { characterClient, type CharacterClient } from './character-client';
import { characterErrorMessage } from './character-state';
import './character-archive-view.css';

interface ArchiveDetail {
  character: Character;
  relationCount: number;
  growthEventCount: number;
}

interface Props {
  workId: string;
  client?: CharacterClient;
  onSelect?: (characterId: string) => void;
  onRestored?: () => void;
}

/** 归档时间只用「日期 + 时分」，避免不同环境的本地化格式差异 */
function formatArchivedAt(value: string | null): string {
  if (!value) return '时间未知';
  return `${value.slice(0, 10)} ${value.slice(11, 16)}`;
}

/**
 * 归档确认视图（T38）：
 * - 只展示归档角色，资料只读；恢复走二次确认；
 * - 恢复后从列表移除并上报 onRestored；
 * - 明确不提供永久删除入口（归档可恢复、无永久清理）。
 */
export function CharacterArchiveView(props: Props): JSX.Element {
  const clientRef = useRef<CharacterClient>(props.client ?? characterClient);
  clientRef.current = props.client ?? characterClient;

  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ArchiveDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<Character | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [duplicateNames, setDuplicateNames] = useState<string[]>([]);
  const detailRequest = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await clientRef.current.listCharacters(props.workId, { status: 'archived', limit: 100 });
      setCharacters(result.items);
    } catch (cause) {
      setError(characterErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [props.workId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectCharacter = useCallback(
    async (character: Character) => {
      setSelectedId(character.id);
      props.onSelect?.(character.id);
      setDetailLoading(true);
      setError('');
      const requestId = detailRequest.current + 1;
      detailRequest.current = requestId;
      try {
        const result = await clientRef.current.getCharacter(props.workId, character.id);
        if (detailRequest.current !== requestId) return;
        setDetail({
          character: result.character,
          relationCount: result.relation_summary.total,
          growthEventCount: result.growth_event_count
        });
      } catch (cause) {
        if (detailRequest.current !== requestId) return;
        setError(characterErrorMessage(cause));
      } finally {
        if (detailRequest.current === requestId) setDetailLoading(false);
      }
    },
    [props.workId, props.onSelect]
  );

  const confirmRestore = useCallback(async () => {
    const target = pendingRestore;
    if (!target) return;
    setPendingRestore(null);
    setBusyId(target.id);
    setError('');
    setDuplicateNames([]);
    try {
      const result = await clientRef.current.restoreCharacter(props.workId, target.id);
      setCharacters((prev) => prev.filter((character) => character.id !== target.id));
      if (selectedId === target.id) {
        detailRequest.current += 1;
        setSelectedId(null);
        setDetail(null);
      }
      const names = result.duplicate_candidates.map((candidate) => candidate.name);
      setDuplicateNames(names);
      setNotice(`已恢复「${result.character.name}」`);
      props.onRestored?.();
    } catch (cause) {
      setError(characterErrorMessage(cause));
    } finally {
      setBusyId(null);
    }
  }, [pendingRestore, props.workId, props.onRestored, selectedId]);

  return (
    <section className="character-archive-view" aria-label="归档角色">
      <header className="character-archive-view__header">
        <h2>归档角色</h2>
        <p className="character-archive-view__hint">
          归档角色可随时恢复，系统不会永久删除角色数据。
        </p>
      </header>

      {error ? (
        <div className="character-archive-view__alert" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => { void load(); }}>重新加载</button>
        </div>
      ) : null}

      {notice ? (
        <p className="character-archive-view__notice" role="status">{notice}</p>
      ) : null}

      {duplicateNames.length > 0 ? (
        <p className="character-archive-view__duplicates" role="status">
          疑似重复：{duplicateNames.join('、')}
        </p>
      ) : null}

      {loading ? (
        <p className="character-archive-view__status" role="status">正在加载归档角色…</p>
      ) : characters.length === 0 ? (
        <p className="character-archive-view__status" role="status">暂无归档角色</p>
      ) : (
        <ul className="character-archive-view__list" aria-label="归档角色列表">
          {characters.map((character) => {
            const selected = character.id === selectedId;
            return (
              <li key={character.id} className="character-archive-view__item">
                <button
                  type="button"
                  className={`character-archive-view__row${selected ? ' is-selected' : ''}`}
                  aria-pressed={selected}
                  onClick={() => { void selectCharacter(character); }}
                >
                  <span className="character-archive-view__name">{character.name}</span>
                  <span className="character-archive-view__time">
                    归档于 {formatArchivedAt(character.archived_at)}
                  </span>
                </button>
                <button
                  type="button"
                  className="character-archive-view__restore"
                  disabled={busyId === character.id}
                  onClick={() => { setPendingRestore(character); }}
                >
                  恢复
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selectedId ? (
        <aside className="character-archive-view__detail" aria-label="归档角色详情">
          {detailLoading ? (
            <p role="status">正在读取角色详情…</p>
          ) : detail ? (
            <>
              <h3>{detail.character.name}</h3>
              <p className="character-archive-view__readonly">资料只读，恢复后可继续编辑。</p>
              <dl className="character-archive-view__facts">
                <dt>身份</dt>
                <dd>{detail.character.identity ?? '未填写'}</dd>
                <dt>阵营</dt>
                <dd>{detail.character.faction ?? '未填写'}</dd>
                <dt>职业</dt>
                <dd>{detail.character.occupation ?? '未填写'}</dd>
                <dt>关系</dt>
                <dd>{detail.relationCount} 条关系</dd>
                <dt>成长事件</dt>
                <dd>{detail.growthEventCount} 个成长事件</dd>
              </dl>
            </>
          ) : (
            <p role="status">选择一个归档角色查看详情。</p>
          )}
        </aside>
      ) : null}

      {pendingRestore ? (
        <div className="character-archive-view__confirm">
          <div
            className="character-archive-view__confirm-card"
            role="alertdialog"
            aria-label="确认恢复角色"
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              setPendingRestore(null);
            }}
          >
            <p>恢复「{pendingRestore.name}」后，该角色会回到使用中列表。</p>
            <div className="character-archive-view__confirm-actions">
              <button type="button" autoFocus onClick={() => setPendingRestore(null)}>取消</button>
              <button type="button" onClick={() => { void confirmRestore(); }}>确认恢复</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
