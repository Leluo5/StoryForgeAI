import { useEffect, useState, type FormEvent, type JSX } from 'react';
import type { PlotGroup, PlotLink, PlotNode } from '@storyforge/contracts';
import { characterClient } from '../character/character-client';
import { LINK_TYPE_LABEL, nextSiblingOrder, plotErrorMessage, subtreeIds, usePlotStore } from './plot-state';
import {
  MAX_NODE_OWNERS,
  ownersFromServer,
  ownerDraftKey,
  setOwnerExclusive,
  toggleOwnerDraft,
  type PlotOwnerDraft
} from './plot-archived';

export type OwnerCharacterSource = (workId: string) => Promise<Array<{ id: string; name: string }>>;
export type OwnerSave = (
  workId: string,
  nodeId: string,
  owners: PlotOwnerDraft[]
) => Promise<unknown>;

interface PlotInspectorProps {
  /** 归属角色候选来源，默认复用角色域客户端；测试可注入 */
  characterSource?: OwnerCharacterSource;
  /** 归属保存，默认复用 characterClient.setPlotNodeOwners；测试可注入 */
  saveOwners?: OwnerSave;
}

const defaultCharacterSource: OwnerCharacterSource = async (workId) => {
  const result = await characterClient.listCharacters(workId, { status: 'active' });
  return result.items.map((item) => ({ id: item.id, name: item.name }));
};

const defaultSaveOwners: OwnerSave = (workId, nodeId, owners) =>
  characterClient.setPlotNodeOwners(workId, nodeId, owners);

/** 右栏节点检查器：节点内容 / 属性 / 层级 / 分组 / 归属 / 关联 / 分组管理 */
export function PlotInspector(props: PlotInspectorProps = {}): JSX.Element {
  const store = usePlotStore();
  const node = store.data.nodes.find((item) => item.id === store.selectedNodeId) ?? null;
  const characterSource = props.characterSource ?? defaultCharacterSource;
  const saveOwners = props.saveOwners ?? defaultSaveOwners;
  return (
    <section className="plot-inspector" aria-label="节点检查器">
      {node ? (
        <>
          <NodeForm key={`${node.id}-${node.updated_at}`} node={node} />
          <OwnerSection
            key={`owners-${node.id}-${node.updated_at}`}
            node={node}
            characterSource={characterSource}
            saveOwners={saveOwners}
          />
        </>
      ) : (
        <p className="plot-hint">在画布或列表中选择节点后可编辑内容、层级与关联。</p>
      )}
      <LinkSection node={node} />
      <GroupSection />
      {store.notice ? <p className="plot-notice" role="status">{store.notice}</p> : null}
      {store.error ? <p className="plot-error" role="alert">{store.error}</p> : null}
    </section>
  );
}

function NodeForm({ node }: { node: PlotNode }): JSX.Element {
  const store = usePlotStore();
  const [title, setTitle] = useState(node.title);
  const [summary, setSummary] = useState(node.summary ?? '');
  const [content, setContent] = useState(node.content);
  const [timePoint, setTimePoint] = useState(node.attributes.time_point ?? '');
  const [place, setPlace] = useState(node.attributes.place ?? '');
  const [status, setStatus] = useState(node.attributes.status ?? '');
  const [confirming, setConfirming] = useState(false);
  const descendants = subtreeIds(store.data.nodes, node.id);
  const parentCandidates = store.data.nodes.filter((item) => !descendants.includes(item.id));

  async function save(event: FormEvent) {
    event.preventDefault();
    const ok = await store.patchNode(node.id, {
      title: title.trim() || node.title,
      summary: summary.trim() || null,
      content,
      attributes: {
        time_point: timePoint.trim() || undefined,
        place: place.trim() || undefined,
        status: status.trim() || undefined
      }
    });
    if (ok) store.setNotice('节点已保存');
  }

  return (
    <form className="plot-form" onSubmit={save}>
      <label>
        标题
        <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} required />
      </label>
      <label>
        概要
        <input value={summary} maxLength={255} onChange={(event) => setSummary(event.target.value)} />
      </label>
      <label>
        正文片段
        <textarea value={content} rows={4} maxLength={20000} onChange={(event) => setContent(event.target.value)} />
      </label>
      <div className="plot-form-row">
        <label>
          时间点
          <input value={timePoint} maxLength={120} onChange={(event) => setTimePoint(event.target.value)} />
        </label>
        <label>
          地点
          <input value={place} maxLength={120} onChange={(event) => setPlace(event.target.value)} />
        </label>
        <label>
          状态
          <input value={status} maxLength={40} onChange={(event) => setStatus(event.target.value)} />
        </label>
      </div>
      <div className="plot-form-row">
        <label>
          父级
          <select
            value={node.parent_id ?? ''}
            onChange={(event) => {
              const parentId = event.target.value || null;
              void store.moveNode(node.id, parentId, nextSiblingOrder(store.data.nodes, parentId));
            }}
          >
            <option value="">无（根节点）</option>
            {parentCandidates.map((item) => (
              <option key={item.id} value={item.id}>{item.title}</option>
            ))}
          </select>
        </label>
        <label>
          分组
          <select
            value={node.group_id ?? ''}
            onChange={(event) => void store.assignGroup(node.id, event.target.value || null)}
          >
            <option value="">未分组</option>
            {store.data.groups.map((group) => (
              <option key={group.id} value={group.id}>{group.name}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="plot-form-actions">
        <button type="submit" disabled={store.busy}>保存节点</button>
        {confirming ? (
          <button type="button" className="plot-danger" disabled={store.busy}
            onClick={() => void store.removeNode(node.id)}>
            确认删除（含 {descendants.length} 个节点）
          </button>
        ) : (
          <button type="button" className="plot-danger" onClick={() => setConfirming(true)}>删除节点</button>
        )}
        {confirming ? <button type="button" onClick={() => setConfirming(false)}>取消</button> : null}
      </div>
    </form>
  );
}

/** 归属角色多选（≤10）+ 专属；保存失败回滚本地选择（02-技术方案 §6.5.1） */
function OwnerSection(props: {
  node: PlotNode;
  characterSource: OwnerCharacterSource;
  saveOwners: OwnerSave;
}): JSX.Element {
  const { node, characterSource, saveOwners } = props;
  const store = usePlotStore();
  const serverOwners = store.owners.filter((owner) => owner.node_id === node.id);
  const serverKey = ownerDraftKey(ownersFromServer(serverOwners));
  const [draft, setDraft] = useState<PlotOwnerDraft[]>(() => ownersFromServer(serverOwners));
  const [saved, setSaved] = useState<PlotOwnerDraft[]>(() => ownersFromServer(serverOwners));
  const [characters, setCharacters] = useState<Array<{ id: string; name: string }>>([]);
  const [listError, setListError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setListError('');
    characterSource(store.workId)
      .then((items) => {
        if (!cancelled) setCharacters(items);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setListError(plotErrorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [characterSource, store.workId]);

  // 整树重新拉取后同步服务端归属（不影响正在编辑的本地草稿，除非归属确实变化）
  useEffect(() => {
    const next = ownersFromServer(serverOwners);
    setDraft(next);
    setSaved(next);
    setSaveError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  const atLimit = draft.length >= MAX_NODE_OWNERS;
  const options = (() => {
    const map = new Map(characters.map((item) => [item.id, item.name]));
    for (const owner of serverOwners) {
      if (owner.character && !map.has(owner.character_id)) map.set(owner.character_id, owner.character.name);
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  })();

  async function save(): Promise<void> {
    setSaving(true);
    setSaveError('');
    try {
      await saveOwners(store.workId, node.id, draft);
      setSaved(draft);
      store.setNotice('归属角色已保存');
    } catch (cause) {
      // 保存失败：回滚到上一次成功（或服务端）选择，并给出可读错误
      setDraft(saved);
      setSaveError(plotErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="plot-subsection" aria-label="归属角色">
      <h3>归属角色</h3>
      <p className="plot-hint">
        最多 {MAX_NODE_OWNERS} 个角色；勾选「专属」后，若这些专属角色全部归档，该节点默认隐藏。仅本机开关控制显示。
      </p>
      {listError ? <p className="plot-error" role="alert">{listError}</p> : null}
      {options.length === 0 && !listError ? (
        <p className="plot-hint">暂无可用角色，请先在角色页签创建角色。</p>
      ) : null}
      <ul className="plot-owner-list">
        {options.map((option) => {
          const owner = draft.find((item) => item.character_id === option.id);
          const selected = Boolean(owner);
          return (
            <li key={option.id} className="plot-owner-row">
              <label className="plot-check">
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={!selected && atLimit}
                  onChange={() => setDraft((prev) => toggleOwnerDraft(prev, option.id))}
                />
                <span>{option.name}</span>
              </label>
              <label className="plot-check">
                <input
                  type="checkbox"
                  checked={owner?.is_exclusive ?? false}
                  disabled={!selected}
                  onChange={(event) => setDraft((prev) => setOwnerExclusive(prev, option.id, event.target.checked))}
                />
                <span>专属</span>
              </label>
            </li>
          );
        })}
      </ul>
      {atLimit ? (
        <p className="plot-hint" role="status">已达 {MAX_NODE_OWNERS} 个归属上限，取消后再选择其他角色。</p>
      ) : null}
      <div className="plot-form-actions">
        <button type="button" disabled={saving} onClick={() => void save()}>保存归属</button>
      </div>
      {saveError ? <p className="plot-error" role="alert">{saveError}</p> : null}
    </section>
  );
}

function LinkSection({ node }: { node: PlotNode | null }): JSX.Element {
  const store = usePlotStore();
  const [targetId, setTargetId] = useState('');
  const [type, setType] = useState<PlotLink['type']>('linear');
  const [label, setLabel] = useState('');

  if (!node) return <section className="plot-subsection" aria-label="关联" />;
  const related = store.data.links.filter((link) => link.source_id === node.id || link.target_id === node.id);
  const targets = store.data.nodes.filter((item) => item.id !== node.id);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!targetId) return;
    const ok = await store.addLink(node!.id, targetId, type, label.trim() || null);
    if (ok) {
      setLabel('');
      setTargetId('');
      store.setNotice('关联已建立');
    }
  }

  return (
    <section className="plot-subsection" aria-label="关联">
      <h3>关联</h3>
      <ul className="plot-link-list">
        {related.length === 0 ? <li className="plot-hint">暂无关联</li> : related.map((link) => {
          const outgoing = link.source_id === node.id;
          const otherId = outgoing ? link.target_id : link.source_id;
          const other = store.data.nodes.find((item) => item.id === otherId);
          return (
            <li key={link.id} className={store.selectedLinkId === link.id ? 'is-selected' : ''}>
              <span>{outgoing ? '→' : '←'} {other?.title ?? '已删除节点'}</span>
              <span className="plot-link-type">{LINK_TYPE_LABEL[link.type]}</span>
              <button type="button" aria-label={`删除关联 ${other?.title ?? ''}`}
                onClick={() => void store.removeLink(link.id)}>删除</button>
            </li>
          );
        })}
      </ul>
      <form className="plot-form" onSubmit={create}>
        <label>
          目标节点
          <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
            <option value="">请选择</option>
            {targets.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </label>
        <label>
          关联类型
          <select value={type} onChange={(event) => setType(event.target.value as PlotLink['type'])}>
            <option value="linear">线性（必须先发生）</option>
            <option value="non_linear">非线性（呼应）</option>
          </select>
        </label>
        <label>
          备注
          <input value={label} maxLength={255} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <button type="submit" disabled={store.busy || !targetId}>建立关联</button>
      </form>
    </section>
  );
}

function GroupSection(): JSX.Element {
  const store = usePlotStore();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<PlotGroup['kind']>('group');

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    const ok = await store.addGroup(name.trim(), kind);
    if (ok) {
      setName('');
      store.setNotice('分组已创建');
    }
  }

  return (
    <section className="plot-subsection" aria-label="分组管理">
      <h3>分组 / 泳道</h3>
      <ul className="plot-group-list">
        {store.data.groups.length === 0 ? <li className="plot-hint">暂无分组</li> : store.data.groups.map((group) => (
          <GroupRow key={`${group.id}-${group.updated_at}`} group={group} />
        ))}
      </ul>
      <form className="plot-form" onSubmit={create}>
        <label>
          名称
          <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          类型
          <select value={kind} onChange={(event) => setKind(event.target.value as PlotGroup['kind'])}>
            <option value="group">分组框</option>
            <option value="swimlane">泳道</option>
          </select>
        </label>
        <button type="submit" disabled={store.busy || !name.trim()}>新建分组</button>
      </form>
    </section>
  );
}

function GroupRow({ group }: { group: PlotGroup }): JSX.Element {
  const store = usePlotStore();
  const [name, setName] = useState(group.name);
  const [confirming, setConfirming] = useState(false);
  return (
    <li>
      <input aria-label={`分组名称 ${group.name}`} value={name} maxLength={80}
        onChange={(event) => setName(event.target.value)} />
      <span className="plot-link-type">{group.kind === 'swimlane' ? '泳道' : '分组框'}</span>
      <button type="button" disabled={store.busy || !name.trim() || name === group.name}
        onClick={() => void store.renameGroup(group.id, name.trim())}>重命名</button>
      {confirming ? (
        <button type="button" className="plot-danger" onClick={() => void store.removeGroup(group.id)}>确认删除分组</button>
      ) : (
        <button type="button" onClick={() => setConfirming(true)}>删除</button>
      )}
    </li>
  );
}
