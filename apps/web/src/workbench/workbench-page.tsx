import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { applyTheme, initialTheme, type Theme } from '@storyforge/design-tokens';
import type { SaveChangeRequest, TreeResponse } from '@storyforge/contracts';
import { ConflictDialog } from '../editor/conflict-dialog';
import { EditorPane } from '../editor/editor-pane';
import { SaveStatusView } from '../editor/save-status';
import { useChapterWriter } from '../editor/use-chapter-writer';
import {
  createChapter, createVolume, getChapter, getTree, renameChapter, renameVolume,
  reorderChapters, reorderVolumes, saveChange
} from '../works/writing-client';
import { ChapterTree, type TreeAction } from './chapter-tree';
import { chapterUrl } from './chapter-url';
import './workbench.css';

export interface WorkbenchClient {
  getTree: typeof getTree;
  createVolume: typeof createVolume;
  renameVolume: typeof renameVolume;
  reorderVolumes: typeof reorderVolumes;
  createChapter: typeof createChapter;
  renameChapter: typeof renameChapter;
  reorderChapters: typeof reorderChapters;
  getChapter: typeof getChapter;
  saveChange: (workId: string, chapterId: string, input: SaveChangeRequest) => ReturnType<typeof saveChange>;
}

const defaultClient: WorkbenchClient = {
  getTree, createVolume, renameVolume, reorderVolumes, createChapter, renameChapter,
  reorderChapters, getChapter, saveChange
};

interface PanelState {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}
const defaults: PanelState = { leftWidth: 264, rightWidth: 280, leftCollapsed: false, rightCollapsed: false };
// 只接受合法区间内的持久化宽度，损坏数据回退默认值
function readPanelState(workId: string): PanelState {
  try {
    const value = JSON.parse(localStorage.getItem(`storyforge-workbench:${workId}`) ?? '{}') as Partial<PanelState>;
    return {
      leftWidth: typeof value.leftWidth === 'number' && value.leftWidth >= 200 && value.leftWidth <= 400 ? value.leftWidth : 264,
      rightWidth: typeof value.rightWidth === 'number' && value.rightWidth >= 220 && value.rightWidth <= 420 ? value.rightWidth : 280,
      leftCollapsed: value.leftCollapsed === true,
      rightCollapsed: value.rightCollapsed === true
    };
  } catch { return defaults; }
}

interface Props { client?: WorkbenchClient }

// key 让章节切换时旧 hook 先完成卸载 flush，再为新章节建租约与恢复状态
export function WorkbenchRoute({ client = defaultClient }: Props) {
  const { workId = '', chapterId = '' } = useParams();
  return <WorkbenchPage key={`${workId}:${chapterId}`} client={client} />;
}

export function WorkbenchPage({ client = defaultClient }: Props) {
  const { workId = '', chapterId = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tree, setTree] = useState<TreeResponse>();
  const [error, setError] = useState('');
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [panels, setPanels] = useState<PanelState>(() => readPanelState(workId));
  const [clientId] = useState(() => crypto.randomUUID());
  const [exporting, setExporting] = useState(false);
  const leftDialog = useRef<HTMLDialogElement>(null);
  const rightDialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const writer = useChapterWriter({
    workId, chapterId, clientId,
    loadChapter: () => client.getChapter(workId, chapterId),
    saveChange: client.saveChange
  });

  const loadTree = useCallback(async () => {
    try { setTree(await client.getTree(workId)); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '作品结构加载失败'); }
  }, [client, workId]);
  useEffect(() => { void loadTree(); }, [loadTree]);

  // M1 只有正文页签，非法深链参数就地归一化
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (next.get('tab') !== 'manuscript') next.set('tab', 'manuscript');
    if (next.get('panel') !== 'chapter') next.set('panel', 'chapter');
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const close = () => { if (query.matches) { leftDialog.current?.close(); rightDialog.current?.close(); } };
    query.addEventListener('change', close);
    return () => query.removeEventListener('change', close);
  }, []);

  function updatePanels(patch: Partial<PanelState>): void {
    setPanels((current) => {
      const next = { ...current, ...patch };
      localStorage.setItem(`storyforge-workbench:${workId}`, JSON.stringify(next));
      return next;
    });
  }

  async function performAction(action: TreeAction): Promise<string | undefined> {
    let createdId: string | undefined;
    if (action.type === 'create_volume') await client.createVolume(workId, { title: action.title });
    if (action.type === 'rename_volume') await client.renameVolume(workId, action.volumeId, { title: action.title });
    if (action.type === 'move_volume' && tree) {
      const ordered = [...tree.volumes].sort((a, b) => a.position - b.position).map((volume) => volume.id);
      const index = ordered.indexOf(action.volumeId);
      const target = index + action.direction;
      if (index >= 0 && target >= 0 && target < ordered.length) {
        [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
        await client.reorderVolumes(workId, ordered);
      }
    }
    if (action.type === 'create_chapter') {
      createdId = (await client.createChapter(workId, action.volumeId, { title: action.title })).id;
    }
    if (action.type === 'rename_chapter') await client.renameChapter(workId, action.chapterId, { title: action.title });
    if (action.type === 'move_chapter' && tree) {
      const ordered = tree.chapters.filter((chapter) => chapter.volume_id === action.volumeId)
        .sort((a, b) => a.position - b.position).map((chapter) => chapter.id);
      const index = ordered.indexOf(action.chapterId);
      const target = index + action.direction;
      if (index >= 0 && target >= 0 && target < ordered.length) {
        [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
        await client.reorderChapters(workId, action.volumeId, ordered);
      }
    }
    await loadTree();
    return createdId;
  }

  function openDialog(dialog: HTMLDialogElement | null): void {
    if (!dialog) return;
    returnFocus.current = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('button, a, input')?.focus();
  }
  // 关闭侧栏对话框后把焦点还给触发按钮
  function restoreDialogFocus(): void {
    returnFocus.current?.focus();
    returnFocus.current = null;
  }

  async function downloadRecovery(): Promise<void> {
    if (exporting) return;
    setExporting(true); setError('');
    try {
      const blob = new Blob([await writer.exportRecovery()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url; anchor.download = `chapter-${chapterId}-recovery.json`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '恢复数据导出失败');
    } finally { setExporting(false); }
  }

  const navigation = tree ? <ChapterTree tree={tree} currentChapterId={chapterId}
    onOpen={(id) => navigate(chapterUrl(workId, id))} onAction={performAction} /> : <p role="status">正在加载章节</p>;
  function context(idSuffix: string) {
    const widthId = `right-width-${idSuffix}`;
    return <section aria-label="章节信息">
      <h2>章节信息</h2>
      <p>章节：{writer.chapter?.title ?? '正在读取'}</p>
      <p>服务端版本：{writer.chapter?.version ?? 0}</p>
      <p>客户端 ID：{clientId}</p>
      <label htmlFor={widthId}>右侧栏宽度</label>
      <input id={widthId} aria-label="右侧栏宽度" type="range" min="220" max="420" step="8"
        value={panels.rightWidth} onChange={(event) => updatePanels({ rightWidth: Number(event.target.value) })} />
    </section>;
  }
  const style = {
    '--left-width': panels.leftCollapsed ? '0px' : `${panels.leftWidth}px`,
    '--right-width': panels.rightCollapsed ? '0px' : `${panels.rightWidth}px`
  } as CSSProperties;

  return <div className="workbench">
    <header className="workbench-header">
      <Link to="/works">返回作品库</Link>
      <button className="panel-trigger left-trigger" type="button" onClick={() => openDialog(leftDialog.current)}>打开章节导航</button>
      <h1>{tree?.work.title ?? '正在加载作品'}</h1>
      <SaveStatusView status={writer.status} onRetry={() => void writer.flush()} onTakeover={() => void writer.takeover()}
        onRestore={() => {
          void writer.restoreFromServer().catch((cause) => {
            setError(cause instanceof Error ? cause.message : '服务端恢复失败');
          });
        }} />
      <button type="button" disabled={exporting} onClick={() => void downloadRecovery()}>{exporting ? '导出中' : '导出恢复数据'}</button>
      <button type="button" onClick={() => {
        const next = theme === 'light' ? 'dark' : 'light'; setTheme(next); applyTheme(next);
      }}>{theme === 'light' ? '切换深色主题' : '切换浅色主题'}</button>
      <button className="panel-trigger right-trigger" type="button" onClick={() => openDialog(rightDialog.current)}>打开章节信息</button>
    </header>
    {error && <p role="alert">{error}</p>}
    <div className="workbench-grid" style={style}>
      <aside className="workbench-left" aria-label="章节导航栏">
        <button type="button" onClick={() => updatePanels({ leftCollapsed: !panels.leftCollapsed })}>
          {panels.leftCollapsed ? '展开左侧栏' : '折叠左侧栏'}
        </button>
        {!panels.leftCollapsed && <>
          <label htmlFor="left-width">左侧栏宽度</label>
          <input id="left-width" aria-label="左侧栏宽度" type="range" min="200" max="400" step="8"
            value={panels.leftWidth} onChange={(event) => updatePanels({ leftWidth: Number(event.target.value) })} />
          {navigation}
        </>}
      </aside>
      <main className="workbench-center" aria-label="正文工作区">
        <EditorPane initialDocument={writer.document} readOnly={writer.readOnly}
          onDocument={(operations, next) => { void writer.append(operations, next); }}
          onMarkdownDraft={writer.saveMarkdownDraft} />
      </main>
      <aside className="workbench-right" aria-label="章节上下文栏">
        <button type="button" onClick={() => updatePanels({ rightCollapsed: !panels.rightCollapsed })}>
          {panels.rightCollapsed ? '展开右侧栏' : '折叠右侧栏'}
        </button>
        {!panels.rightCollapsed && context('desktop')}
      </aside>
    </div>
    <dialog ref={leftDialog} className="workbench-dialog left-dialog" aria-labelledby="left-dialog-title" onClose={restoreDialogFocus}>
      <h2 id="left-dialog-title">章节导航</h2>
      <button type="button" onClick={() => leftDialog.current?.close()}>关闭章节导航</button>
      {navigation}
    </dialog>
    <dialog ref={rightDialog} className="workbench-dialog right-dialog" aria-labelledby="right-dialog-title" onClose={restoreDialogFocus}>
      <h2 id="right-dialog-title">章节信息</h2>
      <button type="button" onClick={() => rightDialog.current?.close()}>关闭章节信息</button>
      {context('dialog')}
    </dialog>
    <ConflictDialog conflict={writer.conflict} onResolve={writer.resolveConflict}
      onRestore={writer.restoreFromServer} onExport={writer.exportRecovery} />
  </div>;
}
