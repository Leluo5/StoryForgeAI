import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { applyTheme, initialTheme, type Theme } from '@storyforge/design-tokens';
import { Button, Tabs } from '@storyforge/ui';
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
import { RevisionPanel } from '../revision/revision-panel';
import { VersionPanel } from '../revision/version-panel';
import { CommentPanel } from '../revision/comment-panel';
import { TodoPanel } from '../revision/todo-panel';
import { AiTaskPanel } from '../ai/ai-task-panel';
import { AgentPanel } from '../agent/agent-panel';
import { KnowledgePanel } from '../knowledge/knowledge-panel';
import { NotificationCenter } from '../revision/notification-center';
import { unreadCount } from '../revision/collab-client';
import { PlotWorkspace, PlotStoreProvider } from '../plot/plot-workspace';
import { PlotInspector } from '../plot/plot-inspector';
import { PlotDerivationPanel } from '../plot/plot-derivation-panel';
import { plotClient, type PlotClient } from '../plot/plot-client';
import { CharacterWorkspace } from '../character/character-workspace';
import { CharacterRolePanel } from '../character/character-role-panel';
import { characterClient } from '../character/character-client';
import type { ChapterRoleMarkNotice, RoleMark } from '../editor/role-marks';
import '../plot/plot.css';
import '../character/character.css';
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
  /** 剧情页签客户端（测试可注入） */
  plot?: PlotClient;
}

const defaultClient: WorkbenchClient = {
  getTree, createVolume, renameVolume, reorderVolumes, createChapter, renameChapter,
  reorderChapters, getChapter, saveChange, plot: plotClient
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
  const noticeDialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [noticeUnread, setNoticeUnread] = useState(0);
  // 打开通知中心时递增 key，强制 NotificationCenter 重新挂载（其内部 useEffect 重新拉取最新数据）
  const [noticeOpenKey, setNoticeOpenKey] = useState(0);
  // 面板宽度拖动高频触发 onChange：用 rAF 把 setPanels 合并到每帧一次，并把 localStorage 写入移出 setState updater 且防抖，
  // 否则每次拖动都会同步阻塞主线程（实测约 12.6ms/次，超过 60fps 一帧预算）导致布局掉帧闪烁。
  const latestPanels = useRef(panels);
  const pendingPanels = useRef<Partial<PanelState> | undefined>(undefined);
  const panelFrame = useRef<number | undefined>(undefined);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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

  // 角色归档段落标记（T39）：按章节读取命中段落，作为编辑器装饰层数据源；失败静默降级为无标记
  const [roleMarks, setRoleMarks] = useState<RoleMark[]>([]);
  const [chapterMarks, setChapterMarks] = useState<ChapterRoleMarkNotice[]>([]);
  const loadRoleMarks = useCallback(async () => {
    if (!workId || !chapterId) {
      setRoleMarks([]);
      setChapterMarks([]);
      return;
    }
    try {
      const marks = await characterClient.getChapterRoleMarks(workId, chapterId);
      setRoleMarks(
        marks.paragraph_marks
          .filter((mark) => mark.status === 'active')
          .map((mark) => ({ pid: mark.paragraph_pid, label: `${mark.character_name}（${mark.matched_name}）`, anchorId: mark.id }))
      );
      setChapterMarks(marks.chapter_marks.map((mark) => ({ label: mark.label })));
    } catch {
      setRoleMarks([]);
      setChapterMarks([]);
    }
  }, [workId, chapterId]);
  useEffect(() => { void loadRoleMarks(); }, [loadRoleMarks]);

  // 通知未读数（header 铃铛角标）；通知中心打开时由 NotificationCenter 自身刷新，这里仅作入口角标
  useEffect(() => {
    let active = true;
    void unreadCount().then((count) => { if (active) setNoticeUnread(count.unread); }).catch(() => {});
    return () => { active = false; };
  }, []);

  // 合法右侧面板：chapter（章节信息）/ revision（修订）/ version（版本）/ comment（评论）/ todo（待办）/ ai（AI 创作）/ agent（Agent 管理）/ knowledge（知识库）/ plot（剧情）/ role（角色版图）
  const PANELS = ['chapter', 'revision', 'version', 'comment', 'todo', 'ai', 'agent', 'knowledge', 'plot', 'role'];
  const currentPanel = PANELS.includes(searchParams.get('panel') ?? '') ? (searchParams.get('panel') as string) : 'chapter';
  // 中央页签：正文 / 剧情 / 角色版图；非法深链参数就地归一化
  const currentTab = searchParams.get('tab') === 'plot' ? 'plot' : searchParams.get('tab') === 'roles' ? 'roles' : 'manuscript';
  // 角色深链：?tab=roles&panel=role&characterId=...；画布/列表打开详情与成长线跳转都写这里
  const currentCharacterId = searchParams.get('characterId');
  const characterChapters = tree?.chapters.map((chapter) => ({ id: chapter.id, title: chapter.title }));
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (next.get('tab') !== 'manuscript' && next.get('tab') !== 'plot' && next.get('tab') !== 'roles') next.set('tab', 'manuscript');
    if (!PANELS.includes(next.get('panel') ?? '')) {
      if (next.get('tab') === 'plot') next.set('panel', 'plot');
      else if (next.get('tab') === 'roles') next.set('panel', 'role');
      else next.set('panel', 'chapter');
    }
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const close = () => { if (query.matches) { leftDialog.current?.close(); rightDialog.current?.close(); } };
    query.addEventListener('change', close);
    return () => query.removeEventListener('change', close);
  }, []);

  // 卸载时清理面板拖动的 rAF 与持久化防抖定时器，避免泄漏
  useEffect(() => {
    return () => {
      if (panelFrame.current !== undefined) cancelAnimationFrame(panelFrame.current);
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, []);

  function updatePanels(patch: Partial<PanelState>): void {
    // 合并连续拖动中的多次 patch，每帧只触发一次 setPanels（避免高频 onChange 整页重渲染掉帧）
    pendingPanels.current = { ...pendingPanels.current, ...patch };
    if (panelFrame.current !== undefined) return;
    panelFrame.current = requestAnimationFrame(() => {
      panelFrame.current = undefined;
      const pending = pendingPanels.current;
      pendingPanels.current = undefined;
      if (!pending) return;
      setPanels((current) => {
        const next = { ...current, ...pending };
        latestPanels.current = next;
        return next;
      });
      // localStorage 写入是同步 IO，从 setState updater 移出并防抖，避免拖动时阻塞主线程
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        localStorage.setItem(`storyforge-workbench:${workId}`, JSON.stringify(latestPanels.current));
      }, 150);
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
  // 切换右侧面板：持久化到 ?panel= 查询参数，刷新/深链不丢
  function switchPanel(panel: string): void {
    if (!PANELS.includes(panel)) return;
    const next = new URLSearchParams(searchParams);
    next.set('panel', panel);
    setSearchParams(next);
  }
  // 切换中央页签：进入剧情/角色时同步打开对应右侧面板；回到正文时若面板停留在剧情/角色则回到章节信息
  function switchTab(tab: 'manuscript' | 'plot' | 'roles'): void {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    if (tab === 'plot') next.set('panel', 'plot');
    else if (tab === 'roles') next.set('panel', 'role');
    else if (next.get('panel') === 'plot' || next.get('panel') === 'role') next.set('panel', 'chapter');
    setSearchParams(next);
  }
  // 打开角色详情：切到角色页签与角色面板，并把 characterId 写入深链，返回/刷新不丢
  function openCharacter(characterId: string): void {
    const next = new URLSearchParams(searchParams);
    next.set('tab', 'roles');
    next.set('panel', 'role');
    next.set('characterId', characterId);
    setSearchParams(next);
  }
  function closeCharacter(): void {
    const next = new URLSearchParams(searchParams);
    next.delete('characterId');
    setSearchParams(next);
  }
  function context(idSuffix: string) {
    const widthId = `right-width-${idSuffix}`;
    const tabs = <Tabs
      label="右侧面板"
      items={[
        { key: 'chapter', label: '章节信息' },
        { key: 'revision', label: '修订' },
        { key: 'version', label: '版本' },
        { key: 'comment', label: '评论' },
        { key: 'todo', label: '待办' },
        { key: 'ai', label: 'AI 创作' },
        { key: 'agent', label: 'Agent 管理' },
        { key: 'knowledge', label: '知识库' },
        { key: 'plot', label: '剧情' },
        { key: 'role', label: '角色' },
      ]}
      activeKey={currentPanel}
      onChange={(key) => switchPanel(key)}
    />;
    let body: JSX.Element;
    if (currentPanel === 'revision') {
      body = <RevisionPanel workId={workId} chapterId={chapterId} />;
    } else if (currentPanel === 'version') {
      body = <VersionPanel workId={workId} chapterId={chapterId} />;
    } else if (currentPanel === 'comment') {
      body = <CommentPanel workId={workId} chapterId={chapterId} />;
    } else if (currentPanel === 'todo') {
      body = <TodoPanel workId={workId} />;
    } else if (currentPanel === 'ai') {
      body = <section role="tabpanel" aria-label="AI 创作">
        <AiTaskPanel workId={workId} chapterId={chapterId} />
      </section>;
    } else if (currentPanel === 'agent') {
      body = <section role="tabpanel" aria-label="Agent 管理">
        <AgentPanel />
      </section>;
    } else if (currentPanel === 'knowledge') {
      body = <section role="tabpanel" aria-label="知识库">
        <KnowledgePanel />
      </section>;
    } else if (currentPanel === 'plot') {
      body = <section role="tabpanel" aria-label="剧情" className="plot-side">
        <PlotInspector />
        <PlotDerivationPanel workId={workId} client={client.plot ?? plotClient} />
      </section>;
    } else if (currentPanel === 'role') {
      body = (
        <section id={`role-panel-${idSuffix}`} role="tabpanel" aria-labelledby={`role-tab-${idSuffix}`} className="character-side-panel">
          <CharacterRolePanel
            workId={workId}
            characterId={currentCharacterId}
            chapters={characterChapters}
            onOpenChapter={(chapterId, characterId) => {
              navigate(`/works/${workId}/write/${chapterId}?tab=roles&panel=role&characterId=${characterId}`);
            }}
          />
          {currentCharacterId ? (
            <button type="button" className="character-role-close" onClick={closeCharacter}>关闭角色详情</button>
          ) : null}
        </section>
      );
    } else {
      body = <section aria-label="章节信息">
        <h2>章节信息</h2>
        <p>章节：{writer.chapter?.title ?? '正在读取'}</p>
        <p>服务端版本：{writer.chapter?.version ?? 0}</p>
        <p>客户端 ID：{clientId}</p>
        <label htmlFor={widthId}>右侧栏宽度</label>
        <input id={widthId} aria-label="右侧栏宽度" type="range" min="220" max="420" step="8"
          value={panels.rightWidth} onChange={(event) => updatePanels({ rightWidth: Number(event.target.value) })} />
      </section>;
    }
    return <div className="context-body">{tabs}{body}</div>;
  }
  const style = {
    '--left-width': panels.leftCollapsed ? '0px' : `${panels.leftWidth}px`,
    '--right-width': panels.rightCollapsed ? '0px' : `${panels.rightWidth}px`
  } as CSSProperties;

  return <PlotStoreProvider workId={workId} enabled={currentTab === 'plot' || currentPanel === 'plot'}
    client={client.plot ?? plotClient}>
    <div className="workbench">
    <header className="workbench-header">
      <Link to="/works">返回作品库</Link>
      <Button variant="ghost" size="sm" className="panel-trigger left-trigger" onClick={() => openDialog(leftDialog.current)}>打开章节导航</Button>
      <h1>{tree?.work.title ?? '正在加载作品'}</h1>
      <SaveStatusView status={writer.status} onRetry={() => void writer.flush()} onTakeover={() => void writer.takeover()}
        onRestore={() => {
          void writer.restoreFromServer().catch((cause) => {
            setError(cause instanceof Error ? cause.message : '服务端恢复失败');
          });
        }} />
      <Button variant="ghost" size="sm" disabled={exporting} onClick={() => void downloadRecovery()}>{exporting ? '导出中' : '导出恢复数据'}</Button>
      <Button variant="ghost" size="sm" onClick={() => {
        const next = theme === 'light' ? 'dark' : 'light'; setTheme(next); applyTheme(next);
      }}>{theme === 'light' ? '切换深色主题' : '切换浅色主题'}</Button>
      <Button variant="ghost" size="sm" aria-label={`通知（${noticeUnread} 条未读）`} onClick={() => {
        // 每次打开刷新角标，并强制通知中心重新拉取最新通知
        void unreadCount().then((count) => setNoticeUnread(count.unread)).catch(() => {});
        setNoticeOpenKey((key) => key + 1);
        openDialog(noticeDialog.current);
      }}>通知{noticeUnread > 0 ? `(${noticeUnread})` : ''}</Button>
      <Button variant="ghost" size="sm" className="panel-trigger right-trigger" onClick={() => openDialog(rightDialog.current)}>打开{currentPanel === 'revision' ? '修订' : currentPanel === 'version' ? '版本' : currentPanel === 'comment' ? '评论' : currentPanel === 'todo' ? '待办' : currentPanel === 'ai' ? 'AI 创作' : currentPanel === 'agent' ? 'Agent 管理' : currentPanel === 'knowledge' ? '知识库' : currentPanel === 'plot' ? '剧情' : '章节信息'}</Button>
    </header>
    {error && <p role="alert">{error}</p>}
    <div className="workbench-grid" style={style}>
      <aside className="workbench-left" aria-label="章节导航栏">
        <Button variant="ghost" size="sm" block onClick={() => updatePanels({ leftCollapsed: !panels.leftCollapsed })}>
          {panels.leftCollapsed ? '展开左侧栏' : '折叠左侧栏'}
        </Button>
        {!panels.leftCollapsed && <>
          <label htmlFor="left-width">左侧栏宽度</label>
          <input id="left-width" aria-label="左侧栏宽度" type="range" min="200" max="400" step="8"
            value={panels.leftWidth} onChange={(event) => updatePanels({ leftWidth: Number(event.target.value) })} />
          {navigation}
        </>}
      </aside>
      <main className="workbench-center" aria-label="正文工作区">
        <div className="center-tabs">
          <Tabs
            label="中央工作区页签"
            items={[
              { key: 'manuscript', label: '正文' },
              { key: 'plot', label: '剧情' },
              { key: 'roles', label: '角色版图' },
            ]}
            activeKey={currentTab}
            onChange={(key) => switchTab(key as 'manuscript' | 'plot' | 'roles')}
          />
        </div>
        {/* 用 hidden 而不是卸载：切页签不能丢掉正文编辑器的未保存状态；角色版图未来也保持挂载以保留筛选状态 */}
        <div hidden={currentTab !== 'manuscript'}>
          <EditorPane initialDocument={writer.document} readOnly={writer.readOnly}
            roleMarks={roleMarks} chapterMarks={chapterMarks}
            onDismissMark={(mark) => {
              if (!mark.anchorId) return;
              void characterClient.dismissAnchor(workId, chapterId, mark.anchorId)
                .then(() => loadRoleMarks())
                .catch(() => {});
            }}
            onDocument={(operations, next) => { void writer.append(operations, next); }}
            onMarkdownDraft={writer.saveMarkdownDraft} />
        </div>
        <div hidden={currentTab !== 'plot'}>
          <PlotWorkspace />
        </div>
        <div className="roles-tab-panel" hidden={currentTab !== 'roles'}>
          <CharacterWorkspace
            workId={workId}
            onOpenCharacter={openCharacter}
            onArchiveRequest={openCharacter}
            chapters={characterChapters}
          />
        </div>
      </main>
      <aside className="workbench-right" aria-label="章节上下文栏">
        <Button variant="ghost" size="sm" block onClick={() => updatePanels({ rightCollapsed: !panels.rightCollapsed })}>
          {panels.rightCollapsed ? '展开右侧栏' : '折叠右侧栏'}
        </Button>
        {!panels.rightCollapsed && context('desktop')}
      </aside>
    </div>
    <dialog ref={leftDialog} className="workbench-dialog left-dialog" aria-labelledby="left-dialog-title" onClose={restoreDialogFocus}>
      <h2 id="left-dialog-title">章节导航</h2>
      <Button variant="ghost" size="sm" block onClick={() => leftDialog.current?.close()}>关闭章节导航</Button>
      {navigation}
    </dialog>
    <dialog ref={rightDialog} className="workbench-dialog right-dialog" aria-labelledby="right-dialog-title" onClose={restoreDialogFocus}>
      <h2 id="right-dialog-title">{currentPanel === 'revision' ? '修订' : currentPanel === 'version' ? '版本历史' : currentPanel === 'comment' ? '评论' : currentPanel === 'todo' ? '待办' : currentPanel === 'agent' ? 'Agent 管理' : currentPanel === 'knowledge' ? '知识库' : currentPanel === 'plot' ? '剧情' : currentPanel === 'role' ? '角色版图' : '章节信息'}</h2>
      <Button variant="ghost" size="sm" block onClick={() => rightDialog.current?.close()}>关闭右侧面板</Button>
      {context('dialog')}
    </dialog>
    <dialog ref={noticeDialog} className="workbench-dialog notice-dialog" aria-labelledby="notice-dialog-title" onClose={restoreDialogFocus}>
      <h2 id="notice-dialog-title">通知中心</h2>
      <Button variant="ghost" size="sm" block onClick={() => noticeDialog.current?.close()}>关闭通知</Button>
      <NotificationCenter key={noticeOpenKey} />
    </dialog>
    <ConflictDialog conflict={writer.conflict} onResolve={writer.resolveConflict}
      onRestore={writer.restoreFromServer} onExport={writer.exportRecovery} />
  </div>
  </PlotStoreProvider>;
}
