import { useCallback, useEffect, useId, useState, type FormEvent, type JSX } from 'react';
import type { Character, CharacterAvatarAsset } from '@storyforge/contracts';
import { ApiError } from '../api/client';
import { characterClient, type CharacterClient } from './character-client';
import { characterErrorMessage } from './character-state';
import './character-inspector.css';

interface Props {
  workId: string;
  characterId: string;
  /** 默认 characterClient；测试直接注入 mock */
  client?: CharacterClient;
  onSaved?: (character: Character) => void;
  onClose?: () => void;
}

interface DossierForm {
  name: string;
  identity: string;
  age: string;
  gender: string;
  personality: string;
  experience: string;
  country_region: string;
  faith: string;
  faction: string;
  race: string;
  occupation: string;
  age_band: string;
}

interface AttributeRow {
  key: string;
  value: string;
}

interface AvatarState {
  active: CharacterAvatarAsset | null;
  pending: CharacterAvatarAsset[];
}

const MAX_ALIASES = 10;
const MAX_ATTRIBUTES = 20;

const EMPTY_FORM: DossierForm = {
  name: '',
  identity: '',
  age: '',
  gender: '',
  personality: '',
  experience: '',
  country_region: '',
  faith: '',
  faction: '',
  race: '',
  occupation: '',
  age_band: ''
};

function formFrom(character: Character): DossierForm {
  return {
    name: character.name,
    identity: character.identity ?? '',
    age: character.age === null ? '' : String(character.age),
    gender: character.gender ?? '',
    personality: character.personality,
    experience: character.experience,
    country_region: character.country_region ?? '',
    faith: character.faith ?? '',
    faction: character.faction ?? '',
    race: character.race ?? '',
    occupation: character.occupation ?? '',
    age_band: character.age_band ?? ''
  };
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseAge(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/** 角色资料检查器：13 项编辑 + 别名上限 10 + 头像三态 + 409 冲突提示（T35） */
export function CharacterInspector(props: Props): JSX.Element {
  const { workId, characterId, client = characterClient } = props;
  const baseId = `character-inspector-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const [character, setCharacter] = useState<Character | null>(null);
  const [form, setForm] = useState<DossierForm>(EMPTY_FORM);
  const [aliases, setAliases] = useState<string[]>([]);
  const [aliasDraft, setAliasDraft] = useState('');
  const [attributes, setAttributes] = useState<AttributeRow[]>([]);
  const [avatar, setAvatar] = useState<AvatarState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [savedNotice, setSavedNotice] = useState('');
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError('');
    const [detailResult, avatarResult] = await Promise.allSettled([
      client.getCharacter(workId, characterId),
      client.getAvatar(workId, characterId)
    ]);
    if (detailResult.status === 'fulfilled') {
      const next = detailResult.value.character;
      setCharacter(next);
      setForm(formFrom(next));
      setAliases(next.aliases);
      setAttributes(next.attributes.map((attribute) => ({ key: attribute.key, value: attribute.value })));
    } else {
      setLoadError(characterErrorMessage(detailResult.reason));
    }
    if (avatarResult.status === 'fulfilled') {
      setAvatar(avatarResult.value);
      setAvatarError('');
    } else {
      setAvatarError(characterErrorMessage(avatarResult.reason));
    }
    setConflict(false);
    setSaveError('');
    setSavedNotice('');
    setLoading(false);
  }, [client, workId, characterId]);

  useEffect(() => {
    void load();
  }, [load]);

  const readOnly = character !== null && character.status !== 'active';

  function updateForm<K extends keyof DossierForm>(key: K, value: DossierForm[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const addAlias = useCallback((): void => {
    const value = aliasDraft.trim();
    if (value === '' || readOnly) return;
    setAliases((prev) => {
      if (prev.length >= MAX_ALIASES || prev.includes(value)) return prev;
      return [...prev, value];
    });
    setAliasDraft('');
  }, [aliasDraft, readOnly]);

  const removeAlias = useCallback((index: number): void => {
    setAliases((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addAttribute = useCallback((): void => {
    setAttributes((prev) => (prev.length >= MAX_ATTRIBUTES ? prev : [...prev, { key: '', value: '' }]));
  }, []);

  const updateAttribute = useCallback((index: number, field: keyof AttributeRow, value: string): void => {
    setAttributes((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  }, []);

  const removeAttribute = useCallback((index: number): void => {
    setAttributes((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSave = useCallback(async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!character || readOnly || saving) return;
    const name = form.name.trim();
    if (name === '') {
      setSaveError('姓名不能为空');
      return;
    }
    setSaving(true);
    setSaveError('');
    setConflict(false);
    setSavedNotice('');
    try {
      const updated = await client.updateCharacter(
        workId,
        characterId,
        {
          name,
          aliases,
          identity: blankToNull(form.identity),
          age: parseAge(form.age),
          gender: blankToNull(form.gender),
          personality: form.personality,
          experience: form.experience,
          country_region: blankToNull(form.country_region),
          faith: blankToNull(form.faith),
          faction: blankToNull(form.faction),
          race: blankToNull(form.race),
          occupation: blankToNull(form.occupation),
          age_band: blankToNull(form.age_band),
          attributes: attributes
            .filter((row) => row.key.trim() !== '')
            .slice(0, MAX_ATTRIBUTES)
            .map((row) => ({ key: row.key.trim(), value: row.value.trim() }))
        },
        character.version
      );
      setCharacter(updated);
      setForm(formFrom(updated));
      setAliases(updated.aliases);
      setAttributes(updated.attributes.map((attribute) => ({ key: attribute.key, value: attribute.value })));
      setSavedNotice('已保存');
      props.onSaved?.(updated);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        // 409 不静默覆盖本地编辑，要求用户刷新拿到最新版本后重试
        setConflict(true);
      } else {
        setSaveError(characterErrorMessage(cause));
      }
    } finally {
      setSaving(false);
    }
  }, [attributes, aliases, character, characterId, client, form, props, readOnly, saving, workId]);

  const handleGenerate = useCallback(async (): Promise<void> => {
    if (avatarBusy || readOnly) return;
    setAvatarBusy(true);
    setAvatarError('');
    try {
      await client.generateAvatar(workId, characterId);
      try {
        const next = await client.getAvatar(workId, characterId);
        setAvatar(next);
      } catch {
        // 生成任务已提交，刷新失败不覆盖当前状态
      }
    } catch (cause) {
      setAvatarError(characterErrorMessage(cause));
    } finally {
      setAvatarBusy(false);
    }
  }, [avatarBusy, client, characterId, readOnly, workId]);

  const handleAdopt = useCallback(async (assetId: string): Promise<void> => {
    if (!character || avatarBusy || readOnly) return;
    setAvatarBusy(true);
    setAvatarError('');
    try {
      const result = await client.adoptAvatar(workId, characterId, assetId, character.version);
      setCharacter((prev) => (prev ? { ...prev, avatar_asset_id: result.asset.id, version: result.character_version } : prev));
      setAvatar((prev) => ({
        active: result.asset,
        pending: prev ? prev.pending.filter((asset) => asset.id !== result.asset.id) : []
      }));
    } catch (cause) {
      setAvatarError(characterErrorMessage(cause));
    } finally {
      setAvatarBusy(false);
    }
  }, [avatarBusy, character, characterId, client, readOnly, workId]);

  const pendingAssets = (avatar?.pending ?? []).filter((asset) => asset.status === 'pending');
  const failedAssets = (avatar?.pending ?? []).filter((asset) => asset.status === 'failed');
  const activeAvatar = avatar?.active ?? null;

  return (
    <section className="character-inspector" aria-label="角色资料">
      <header className="character-inspector-head">
        <h2 className="character-inspector-title">{character?.name ?? '角色资料'}</h2>
        {props.onClose ? (
          <button type="button" className="character-inspector-close" onClick={props.onClose} aria-label="关闭资料面板">
            关闭
          </button>
        ) : null}
      </header>

      {loading ? <p className="character-inspector-status" role="status">正在加载角色资料…</p> : null}
      {loadError ? <p className="character-inspector-error" role="alert">{loadError}</p> : null}

      {character ? (
        <>
          {readOnly ? (
            <p className="character-inspector-readonly" role="status">
              <span className="character-inspector-badge">{character.status === 'merged' ? '已合并' : '已归档'}</span>
              该角色资料为只读，无法编辑。
            </p>
          ) : null}

          {conflict ? (
            <div className="character-inspector-conflict" role="alert">
              <p>资料已被更新，请刷新后重试。</p>
              <button type="button" onClick={() => void load()}>刷新</button>
            </div>
          ) : null}

          {saveError ? <p className="character-inspector-error" role="alert">{saveError}</p> : null}
          {savedNotice ? <p className="character-inspector-notice" role="status">{savedNotice}</p> : null}

          <form className="character-inspector-form" onSubmit={(event) => void handleSave(event)} aria-label="角色资料表单">
            <div className="character-inspector-grid">
              <p className="character-inspector-field">
                <label htmlFor={`${baseId}-name`}>姓名</label>
                <input
                  id={`${baseId}-name`}
                  value={form.name}
                  maxLength={60}
                  disabled={readOnly}
                  onChange={(event) => updateForm('name', event.target.value)}
                />
              </p>
              <p className="character-inspector-field">
                <label htmlFor={`${baseId}-identity`}>身份</label>
                <input
                  id={`${baseId}-identity`}
                  value={form.identity}
                  maxLength={80}
                  disabled={readOnly}
                  onChange={(event) => updateForm('identity', event.target.value)}
                />
              </p>
              <p className="character-inspector-field">
                <label htmlFor={`${baseId}-age`}>年龄</label>
                <input
                  id={`${baseId}-age`}
                  type="number"
                  min={0}
                  max={10000}
                  value={form.age}
                  placeholder="可留空"
                  disabled={readOnly}
                  onChange={(event) => updateForm('age', event.target.value)}
                />
              </p>
              <p className="character-inspector-field">
                <label htmlFor={`${baseId}-gender`}>性别</label>
                <input
                  id={`${baseId}-gender`}
                  value={form.gender}
                  maxLength={16}
                  disabled={readOnly}
                  onChange={(event) => updateForm('gender', event.target.value)}
                />
              </p>
              <p className="character-inspector-field">
                <label htmlFor={`${baseId}-country`}>国家/地域</label>
                <input
                  id={`${baseId}-country`}
                  value={form.country_region}
                  maxLength={80}
                  disabled={readOnly}
                  onChange={(event) => updateForm('country_region', event.target.value)}
                />
              </p>
              <p className="character-inspector-field">
                <label htmlFor={`${baseId}-faith`}>信仰</label>
                <input
                  id={`${baseId}-faith`}
                  value={form.faith}
                  maxLength={80}
                  disabled={readOnly}
                  onChange={(event) => updateForm('faith', event.target.value)}
                />
              </p>
              <p className="character-inspector-field">
                <label htmlFor={`${baseId}-faction`}>阵营</label>
                <input
                  id={`${baseId}-faction`}
                  value={form.faction}
                  maxLength={80}
                  disabled={readOnly}
                  onChange={(event) => updateForm('faction', event.target.value)}
                />
              </p>
              <p className="character-inspector-field">
                <label htmlFor={`${baseId}-race`}>种族</label>
                <input
                  id={`${baseId}-race`}
                  value={form.race}
                  maxLength={80}
                  disabled={readOnly}
                  onChange={(event) => updateForm('race', event.target.value)}
                />
              </p>
              <p className="character-inspector-field">
                <label htmlFor={`${baseId}-occupation`}>职业</label>
                <input
                  id={`${baseId}-occupation`}
                  value={form.occupation}
                  maxLength={80}
                  disabled={readOnly}
                  onChange={(event) => updateForm('occupation', event.target.value)}
                />
              </p>
              <p className="character-inspector-field">
                <label htmlFor={`${baseId}-age-band`}>年龄段</label>
                <input
                  id={`${baseId}-age-band`}
                  value={form.age_band}
                  maxLength={40}
                  disabled={readOnly}
                  onChange={(event) => updateForm('age_band', event.target.value)}
                />
              </p>
            </div>

            <p className="character-inspector-field character-inspector-field--wide">
              <label htmlFor={`${baseId}-personality`}>性格</label>
              <textarea
                id={`${baseId}-personality`}
                rows={3}
                value={form.personality}
                maxLength={2000}
                disabled={readOnly}
                onChange={(event) => updateForm('personality', event.target.value)}
              />
            </p>
            <p className="character-inspector-field character-inspector-field--wide">
              <label htmlFor={`${baseId}-experience`}>经历</label>
              <textarea
                id={`${baseId}-experience`}
                rows={3}
                value={form.experience}
                maxLength={20000}
                disabled={readOnly}
                onChange={(event) => updateForm('experience', event.target.value)}
              />
            </p>

            <fieldset className="character-inspector-attributes">
              <legend>属性</legend>
              {attributes.map((row, index) => (
                <div className="character-inspector-attribute-row" key={index}>
                  <label htmlFor={`${baseId}-attr-key-${index}`}>属性键 {index + 1}</label>
                  <input
                    id={`${baseId}-attr-key-${index}`}
                    value={row.key}
                    maxLength={20}
                    disabled={readOnly}
                    onChange={(event) => updateAttribute(index, 'key', event.target.value)}
                  />
                  <label htmlFor={`${baseId}-attr-value-${index}`}>属性值 {index + 1}</label>
                  <input
                    id={`${baseId}-attr-value-${index}`}
                    value={row.value}
                    maxLength={200}
                    disabled={readOnly}
                    onChange={(event) => updateAttribute(index, 'value', event.target.value)}
                  />
                  <button type="button" onClick={() => removeAttribute(index)} disabled={readOnly} aria-label={`移除属性 ${index + 1}`}>
                    移除
                  </button>
                </div>
              ))}
              <button type="button" onClick={addAttribute} disabled={readOnly || attributes.length >= MAX_ATTRIBUTES}>
                添加属性
              </button>
              {attributes.length >= MAX_ATTRIBUTES ? (
                <p className="character-inspector-hint">属性最多 20 条，无法继续添加。</p>
              ) : null}
            </fieldset>

            <section className="character-inspector-alias" aria-label="别名">
              <h3>别名（{aliases.length}/{MAX_ALIASES}）</h3>
              <div className="character-inspector-alias-add">
                <label htmlFor={`${baseId}-alias`}>新别名</label>
                <input
                  id={`${baseId}-alias`}
                  value={aliasDraft}
                  maxLength={60}
                  disabled={readOnly || aliases.length >= MAX_ALIASES}
                  onChange={(event) => setAliasDraft(event.target.value)}
                />
                <button
                  type="button"
                  onClick={addAlias}
                  disabled={readOnly || aliases.length >= MAX_ALIASES || aliasDraft.trim() === ''}
                >
                  添加别名
                </button>
              </div>
              {aliases.length >= MAX_ALIASES ? (
                <p className="character-inspector-hint">别名最多 10 条，无法继续添加。</p>
              ) : null}
              <ul className="character-inspector-alias-list">
                {aliases.map((alias, index) => (
                  <li key={`${alias}-${index}`} className="character-inspector-alias-item">
                    <span>{alias}</span>
                    <button
                      type="button"
                      aria-label={`移除别名 ${alias}`}
                      onClick={() => removeAlias(index)}
                      disabled={readOnly}
                    >
                      移除
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section className="character-inspector-avatar" aria-label="头像">
              <h3>头像</h3>
              <div className="character-inspector-avatar-preview">
                {activeAvatar ? (
                  <img
                    className="character-inspector-avatar-image"
                    src={client.getAvatarContentUrl(workId, characterId, activeAvatar.id)}
                    alt={`${character.name} 的头像`}
                  />
                ) : (
                  <div className="character-inspector-avatar-placeholder">
                    <span className="character-inspector-avatar-placeholder-icon" aria-hidden="true">◇</span>
                    <span>暂无头像</span>
                  </div>
                )}
              </div>
              {pendingAssets.length > 0 ? (
                <p className="character-inspector-avatar-status" role="status">头像生成中…</p>
              ) : null}
              {failedAssets.length > 0 ? (
                <p className="character-inspector-avatar-error" role="alert">头像生成失败，请稍后重试。</p>
              ) : null}
              {avatarError ? <p className="character-inspector-avatar-error" role="alert">{avatarError}</p> : null}
              <div className="character-inspector-avatar-actions">
                <button type="button" onClick={() => void handleGenerate()} disabled={avatarBusy || readOnly}>
                  生成头像
                </button>
              </div>
              {pendingAssets.length > 0 ? (
                <ul className="character-inspector-avatar-pending">
                  {pendingAssets.map((asset) => (
                    <li key={asset.id}>
                      <span className="character-inspector-avatar-pending-label">待采用 {asset.id.slice(0, 8)}</span>
                      <button
                        type="button"
                        onClick={() => void handleAdopt(asset.id)}
                        disabled={avatarBusy || readOnly}
                      >
                        采用
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>

            <div className="character-inspector-actions">
              <button type="submit" className="character-inspector-save" disabled={saving || readOnly}>
                保存
              </button>
            </div>
          </form>
        </>
      ) : null}
    </section>
  );
}
