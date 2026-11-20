import { useRef, useState, type ChangeEvent, type JSX } from 'react';
import { characterImportFileSchema } from '@storyforge/contracts';
import type { CharacterClient } from './character-client';
import { characterErrorMessage, type CharacterFilters } from './character-state';

export type CharacterFilterDimension = 'country_region' | 'faith' | 'faction' | 'race' | 'occupation' | 'age_band';

export interface CharacterDimensionOption {
  value: string;
  label: string;
}

export const CHARACTER_FILTER_DIMENSIONS: { key: CharacterFilterDimension; label: string }[] = [
  { key: 'country_region', label: '国家/地域' },
  { key: 'faith', label: '信仰' },
  { key: 'faction', label: '阵营' },
  { key: 'race', label: '种族' },
  { key: 'occupation', label: '职业' },
  { key: 'age_band', label: '年龄段' }
];

export type CharacterViewMode = 'canvas' | 'list' | 'archive';

interface Props {
  view: CharacterViewMode;
  onView: (view: CharacterViewMode) => void;
  workId: string;
  client: CharacterClient;
  /** 导入提交成功后刷新版图 */
  onImported?: (() => void) | undefined;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onReset: () => void;
  keyword: string;
  onKeyword: (value: string) => void;
  filters: CharacterFilters;
  dimensionOptions: Record<CharacterFilterDimension, CharacterDimensionOption[]>;
  onDimensionChange: (dim: CharacterFilterDimension, value: string) => void;
  resultCount: number;
  busy: boolean;
}

type ImportFile = Awaited<ReturnType<CharacterClient['exportFile']>>;
type ImportPreview = Awaited<ReturnType<CharacterClient['previewImport']>>;

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const DUPLICATE_ACTION_LABELS = {
  create: '新建（保留为重名角色）',
  merge: '合并到已有角色',
  keep_independent: '保持独立'
} as const;

interface ResolutionDraft {
  action: 'create' | 'merge' | 'keep_independent';
  target: string | undefined;
}

/** 导出下载 + 导入校验 / 冲突预览 / resolution 选择 / commit 二次确认（T41） */
function CharacterPortability({ workId, client, onImported }: { workId: string; client: CharacterClient; onImported?: (() => void) | undefined }): JSX.Element {
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<ImportFile | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, ResolutionDraft>>({});
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const idempotencyRef = useRef(crypto.randomUUID());
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleExport(): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const exported = await client.exportFile(workId);
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = `characters-${workId}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotice(`已导出 ${exported.characters.length} 个角色`);
    } catch (cause) {
      setError(characterErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;
    setError('');
    setNotice('');
    setPreview(null);
    setResolutions({});
    if (picked.size > MAX_IMPORT_BYTES) {
      setError('导入文件超过 5 MB 上限');
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await picked.text());
    } catch {
      setError('导入文件不是合法 JSON');
      return;
    }
    const parsed = characterImportFileSchema.safeParse(raw);
    if (!parsed.success) {
      setError(`导入文件校验未通过：${parsed.error.issues[0]?.message ?? '格式不符'}`);
      return;
    }
    setFile(parsed.data);
    setBusy(true);
    try {
      const result = await client.previewImport(workId, parsed.data, crypto.randomUUID());
      setPreview(result);
      setNotice(`预览完成：${result.summary.characters} 个角色 / ${result.summary.relations} 条关系，${result.conflicts.length} 个冲突`);
    } catch (cause) {
      setError(characterErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const duplicateLocalIds = preview
    ? [...new Set(preview.conflicts.filter((conflict) => conflict.type === 'character_duplicate' && conflict.local_id).map((conflict) => conflict.local_id!))]
    : [];
  const missingResolution = duplicateLocalIds.filter((localId) => !resolutions[localId]);
  const mergeMissingTarget = duplicateLocalIds.some((localId) => resolutions[localId]?.action === 'merge' && !resolutions[localId]?.target);
  const duplicateMatches = (localId: string) => preview?.conflicts.find((conflict) => conflict.local_id === localId)?.matches ?? [];

  async function handleCommit(): Promise<void> {
    if (!file || !preview) return;
    if (missingResolution.length > 0) {
      setError(`还有 ${missingResolution.length} 个重复角色未选择处理方式`);
      return;
    }
    if (mergeMissingTarget) {
      setError('合并需要指定目标角色');
      return;
    }
    if (mode === 'replace' && !confirmOverwrite) {
      setError('覆盖导入需要先勾选确认；建议先导出当前角色数据');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await client.commitImport(workId, {
        preview_job_id: preview.preview_job_id,
        idempotency_key: idempotencyRef.current,
        mode,
        confirm_overwrite: mode === 'replace' ? confirmOverwrite : false,
        file,
        resolutions: duplicateLocalIds.map((localId) => {
          const draft = resolutions[localId]!;
          return draft.action === 'merge'
            ? { local_id: localId, action: draft.action, target_character_id: draft.target! }
            : { local_id: localId, action: draft.action };
        })
      });
      setNotice('导入完成');
      setPreview(null);
      setFile(null);
      setResolutions({});
      setConfirmOverwrite(false);
      idempotencyRef.current = crypto.randomUUID();
      onImported?.();
    } catch (cause) {
      setError(characterErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="character-toolbar-group character-portability" role="group" aria-label="导入导出">
      <button type="button" onClick={() => void handleExport()} disabled={busy}>导出角色</button>
      <label className="character-import-label" htmlFor="character-import-file">导入角色</label>
      <input ref={inputRef} id="character-import-file" type="file" accept="application/json,.json" disabled={busy}
        onChange={(event) => void handleFileChange(event)} />
      {error ? <p className="character-error" role="alert">{error}</p> : null}
      {notice ? <p className="character-notice" role="status">{notice}</p> : null}
      {preview ? (
        <div className="character-import-preview" role="group" aria-label="导入冲突预览">
          <ul className="character-import-summary">
            <li>角色 {preview.summary.characters}</li>
            <li>关系 {preview.summary.relations}</li>
            <li>成长事件 {preview.summary.growth_events}</li>
            <li>视图 {preview.summary.views}</li>
            <li>冲突 {preview.conflicts.length}</li>
            <li>丢弃锚点 {preview.summary.discarded_anchors}</li>
          </ul>
          {duplicateLocalIds.map((localId) => (
            <div key={localId} className="character-import-conflict" data-import-local-id={localId}>
              <span>重复角色：{duplicateMatches(localId).map((match) => match.name).join('、') || localId}</span>
              <label>
                处理方式
                <select
                  aria-label={`重复角色 ${localId} 的处理方式`}
                  value={resolutions[localId]?.action ?? ''}
                  onChange={(event) => {
                    const action = event.target.value as ResolutionDraft['action'];
                    setResolutions((current) => ({
                      ...current,
                      [localId]: action === 'merge'
                        ? { action, target: current[localId]?.target ?? duplicateMatches(localId)[0]?.character_id }
                        : { action, target: undefined }
                    }));
                  }}
                >
                  <option value="">请选择</option>
                  <option value="create">{DUPLICATE_ACTION_LABELS.create}</option>
                  <option value="merge">{DUPLICATE_ACTION_LABELS.merge}</option>
                  <option value="keep_independent">{DUPLICATE_ACTION_LABELS.keep_independent}</option>
                </select>
              </label>
              {resolutions[localId]?.action === 'merge' ? (
                <label>
                  目标角色
                  <select
                    aria-label={`重复角色 ${localId} 的合并目标`}
                    value={resolutions[localId]?.target ?? ''}
                    onChange={(event) => setResolutions((current) => ({
                      ...current,
                      [localId]: { action: 'merge', target: event.target.value }
                    }))}
                  >
                    {(duplicateMatches(localId) ?? []).map((match) => (
                      <option key={match.character_id} value={match.character_id}>{match.name}</option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          ))}
          <label>
            导入模式
            <select aria-label="导入模式" value={mode} onChange={(event) => setMode(event.target.value as 'merge' | 'replace')}>
              <option value="merge">合并导入</option>
              <option value="replace">覆盖导入</option>
            </select>
          </label>
          {mode === 'replace' ? (
            <label className="character-import-overwrite">
              <input type="checkbox" checked={confirmOverwrite} onChange={(event) => setConfirmOverwrite(event.target.checked)} />
              确认覆盖当前角色数据（建议先导出备份）
            </label>
          ) : null}
          <button type="button" onClick={() => void handleCommit()} disabled={busy}>提交导入</button>
        </div>
      ) : null}
    </div>
  );
}

/** 角色版图工具栏：缩放 / 视图切换 / 关键词与六维筛选 / 导入导出（T33 / T34 / T41） */
export function CharacterToolbar(props: Props): JSX.Element {
  return (
    <div className="character-toolbar" role="toolbar" aria-label="角色版图工具栏">
      <div className="character-toolbar-group" role="group" aria-label="缩放">
        <button type="button" onClick={props.onZoomOut} aria-label="缩小画布" disabled={props.busy}>−</button>
        <output className="character-zoom" aria-label="当前缩放">{Math.round(props.zoom * 100)}%</output>
        <button type="button" onClick={props.onZoomIn} aria-label="放大画布" disabled={props.busy}>+</button>
        <button type="button" onClick={props.onFit} disabled={props.busy}>适应视图</button>
        <button type="button" onClick={props.onReset} disabled={props.busy}>复位</button>
      </div>
      <div className="character-toolbar-group" role="group" aria-label="视图切换">
        <button type="button" aria-pressed={props.view === 'canvas'} onClick={() => props.onView('canvas')}>画布</button>
        <button type="button" aria-pressed={props.view === 'list'} onClick={() => props.onView('list')}>列表</button>
        <button type="button" aria-pressed={props.view === 'archive'} onClick={() => props.onView('archive')}>归档</button>
      </div>
      <CharacterPortability workId={props.workId} client={props.client} onImported={props.onImported} />
      <div className="character-toolbar-group character-search" role="group" aria-label="筛选">
        <label htmlFor="character-keyword-input">搜索</label>
        <input
          id="character-keyword-input"
          type="search"
          value={props.keyword}
          placeholder="姓名 / 六维属性"
          onChange={(event) => props.onKeyword(event.target.value)}
        />
        {CHARACTER_FILTER_DIMENSIONS.map((dim) => (
          <label key={dim.key} htmlFor={`character-filter-${dim.key}`}>
            {dim.label}
            <select
              id={`character-filter-${dim.key}`}
              data-character-dim={dim.key}
              value={props.filters[dim.key] ?? 'all'}
              onChange={(event) => props.onDimensionChange(dim.key, event.target.value)}
            >
              <option value="all">全部</option>
              {props.dimensionOptions[dim.key].map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        ))}
        <span className="character-search-count" role="status">{props.resultCount} 个结果</span>
      </div>
    </div>
  );
}
