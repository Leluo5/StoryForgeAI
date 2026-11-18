import { useCallback, useEffect, useRef, useState, type ChangeEvent, type JSX, type ReactNode } from 'react';
import type { PlotLink, PlotNodeOrigin, PlotTreeResponse } from '@storyforge/contracts';
import { plotClient, type PlotClient } from './plot-client';
import { autoLayout, diffPositions, positionSnapshot, NODE_HEIGHT, NODE_WIDTH, ROW_GAP, type PositionUpdate } from './plot-layout';
import { PlotCanvas } from './plot-canvas';
import { PlotNodeList } from './plot-node-list';
import { PlotToolbar } from './plot-toolbar';
import {
  PlotStoreContext,
  emptyPlotData,
  filterPlotNodes,
  plotErrorMessage,
  subtreeIds,
  toPlotData,
  usePlotStore,
  type PlotData,
  type PlotNodeDraft,
  type PlotNodePatch,
  type PlotStore
} from './plot-state';

interface ProviderProps {
  workId: string;
  /** 仅在进入剧情页签 / 面板时加载，避免影响正文页签的首屏请求 */
  enabled?: boolean;
  client?: PlotClient;
  children: ReactNode;
}

/** 剧情状态容器：整树加载 + 全部写操作 + 409 错误提示 */
export function PlotStoreProvider({ workId, enabled = true, client = plotClient, children }: ProviderProps): JSX.Element {
  const [data, setData] = useState<PlotData>(emptyPlotData);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [view, setView] = useState<'canvas' | 'list'>('canvas');
  const [lastLayoutSnapshot, setLastLayoutSnapshot] = useState<PositionUpdate[] | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const loadedRef = useRef(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(toPlotData(await client.fetchTree(workId)));
    } catch (cause) {
      setError(plotErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [client, workId]);

  useEffect(() => {
    if (!enabled || loadedRef.current) return;
    loadedRef.current = true;
    void reload();
  }, [enabled, reload]);

  const run = useCallback(async <T,>(task: () => Promise<T>, after?: (result: T) => void): Promise<T | undefined> => {
    setBusy(true);
    setError('');
    try {
      const result = await task();
      after?.(result);
      return result;
    } catch (cause) {
      setError(plotErrorMessage(cause));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  const replaceNode = useCallback((node: PlotData['nodes'][number]) => {
    setData((prev) => ({ ...prev, nodes: prev.nodes.map((item) => (item.id === node.id ? node : item)) }));
  }, []);

  const createTree = useCallback(async (title?: string) => {
    const result = await run(() => client.createTree(workId, title));
    if (!result) return false;
    setData(toPlotData(result));
    setNotice('剧情树已创建');
    return true;
  }, [client, run, workId]);

  const addNode = useCallback(async (input: PlotNodeDraft) => {
    const maxY = dataRef.current.nodes.reduce((max, node) => Math.max(max, node.position.y), 0);
    const result = await run(() => client.createNode(workId, {
      ...input,
      position: input.position ?? { x: 60, y: dataRef.current.nodes.length === 0 ? 60 : maxY + ROW_GAP },
      origin: input.origin ?? 'manual',
      expected_version: dataRef.current.version
    }));
    if (!result) return undefined;
    setData((prev) => ({ ...prev, nodes: [...prev.nodes, result.node], version: result.version }));
    setSelectedNodeId(result.node.id);
    setNotice('节点已新增');
    return result.node;
  }, [client, run, workId]);

  const patchNode = useCallback(async (nodeId: string, patch: PlotNodePatch) => {
    const result = await run(() => client.updateNode(workId, nodeId, { ...patch, expected_version: dataRef.current.version }));
    if (!result) return false;
    replaceNode(result.node);
    setData((prev) => ({ ...prev, version: result.version }));
    return true;
  }, [client, replaceNode, run, workId]);

  const removeNode = useCallback(async (nodeId: string) => {
    const result = await run(() => client.deleteNode(workId, nodeId));
    if (!result) return false;
    const removed = new Set(subtreeIds(dataRef.current.nodes, nodeId));
    setData((prev) => ({
      ...prev,
      nodes: prev.nodes.filter((node) => !removed.has(node.id)),
      links: prev.links.filter((link) => !removed.has(link.source_id) && !removed.has(link.target_id)),
      version: result.version
    }));
    setSelectedNodeId((current) => (current && removed.has(current) ? null : current));
    setNotice(`已删除 ${result.deleted} 个节点`);
    return true;
  }, [client, run, workId]);

  const moveNode = useCallback(async (nodeId: string, parentId: string | null, siblingOrder?: number) => {
    const result = await run(() => client.moveNode(workId, nodeId, parentId, siblingOrder, dataRef.current.version));
    if (!result) return false;
    replaceNode(result.node);
    setData((prev) => ({ ...prev, version: result.version }));
    return true;
  }, [client, replaceNode, run, workId]);

  const assignGroup = useCallback(async (nodeId: string, groupId: string | null) => {
    const result = await run(() => client.assignGroup(workId, nodeId, groupId, dataRef.current.version));
    if (!result) return false;
    replaceNode(result.node);
    setData((prev) => ({ ...prev, version: result.version }));
    return true;
  }, [client, replaceNode, run, workId]);

  const savePositions = useCallback(async (updates: PositionUpdate[]) => {
    if (updates.length === 0) return true;
    const result = await run(() => client.updatePositions(workId, updates));
    if (!result) return false;
    const byId = new Map(updates.map((item) => [item.node_id, item]));
    setData((prev) => ({
      ...prev,
      nodes: prev.nodes.map((node) => {
        const point = byId.get(node.id);
        return point ? { ...node, position: { x: point.x, y: point.y } } : node;
      })
    }));
    return true;
  }, [client, run, workId]);

  const applyLayout = useCallback(async (positions: Record<string, { x: number; y: number }>) => {
    const snapshot = positionSnapshot(dataRef.current.nodes);
    const updates = diffPositions(dataRef.current.nodes, positions);
    if (updates.length === 0) {
      setLastLayoutSnapshot(snapshot);
      return true;
    }
    const ok = await savePositions(updates);
    if (ok) {
      setLastLayoutSnapshot(snapshot);
      setNotice('已按层级与分组重新布局，可撤销一次');
    }
    return ok;
  }, [savePositions]);

  const undoLayout = useCallback(async () => {
    if (!lastLayoutSnapshot) return;
    if (await savePositions(lastLayoutSnapshot)) {
      setLastLayoutSnapshot(null);
      setNotice('已撤销自动布局');
    }
  }, [lastLayoutSnapshot, savePositions]);

  const addLink = useCallback(async (sourceId: string, targetId: string, type: PlotLink['type'], label?: string | null) => {
    const result = await run(() => client.createLink(workId, { source_id: sourceId, target_id: targetId, type, label: label ?? null }, dataRef.current.version));
    if (!result) return false;
    setData((prev) => ({ ...prev, links: [...prev.links, result.link], version: result.version }));
    return true;
  }, [client, run, workId]);

  const removeLink = useCallback(async (linkId: string) => {
    const result = await run(() => client.deleteLink(workId, linkId));
    if (!result) return false;
    setData((prev) => ({ ...prev, links: prev.links.filter((link) => link.id !== linkId), version: result.version }));
    setSelectedLinkId((current) => (current === linkId ? null : current));
    return true;
  }, [client, run, workId]);

  const addGroup = useCallback(async (name: string, kind: PlotStore['data']['groups'][number]['kind']) => {
    const result = await run(() => client.createGroup(workId, { name, kind }, dataRef.current.version));
    if (!result) return false;
    setData((prev) => ({ ...prev, groups: [...prev.groups, result.group], version: result.version }));
    return true;
  }, [client, run, workId]);

  const renameGroup = useCallback(async (groupId: string, name: string) => {
    const result = await run(() => client.updateGroup(workId, groupId, { name }, dataRef.current.version));
    if (!result) return false;
    setData((prev) => ({
      ...prev,
      groups: prev.groups.map((group) => (group.id === groupId ? result.group : group)),
      version: result.version
    }));
    return true;
  }, [client, run, workId]);

  const removeGroup = useCallback(async (groupId: string) => {
    const result = await run(() => client.deleteGroup(workId, groupId));
    if (!result) return false;
    setData((prev) => ({
      ...prev,
      groups: prev.groups.filter((group) => group.id !== groupId),
      nodes: prev.nodes.map((node) => (node.group_id === groupId ? { ...node, group_id: null } : node)),
      version: result.version
    }));
    setNotice('分组已删除，组内节点回到未分组');
    return true;
  }, [client, run, workId]);

  const exportJson = useCallback(async () => {
    const exported = await run(() => client.exportTree(workId));
    return exported ? JSON.stringify(exported, null, 2) : '';
  }, [client, run, workId]);

  const importJson = useCallback(async (text: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError('导入失败：文件不是合法 JSON，现有剧情树未改动');
      return false;
    }
    const result = await run(() => client.importTree(workId, parsed as Parameters<PlotClient['importTree']>[1]));
    if (!result) return false;
    setData(toPlotData(result as PlotTreeResponse));
    setSelectedNodeId(null);
    setNotice('剧情树已导入');
    return true;
  }, [client, run, workId]);

  const store: PlotStore = {
    data,
    loading,
    error,
    notice,
    busy,
    selectedNodeId,
    selectedLinkId,
    view,
    lastLayoutSnapshot,
    setError,
    setNotice,
    selectNode: (nodeId) => {
      setSelectedNodeId(nodeId);
      setSelectedLinkId(null);
    },
    selectLink: (linkId) => {
      setSelectedLinkId(linkId);
      setSelectedNodeId(null);
    },
    setView,
    reload,
    createTree,
    addNode,
    patchNode,
    removeNode,
    moveNode,
    assignGroup,
    savePositions,
    applyLayout,
    undoLayout,
    addLink,
    removeLink,
    addGroup,
    renameGroup,
    removeGroup,
    exportJson,
    importJson
  };

  return <PlotStoreContext.Provider value={store}>{children}</PlotStoreContext.Provider>;
}

/** 工作台中央「剧情」页签内容 */
export function PlotWorkspace(): JSX.Element {
  const store = usePlotStore();
  const [search, setSearch] = useState('');
  const [originFilter, setOriginFilter] = useState<PlotNodeOrigin | 'all'>('all');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [linking, setLinking] = useState(false);
  const [linkSourceId, setLinkSourceId] = useState<string | null>(null);
  const [linkType, setLinkType] = useState<PlotLink['type']>('linear');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const filtered = filterPlotNodes(store.data.nodes, search, { origin: originFilter, groupId: groupFilter });
  const highlightIds = new Set(search.trim() ? filtered.map((node) => node.id) : []);
  const linkSource = store.data.nodes.find((node) => node.id === linkSourceId) ?? null;

  function handleSelect(nodeId: string) {
    if (linking) {
      if (!linkSourceId) {
        setLinkSourceId(nodeId);
        return;
      }
      if (linkSourceId !== nodeId) {
        void store.addLink(linkSourceId, nodeId, linkType).then((ok) => {
          if (ok) store.setNotice('关联已建立');
          setLinking(false);
          setLinkSourceId(null);
        });
      }
      return;
    }
    store.selectNode(nodeId);
  }

  function focusNode(nodeId: string) {
    store.selectNode(nodeId);
    const node = store.data.nodes.find((item) => item.id === nodeId);
    const element = viewportRef.current;
    if (!node || !element) return;
    const width = element.clientWidth || 800;
    const height = element.clientHeight || 600;
    setPan({
      x: width / 2 - (node.position.x + NODE_WIDTH / 2) * zoom,
      y: height / 2 - (node.position.y + NODE_HEIGHT / 2) * zoom
    });
  }

  function fitView() {
    if (store.data.nodes.length === 0) return;
    const xs = store.data.nodes.map((node) => node.position.x);
    const ys = store.data.nodes.map((node) => node.position.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const boundsWidth = Math.max(...xs) + NODE_WIDTH - minX;
    const boundsHeight = Math.max(...ys) + NODE_HEIGHT - minY;
    const element = viewportRef.current;
    const width = element?.clientWidth || 900;
    const height = element?.clientHeight || 600;
    const nextZoom = Math.max(0.25, Math.min(1.2, Math.min((width - 80) / boundsWidth, (height - 80) / boundsHeight)));
    setZoom(nextZoom);
    setPan({ x: (width - boundsWidth * nextZoom) / 2 - minX * nextZoom, y: (height - boundsHeight * nextZoom) / 2 - minY * nextZoom });
  }

  function handleZoom(direction: 1 | -1) {
    setZoom((current) => Math.max(0.25, Math.min(2, Number((current + direction * 0.1).toFixed(2)))));
  }

  function handleExport() {
    void store.exportJson().then((json) => {
      if (!json || typeof URL.createObjectURL !== 'function') return;
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `plot-tree-${Date.now()}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    });
  }

  function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void file.text().then((text) => {
      // 先做 JSON 语法校验，避免把损坏文件带进覆盖确认流程
      try { JSON.parse(text); } catch {
        store.setError('导入失败：文件不是合法 JSON，现有剧情树未改动');
        return;
      }
      setPendingImport(text);
    });
  }

  const pendingDelete = store.data.nodes.find((node) => node.id === pendingDeleteId) ?? null;
  const pendingDeleteCount = pendingDelete ? subtreeIds(store.data.nodes, pendingDelete.id).length : 0;

  if (!store.data.tree && !store.loading) {
    return (
      <section className="plot-workspace" aria-label="剧情">
        <div className="plot-empty">
          <h2>剧情</h2>
          <p>还没有剧情树。可以先建一棵空树手动搭建，或导入已有的 JSON 结构。</p>
          <div className="plot-form-actions">
            <button type="button" disabled={store.busy} onClick={() => void store.createTree()}>新建空树</button>
            <button type="button" disabled={store.busy} onClick={() => fileRef.current?.click()}>导入 JSON</button>
          </div>
          {pendingImport ? (
            <div className="plot-confirm" role="alertdialog" aria-label="确认导入">
              <p>导入将覆盖当前剧情树，确认继续？</p>
              <div className="plot-form-actions">
                <button type="button" onClick={() => {
                  void store.importJson(pendingImport).then(() => setPendingImport(null));
                }}>确认导入</button>
                <button type="button" onClick={() => setPendingImport(null)}>取消</button>
              </div>
            </div>
          ) : null}
          {store.error ? <p className="plot-error" role="alert">{store.error}</p> : null}
        </div>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={handleImportFile} />
      </section>
    );
  }

  return (
    <section className="plot-workspace" aria-label="剧情">
      <PlotToolbar
        view={store.view}
        onView={store.setView}
        zoom={zoom}
        onZoomIn={() => handleZoom(1)}
        onZoomOut={() => handleZoom(-1)}
        onFit={fitView}
        onReset={() => { setZoom(1); setPan({ x: 40, y: 40 }); }}
        search={search}
        onSearch={setSearch}
        originFilter={originFilter}
        onOriginFilter={setOriginFilter}
        groupFilter={groupFilter}
        onGroupFilter={setGroupFilter}
        groups={store.data.groups}
        resultCount={filtered.length}
        onAddNode={() => void store.addNode({ title: '新节点' })}
        onAddLink={() => {
          setLinking((current) => !current);
          setLinkSourceId(null);
        }}
        linking={linking}
        onAutoLayout={() => void store.applyLayout(autoLayout(store.data.nodes, store.data.groups))}
        canUndoLayout={store.lastLayoutSnapshot !== null}
        onUndoLayout={() => void store.undoLayout()}
        onExport={handleExport}
        onImport={() => fileRef.current?.click()}
        busy={store.busy}
      />
      <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={handleImportFile} />

      {pendingImport ? (
        <div className="plot-confirm" role="alertdialog" aria-label="确认导入">
          <p>导入将覆盖当前剧情树，确认继续？</p>
          <div className="plot-form-actions">
            <button type="button" onClick={() => {
              void store.importJson(pendingImport).then(() => setPendingImport(null));
            }}>确认导入</button>
            <button type="button" onClick={() => setPendingImport(null)}>取消</button>
          </div>
        </div>
      ) : null}

      {pendingDelete ? (
        <div className="plot-confirm" role="alertdialog" aria-label="确认删除节点">
          <p>删除「{pendingDelete.title}」将同时删除 {pendingDeleteCount} 个节点及其相关关联，确认继续？</p>
          <div className="plot-form-actions">
            <button type="button" className="plot-danger" onClick={() => {
              void store.removeNode(pendingDelete.id);
              setPendingDeleteId(null);
            }}>确认删除</button>
            <button type="button" onClick={() => setPendingDeleteId(null)}>取消</button>
          </div>
        </div>
      ) : null}

      {linking ? (
        <div className="plot-link-bar" role="status">
          <span>{linkSource ? `起点：${linkSource.title}，点击目标节点完成连线` : '点击起始节点'}</span>
          <label>
            类型
            <select value={linkType} onChange={(event) => setLinkType(event.target.value as PlotLink['type'])}>
              <option value="linear">线性（必须先发生）</option>
              <option value="non_linear">非线性（呼应）</option>
            </select>
          </label>
          <button type="button" onClick={() => { setLinking(false); setLinkSourceId(null); }}>取消</button>
        </div>
      ) : null}

      {store.loading ? <p className="plot-hint" role="status">正在加载剧情树…</p> : null}
      {store.error ? <p className="plot-error" role="alert">{store.error}</p> : null}
      {store.notice ? <p className="plot-notice" role="status">{store.notice}</p> : null}

      <div className="plot-viewport" ref={viewportRef}>
        {store.view === 'canvas' ? (
          <PlotCanvas
            nodes={store.data.nodes}
            links={store.data.links}
            groups={store.data.groups}
            selectedNodeId={store.selectedNodeId}
            selectedLinkId={store.selectedLinkId}
            highlightIds={highlightIds}
            zoom={zoom}
            pan={pan}
            onSelectNode={handleSelect}
            onSelectLink={store.selectLink}
            onDeleteNode={setPendingDeleteId}
            onMove={(updates) => void store.savePositions(updates)}
            onZoom={handleZoom}
          />
        ) : (
          <PlotNodeList
            nodes={filtered}
            selectedNodeId={store.selectedNodeId}
            onSelect={focusNode}
            onDelete={setPendingDeleteId}
          />
        )}
      </div>
    </section>
  );
}
