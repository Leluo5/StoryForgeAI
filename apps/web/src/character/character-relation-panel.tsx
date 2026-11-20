import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type JSX } from 'react';
import type { Character, CharacterRelation, CharacterRelationType, RelationLineStyle } from '@storyforge/contracts';
import { characterClient, type CharacterClient } from './character-client';
import { characterErrorMessage } from './character-state';
import './character-relation-panel.css';

interface Props {
  workId: string;
  characterId: string;
  /** 默认 characterClient；测试直接注入 mock */
  client?: CharacterClient;
  /** 传入则直接进入该关系的编辑态 */
  relationId?: string | null;
}

interface RelationForm {
  targetId: string;
  typeId: string;
  label: string;
  reverseLabel: string;
  color: string;
  lineStyle: RelationLineStyle;
  tag: string;
}

const EMPTY_FORM: RelationForm = {
  targetId: '',
  typeId: '',
  label: '',
  reverseLabel: '',
  color: '#3b82f6',
  lineStyle: 'solid',
  tag: ''
};

const LINE_STYLE_LABEL: Record<RelationLineStyle, string> = {
  solid: '实线',
  dashed: '虚线',
  dotted: '点线'
};

const LINE_STYLES: RelationLineStyle[] = ['solid', 'dashed', 'dotted'];

/** 角色关系面板：关系列表 + 新建/编辑/删除，方向由关系类型决定（T35） */
export function CharacterRelationPanel(props: Props): JSX.Element {
  const { workId, characterId, client = characterClient, relationId = null } = props;
  const baseId = `character-relation-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const [relations, setRelations] = useState<CharacterRelation[]>([]);
  const [types, setTypes] = useState<CharacterRelationType[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [form, setForm] = useState<RelationForm>(EMPTY_FORM);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const [relationList, typeList, characterList] = await Promise.all([
        client.listRelations(workId, { character_id: characterId, include_archived: true }),
        client.listRelationTypes(workId),
        client.listCharacters(workId, { limit: 100 })
      ]);
      setRelations(relationList);
      setTypes(typeList);
      setCharacters(characterList.items);
      setForm((prev) => (prev.typeId ? prev : { ...prev, typeId: typeList[0]?.id ?? '' }));
    } catch (cause) {
      setError(characterErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [client, characterId, workId]);

  useEffect(() => {
    void load();
  }, [load]);

  const nameById = useMemo(
    () => new Map(characters.map((character) => [character.id, character.name])),
    [characters]
  );

  const otherCharacterIdOf = useCallback(
    (relation: CharacterRelation): string =>
      relation.source_id === characterId ? relation.target_id : relation.source_id,
    [characterId]
  );

  const openCreate = useCallback((): void => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, typeId: types[0]?.id ?? '' });
    setFormOpen(true);
    setError('');
    setNotice('');
  }, [types]);

  const openEdit = useCallback(
    (relation: CharacterRelation): void => {
      setEditingId(relation.id);
      setForm({
        targetId: otherCharacterIdOf(relation),
        typeId: relation.type_id,
        label: relation.label,
        reverseLabel: relation.reverse_label ?? '',
        color: relation.color,
        lineStyle: relation.line_style,
        tag: relation.tag
      });
      setFormOpen(true);
      setError('');
      setNotice('');
    },
    [otherCharacterIdOf]
  );

  const closeForm = useCallback((): void => {
    setFormOpen(false);
    setEditingId(null);
    setForm({ ...EMPTY_FORM, typeId: types[0]?.id ?? '' });
  }, [types]);

  // relationId 仅在首次加载后应用一次，避免保存刷新后反复重开编辑态
  const initialEditApplied = useRef(false);
  useEffect(() => {
    if (initialEditApplied.current || !relationId) return;
    const relation = relations.find((item) => item.id === relationId);
    if (!relation) return;
    initialEditApplied.current = true;
    openEdit(relation);
  }, [openEdit, relationId, relations]);

  const editingRelation = editingId ? relations.find((relation) => relation.id === editingId) ?? null : null;
  const selectedType = types.find((type) => type.id === form.typeId) ?? null;
  const directed = selectedType?.directed ?? editingRelation?.directed ?? true;
  const targetName = form.targetId ? nameById.get(form.targetId) ?? '未知角色' : '未选择';

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    const label = form.label.trim();
    const tag = form.tag.trim();
    const reverseLabel = directed ? (form.reverseLabel.trim() === '' ? null : form.reverseLabel.trim()) : null;

    setSaving(true);
    setError('');
    setNotice('');
    try {
      if (editingId) {
        await client.updateRelation(workId, editingId, {
          reverse_label: reverseLabel,
          color: form.color,
          line_style: form.lineStyle,
          ...(label ? { label } : {}),
          ...(tag ? { tag } : {})
        });
        setNotice('关系已更新');
      } else {
        if (!form.targetId || !form.typeId) {
          setError('请选择对方角色与关系类型');
          return;
        }
        await client.createRelation(workId, {
          source_id: characterId,
          target_id: form.targetId,
          type_id: form.typeId,
          directed,
          color: form.color,
          line_style: form.lineStyle,
          reverse_label: reverseLabel,
          ...(label ? { label } : {}),
          ...(tag ? { tag } : {})
        });
        setNotice('关系已创建');
      }
      setFormOpen(false);
      setEditingId(null);
      setForm({ ...EMPTY_FORM, typeId: types[0]?.id ?? '' });
      await load();
    } catch (cause) {
      setError(characterErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  const confirmDelete = useCallback(async (): Promise<void> => {
    if (!pendingDelete || saving) return;
    const targetId = pendingDelete;
    setSaving(true);
    setError('');
    try {
      await client.deleteRelation(workId, targetId);
      setPendingDelete(null);
      if (editingId === targetId) {
        setEditingId(null);
        setFormOpen(false);
      }
      setNotice('关系已删除');
      await load();
    } catch (cause) {
      setPendingDelete(null);
      setError(characterErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }, [client, editingId, load, pendingDelete, saving, workId]);

  return (
    <section className="character-relation" aria-label="角色关系">
      <header className="character-relation-head">
        <h2 className="character-relation-title">角色关系</h2>
        <button type="button" className="character-relation-create" onClick={openCreate} disabled={loading}>
          新建关系
        </button>
      </header>

      {loading ? <p className="character-relation-status" role="status">正在加载关系…</p> : null}
      {error ? <p className="character-relation-error" role="alert">{error}</p> : null}
      {notice ? <p className="character-relation-notice" role="status">{notice}</p> : null}

      {!loading && relations.length === 0 ? (
        <p className="character-relation-empty" role="status">暂无关系</p>
      ) : null}

      {relations.length > 0 ? (
        <ul className="character-relation-list">
          {relations.map((relation) => {
            const otherId = otherCharacterIdOf(relation);
            const otherName = nameById.get(otherId) ?? '未知角色';
            const typeLabel = types.find((type) => type.id === relation.type_id)?.label ?? '未知类型';
            const direction = relation.directed
              ? relation.source_id === characterId ? '本角色 → 对方' : '对方 → 本角色'
              : '双向';
            return (
              <li key={relation.id} className="character-relation-item" data-relation-id={relation.id}>
                <button
                  type="button"
                  className="character-relation-open"
                  aria-label={`编辑与${otherName}的关系`}
                  onClick={() => openEdit(relation)}
                >
                  <span className="character-relation-other">{otherName}</span>
                  <span className="character-relation-type">{typeLabel}</span>
                  <span className="character-relation-label">{relation.label}</span>
                  <span className="character-relation-direction">{direction}</span>
                  <span
                    className="character-relation-color"
                    aria-hidden="true"
                    style={{ backgroundColor: relation.color }}
                  />
                  <span className="character-relation-color-text">{relation.color}</span>
                  <span className="character-relation-line">{LINE_STYLE_LABEL[relation.line_style]}</span>
                  <span className="character-relation-tag">{relation.tag}</span>
                </button>
                <button
                  type="button"
                  className="character-relation-delete"
                  aria-label={`删除与${otherName}的关系`}
                  onClick={() => setPendingDelete(relation.id)}
                >
                  删除
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {formOpen ? (
        <form
          className="character-relation-form"
          onSubmit={(event) => void handleSubmit(event)}
          aria-label={editingId ? '编辑关系' : '新建关系'}
        >
          <h3 className="character-relation-form-title">{editingId ? '编辑关系' : '新建关系'}</h3>

          {editingId ? (
            <p className="character-relation-field-static">对方角色：{targetName}</p>
          ) : (
            <p className="character-relation-field">
              <label htmlFor={`${baseId}-target`}>对方角色</label>
              <select
                id={`${baseId}-target`}
                value={form.targetId}
                onChange={(event) => setForm((prev) => ({ ...prev, targetId: event.target.value }))}
              >
                <option value="">请选择角色</option>
                {characters
                  .filter((character) => character.id !== characterId)
                  .map((character) => (
                    <option key={character.id} value={character.id}>{character.name}</option>
                  ))}
              </select>
            </p>
          )}

          <p className="character-relation-field">
            <label htmlFor={`${baseId}-type`}>关系类型</label>
            <select
              id={`${baseId}-type`}
              value={form.typeId}
              disabled={Boolean(editingId)}
              onChange={(event) => setForm((prev) => ({ ...prev, typeId: event.target.value }))}
            >
              {types.length === 0 ? <option value="">暂无关系类型</option> : null}
              {types.map((type) => (
                <option key={type.id} value={type.id}>{type.label}</option>
              ))}
            </select>
          </p>

          <p className="character-relation-direction-static">
            方向：{directed ? '有向（单向箭头）' : '无向（双向连线）'}
          </p>

          <p className="character-relation-field">
            <label htmlFor={`${baseId}-label`}>关系称谓</label>
            <input
              id={`${baseId}-label`}
              value={form.label}
              maxLength={40}
              onChange={(event) => setForm((prev) => ({ ...prev, label: event.target.value }))}
            />
          </p>

          {directed ? (
            <p className="character-relation-field">
              <label htmlFor={`${baseId}-reverse`}>反向称谓</label>
              <input
                id={`${baseId}-reverse`}
                value={form.reverseLabel}
                maxLength={40}
                onChange={(event) => setForm((prev) => ({ ...prev, reverseLabel: event.target.value }))}
              />
            </p>
          ) : null}

          <p className="character-relation-field">
            <label htmlFor={`${baseId}-color`}>颜色</label>
            <input
              id={`${baseId}-color`}
              type="color"
              value={form.color}
              onChange={(event) => setForm((prev) => ({ ...prev, color: event.target.value }))}
            />
          </p>

          <p className="character-relation-field">
            <label htmlFor={`${baseId}-line`}>线型</label>
            <select
              id={`${baseId}-line`}
              value={form.lineStyle}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, lineStyle: event.target.value as RelationLineStyle }))
              }
            >
              {LINE_STYLES.map((style) => (
                <option key={style} value={style}>{LINE_STYLE_LABEL[style]}</option>
              ))}
            </select>
          </p>

          <p className="character-relation-field">
            <label htmlFor={`${baseId}-tag`}>标签</label>
            <input
              id={`${baseId}-tag`}
              value={form.tag}
              maxLength={40}
              onChange={(event) => setForm((prev) => ({ ...prev, tag: event.target.value }))}
            />
          </p>

          <div className="character-relation-form-actions">
            <button type="submit" disabled={saving}>{editingId ? '保存修改' : '创建关系'}</button>
            <button type="button" onClick={closeForm}>取消</button>
          </div>
        </form>
      ) : null}

      {pendingDelete ? (
        <div className="character-relation-confirm">
          <div className="character-relation-confirm-card" role="alertdialog" aria-label="确认删除关系">
            <p>确认删除这条关系？删除后不可恢复。</p>
            <div className="character-relation-form-actions">
              <button type="button" onClick={() => setPendingDelete(null)}>取消</button>
              <button type="button" onClick={() => void confirmDelete()}>确认删除</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
