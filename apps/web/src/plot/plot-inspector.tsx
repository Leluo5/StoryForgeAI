import { useState, type FormEvent, type JSX } from 'react';
import type { PlotGroup, PlotLink, PlotNode } from '@storyforge/contracts';
import { LINK_TYPE_LABEL, nextSiblingOrder, subtreeIds, usePlotStore } from './plot-state';

/** 右栏节点检查器：节点内容 / 属性 / 层级 / 分组 / 关联 / 分组管理 */
export function PlotInspector(): JSX.Element {
  const store = usePlotStore();
  const node = store.data.nodes.find((item) => item.id === store.selectedNodeId) ?? null;
  return (
    <section className="plot-inspector" aria-label="节点检查器">
      {node ? <NodeForm key={`${node.id}-${node.updated_at}`} node={node} /> : (
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
