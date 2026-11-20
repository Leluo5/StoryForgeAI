import { useCallback, useId, useMemo, useState, type FormEvent, type JSX } from 'react';
import type { CharacterBoardResponse, CharacterDossier, CharacterRelationType } from '@storyforge/contracts';
import type { CharacterClient } from './character-client';
import { characterErrorMessage } from './character-state';

type BoardCharacter = CharacterBoardResponse['characters'][number];

interface Props {
  workId: string;
  viewId: string | null;
  client: CharacterClient;
  characters: BoardCharacter[];
  /** 创建成功后的刷新回调（board / 视图成员可能同时变化） */
  onCreated: () => void | Promise<void>;
}

interface DossierForm {
  name: string;
  identity: string;
  age: string;
  gender: string;
  country_region: string;
  faith: string;
  faction: string;
  race: string;
  occupation: string;
  age_band: string;
  personality: string;
  experience: string;
}

interface RelationForm {
  sourceId: string;
  targetId: string;
  typeId: string;
  label: string;
  tag: string;
}

type DialogMode = 'create' | 'relation' | null;

const EMPTY_FORM: DossierForm = {
  name: '',
  identity: '',
  age: '',
  gender: '',
  country_region: '',
  faith: '',
  faction: '',
  race: '',
  occupation: '',
  age_band: '',
  personality: '',
  experience: ''
};

const EMPTY_RELATION: RelationForm = { sourceId: '', targetId: '', typeId: '', label: '', tag: '' };

const DIMENSION_FIELDS: { key: keyof DossierForm; label: string }[] = [
  { key: 'country_region', label: '国家/地域' },
  { key: 'faith', label: '信仰' },
  { key: 'faction', label: '阵营' },
  { key: 'race', label: '种族' },
  { key: 'occupation', label: '职业' },
  { key: 'age_band', label: '年龄段' }
];

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function dossierToForm(dossier: CharacterDossier): DossierForm {
  return {
    name: dossier.name,
    identity: dossier.identity ?? '',
    age: dossier.age === null ? '' : String(dossier.age),
    gender: dossier.gender ?? '',
    country_region: dossier.country_region ?? '',
    faith: dossier.faith ?? '',
    faction: dossier.faction ?? '',
    race: dossier.race ?? '',
    occupation: dossier.occupation ?? '',
    age_band: dossier.age_band ?? '',
    personality: dossier.personality,
    experience: dossier.experience
  };
}

/** 角色版图工具栏快捷入口：新建角色 / 随机资料 / 建关系（M3c-2 L5 遗留体验项） */
export function CharacterCreateTools(props: Props): JSX.Element {
  const { workId, viewId, client, characters, onCreated } = props;
  const baseId = `character-create-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const [mode, setMode] = useState<DialogMode>(null);
  const [form, setForm] = useState<DossierForm>(EMPTY_FORM);
  const [relation, setRelation] = useState<RelationForm>(EMPTY_RELATION);
  const [relationTypes, setRelationTypes] = useState<CharacterRelationType[]>([]);
  const [loadingTypes, setLoadingTypes] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const resetFeedback = useCallback(() => {
    setError('');
    setNotice('');
  }, []);

  const openCreate = useCallback(() => {
    resetFeedback();
    setForm(EMPTY_FORM);
    setMode('create');
  }, [resetFeedback]);

  const closeDialog = useCallback(() => {
    setMode(null);
    setForm(EMPTY_FORM);
    setRelation(EMPTY_RELATION);
    resetFeedback();
  }, [resetFeedback]);

  const handleRandom = useCallback(async () => {
    setSaving(true);
    resetFeedback();
    try {
      const { dossier } = await client.randomDossier(workId);
      setForm(dossierToForm(dossier));
      setMode('create');
      setNotice('已生成随机资料，可修改后保存');
    } catch (cause) {
      setError(characterErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }, [client, resetFeedback, workId]);

  const handleCreateSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const name = form.name.trim();
    if (!name) {
      setError('请填写角色名称');
      return;
    }
    const ageText = form.age.trim();
    const age = ageText === '' ? null : Number(ageText);
    if (age !== null && !Number.isFinite(age)) {
      setError('年龄需为数字');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const created = await client.createCharacter(workId, {
        name,
        identity: blankToNull(form.identity),
        age,
        gender: blankToNull(form.gender),
        personality: form.personality,
        experience: form.experience,
        country_region: blankToNull(form.country_region),
        faith: blankToNull(form.faith),
        faction: blankToNull(form.faction),
        race: blankToNull(form.race),
        occupation: blankToNull(form.occupation),
        age_band: blankToNull(form.age_band)
      });
      if (viewId) {
        await client.addViewMembers(workId, viewId, [created.id]);
      }
      setMode(null);
      setForm(EMPTY_FORM);
      setNotice(`已创建角色：${created.name}`);
      await onCreated();
    } catch (cause) {
      setError(characterErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }, [client, form, onCreated, saving, viewId, workId]);

  const openRelation = useCallback(async () => {
    resetFeedback();
    setRelation(EMPTY_RELATION);
    setMode('relation');
    if (relationTypes.length > 0) {
      setRelation((prev) => ({ ...prev, typeId: relationTypes[0]!.id }));
      return;
    }
    setLoadingTypes(true);
    try {
      const types = await client.listRelationTypes(workId);
      setRelationTypes(types);
      setRelation((prev) => ({ ...prev, typeId: prev.typeId || types[0]?.id || '' }));
    } catch (cause) {
      setError(characterErrorMessage(cause));
    } finally {
      setLoadingTypes(false);
    }
  }, [client, relationTypes, resetFeedback, workId]);

  const selectedType = useMemo(
    () => relationTypes.find((type) => type.id === relation.typeId) ?? null,
    [relation.typeId, relationTypes]
  );

  const handleRelationSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    if (!relation.sourceId || !relation.targetId) {
      setError('请选择关系两端角色');
      return;
    }
    if (relation.sourceId === relation.targetId) {
      setError('关系两端不能是同一角色');
      return;
    }
    if (!relation.typeId) {
      setError('请选择关系类型');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const result = await client.createRelation(workId, {
        source_id: relation.sourceId,
        target_id: relation.targetId,
        type_id: relation.typeId,
        directed: selectedType?.directed,
        ...(relation.label.trim() ? { label: relation.label.trim() } : {}),
        ...(relation.tag.trim() ? { tag: relation.tag.trim() } : {})
      });
      setMode(null);
      setRelation(EMPTY_RELATION);
      setNotice(result.created ? '关系已创建' : '关系已存在，未重复创建');
      await onCreated();
    } catch (cause) {
      setError(characterErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }, [client, onCreated, relation, saving, selectedType, workId]);

  return (
    <>
      <div className="character-toolbar-group" role="group" aria-label="角色快捷操作">
        <button type="button" onClick={openCreate} disabled={saving}>新建角色</button>
        <button type="button" onClick={() => void handleRandom()} disabled={saving}>随机资料</button>
        <button type="button" onClick={() => void openRelation()} disabled={saving || characters.length < 2}>建关系</button>
      </div>
      {!mode && notice ? <p className="character-notice" role="status">{notice}</p> : null}
      {mode ? (
        <div className="character-create-dialog" role="dialog" aria-modal="true" aria-label={mode === 'create' ? '新建角色' : '建关系'}>
          <div className="character-create-dialog__head">
            <h3>{mode === 'create' ? '新建角色' : '建关系'}</h3>
            <button type="button" onClick={closeDialog}>关闭</button>
          </div>
          {error ? <p className="character-error" role="alert">{error}</p> : null}
          {notice ? <p className="character-notice" role="status">{notice}</p> : null}
          {mode === 'create' ? (
            <form className="character-create-form" onSubmit={(event) => void handleCreateSubmit(event)} aria-label="新建角色表单">
              <p className="character-create-field">
                <label htmlFor={`${baseId}-name`}>名称</label>
                <input
                  id={`${baseId}-name`}
                  value={form.name}
                  maxLength={60}
                  onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                />
              </p>
              <p className="character-create-field">
                <label htmlFor={`${baseId}-identity`}>身份</label>
                <input
                  id={`${baseId}-identity`}
                  value={form.identity}
                  maxLength={80}
                  onChange={(event) => setForm((prev) => ({ ...prev, identity: event.target.value }))}
                />
              </p>
              <p className="character-create-field">
                <label htmlFor={`${baseId}-age`}>年龄</label>
                <input
                  id={`${baseId}-age`}
                  value={form.age}
                  inputMode="numeric"
                  onChange={(event) => setForm((prev) => ({ ...prev, age: event.target.value }))}
                />
              </p>
              <p className="character-create-field">
                <label htmlFor={`${baseId}-gender`}>性别</label>
                <input
                  id={`${baseId}-gender`}
                  value={form.gender}
                  maxLength={16}
                  onChange={(event) => setForm((prev) => ({ ...prev, gender: event.target.value }))}
                />
              </p>
              {DIMENSION_FIELDS.map((dim) => (
                <p key={dim.key} className="character-create-field">
                  <label htmlFor={`${baseId}-${dim.key}`}>{dim.label}</label>
                  <input
                    id={`${baseId}-${dim.key}`}
                    value={form[dim.key]}
                    maxLength={dim.key === 'age_band' ? 40 : 80}
                    onChange={(event) => setForm((prev) => ({ ...prev, [dim.key]: event.target.value }))}
                  />
                </p>
              ))}
              <p className="character-create-field character-create-field--wide">
                <label htmlFor={`${baseId}-personality`}>性格</label>
                <textarea
                  id={`${baseId}-personality`}
                  value={form.personality}
                  maxLength={2000}
                  rows={3}
                  onChange={(event) => setForm((prev) => ({ ...prev, personality: event.target.value }))}
                />
              </p>
              <p className="character-create-field character-create-field--wide">
                <label htmlFor={`${baseId}-experience`}>经历</label>
                <textarea
                  id={`${baseId}-experience`}
                  value={form.experience}
                  maxLength={20000}
                  rows={4}
                  onChange={(event) => setForm((prev) => ({ ...prev, experience: event.target.value }))}
                />
              </p>
              <div className="character-create-actions">
                <button type="submit" disabled={saving}>创建角色</button>
                <button type="button" onClick={() => void handleRandom()} disabled={saving}>随机填充</button>
                <button type="button" onClick={closeDialog}>取消</button>
              </div>
            </form>
          ) : (
            <form className="character-create-form" onSubmit={(event) => void handleRelationSubmit(event)} aria-label="建关系表单">
              {loadingTypes ? <p className="character-create-status" role="status">正在加载关系类型…</p> : null}
              <p className="character-create-field">
                <label htmlFor={`${baseId}-source`}>起点角色</label>
                <select
                  id={`${baseId}-source`}
                  value={relation.sourceId}
                  onChange={(event) => setRelation((prev) => ({ ...prev, sourceId: event.target.value }))}
                >
                  <option value="">请选择角色</option>
                  {characters.map((character) => (
                    <option key={character.id} value={character.id}>{character.name}</option>
                  ))}
                </select>
              </p>
              <p className="character-create-field">
                <label htmlFor={`${baseId}-target`}>终点角色</label>
                <select
                  id={`${baseId}-target`}
                  value={relation.targetId}
                  onChange={(event) => setRelation((prev) => ({ ...prev, targetId: event.target.value }))}
                >
                  <option value="">请选择角色</option>
                  {characters.map((character) => (
                    <option key={character.id} value={character.id}>{character.name}</option>
                  ))}
                </select>
              </p>
              <p className="character-create-field">
                <label htmlFor={`${baseId}-type`}>关系类型</label>
                <select
                  id={`${baseId}-type`}
                  value={relation.typeId}
                  onChange={(event) => setRelation((prev) => ({ ...prev, typeId: event.target.value }))}
                >
                  {relationTypes.length === 0 ? <option value="">暂无关系类型</option> : null}
                  {relationTypes.map((type) => (
                    <option key={type.id} value={type.id}>{type.group_label} / {type.label}</option>
                  ))}
                </select>
              </p>
              <p className="character-create-direction">{selectedType ? `方向：${selectedType.directed ? '有向（单向箭头）' : '无向（双向连线）'}` : '方向：由关系类型决定'}</p>
              <p className="character-create-field">
                <label htmlFor={`${baseId}-label`}>关系称谓</label>
                <input
                  id={`${baseId}-label`}
                  value={relation.label}
                  maxLength={40}
                  placeholder={selectedType?.label ?? ''}
                  onChange={(event) => setRelation((prev) => ({ ...prev, label: event.target.value }))}
                />
              </p>
              <p className="character-create-field">
                <label htmlFor={`${baseId}-tag`}>标签</label>
                <input
                  id={`${baseId}-tag`}
                  value={relation.tag}
                  maxLength={40}
                  onChange={(event) => setRelation((prev) => ({ ...prev, tag: event.target.value }))}
                />
              </p>
              <div className="character-create-actions">
                <button type="submit" disabled={saving || loadingTypes}>创建关系</button>
                <button type="button" onClick={closeDialog}>取消</button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </>
  );
}
