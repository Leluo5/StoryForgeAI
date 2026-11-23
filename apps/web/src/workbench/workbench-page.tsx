import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
import { ApiError } from '../api/client';
import { ChapterTree, type TreeAction } from './chapter-tree';
import { PanelCollapseToggle } from './panel-collapse-toggle';
import { EditorModeSlotContext } from '../editor/editor-mode-slot';
import { chapterUrl } from './chapter-url';
import { RevisionPanel } from '../revision/revision-panel';
import { VersionPanel } from '../revision/version-panel';
import { CommentPanel } from '../revision/comment-panel';
import { TodoPanel } from '../revision/todo-panel';
import { AiTaskPanel } from '../ai/ai-task-panel';
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
  const [panels, setPanels] = useState<PanelState>(() => readPanelState(workId));
  const [clientId] = useState(() => crypto.randomUUID());
  const [exporting, setExporting] = useState(false);
  // 页头「编辑模式切换」挂载点：state 承载，供 EditorPane 通过 context 拿到容器后 portal 富文本/Markdown 按钮
  const [modeSlotEl, setModeSlotEl] = useState<HTMLDivElement | null>(null);
  const leftDialog = useRef<HTMLDialogElement>(null);
  const rightDialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
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
    catch (cause) {
      // 未在作品库选择作品（或作品已被删除）直接进入工作台时，workId 无效返回 404，
      // 默认回到作品库，而不是停留在报错的工作台页面。
      if (cause instanceof ApiError && cause.status === 404) { navigate('/works', { replace: true }); return; }
      setError(cause instanceof Error ? cause.message : '作品结构加载失败');
    }
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

  // 合法右侧面板：chapter（章节信息）/ revision（修订）/ version（版本）/ comment（评论）/ todo（待办）/ ai（AI 创作）/ plot（剧情）/ role（角色版图）
  const PANELS = ['chapter', 'revision', 'version', 'comment', 'todo', 'ai', 'plot', 'role'];
  const currentPanel = PANELS.includes(searchParams.get('panel') ?? '') ? (searchParams.get('panel') as string) : 'chapter';
  // 中央页签：写作 / 剧情 / 角色版图 / 创作工具；非法深链参数就地归一化
  const currentTab = searchParams.get('tab') === 'plot' ? 'plot'
    : searchParams.get('tab') === 'roles' ? 'roles'
      : searchParams.get('tab') === 'tools' ? 'tools' : 'manuscript';
  // 角色深链：?tab=roles&panel=role&characterId=...；画布/列表打开详情与成长线跳转都写这里
  const currentCharacterId = searchParams.get('characterId');
  const characterChapters = tree?.chapters.map((chapter) => ({ id: chapter.id, title: chapter.title }));
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (!['manuscript', 'plot', 'roles', 'tools'].includes(next.get('tab') ?? '')) next.set('tab', 'manuscript');
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
  // 当前章节信息（需求4）：章名 + 字数，正文区左侧展示；章名双击可重命名（复用现有 prompt 编辑规范）
  const currentChapter = tree?.chapters.find((chapter) => chapter.id === chapterId);
  function renameCurrentChapter(): void {
    if (!currentChapter) return;
    const title = window.prompt('章节名称', currentChapter.title)?.trim();
    if (title && title !== currentChapter.title) void performAction({ type: 'rename_chapter', chapterId, title });
  }
  // 切换右侧面板：持久化到 ?panel= 查询参数，刷新/深链不丢
  function switchPanel(panel: string): void {
    if (!PANELS.includes(panel)) return;
    const next = new URLSearchParams(searchParams);
    next.set('panel', panel);
    setSearchParams(next);
  }
  // 切换中央页签：进入剧情/角色时同步打开对应右侧面板；回到写作时若面板停留在剧情/角色则回到章节信息
  function switchTab(tab: 'manuscript' | 'plot' | 'roles' | 'tools'): void {
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
  // 需求9：访问角色版图 / 剧情树 / 创作工具（独立中央视图）时，自动隐藏写作工作台左侧章节导航栏，
  // 让这些功能获得整宽展示空间；回到写作页签时恢复。复用 leftCollapsed 的 0px 宽度机制，不改 DOM。
  const leftNavHidden = currentTab === 'plot' || currentTab === 'roles' || currentTab === 'tools';
  // 列宽：页签隐藏（角色版图/剧情树/创作工具）→ 0px + display:none 彻底移除；
  // 手动收起（leftCollapsed）→ 保留 44px 窄轨放展开按钮（0px 会把按钮裁剪掉，无法再展开）；
  // 展开态 → 用户拖动的实际宽度
  const style = {
    '--left-width': leftNavHidden ? '0px' : panels.leftCollapsed ? '44px' : `${panels.leftWidth}px`,
    '--right-width': panels.rightCollapsed ? '0px' : `${panels.rightWidth}px`
  } as CSSProperties;

  return <EditorModeSlotContext.Provider value={modeSlotEl}>
  <PlotStoreProvider workId={workId} enabled={currentTab === 'plot' || currentPanel === 'plot'}
    client={client.plot ?? plotClient}>
    <div className="workbench">
    <header className="workbench-header">
      {/* 第一行：最左作品名称 + 保存状态（小字淡灰，紧跟），占满整宽 */}
      <div className="workbench-header-row">
        <h1>{tree?.work.title ?? '正在加载作品'}</h1>
        <SaveStatusView status={writer.status} onRetry={() => void writer.flush()} onTakeover={() => void writer.takeover()}
          onRestore={() => {
            void writer.restoreFromServer().catch((cause) => {
              setError(cause instanceof Error ? cause.message : '服务端恢复失败');
            });
          }} />
      </div>
      {/* 第二行：左侧数据动作（接管写入 / 导出恢复数据 / 打开章节导航 / 打开章节信息）→ 中间空白 →
          功能区（写作 / 角色版图 / 剧情树 / 创作工具）+ 返回作品库（强调色）。所有按钮统一 ghost 视觉，
          仅返回作品库用 --btn-accent-bg 强调，语义为「离开当前作品」。 */}
      <div className="workbench-header-row workbench-header-actions">
        {writer.readOnly && <Button variant="ghost" size="sm" onClick={() => void writer.takeover()}>接管写入</Button>}
        <Button variant="primary" size="sm" disabled={exporting} onClick={() => void downloadRecovery()}>{exporting ? '导出中' : '导出恢复数据'}</Button>
        <Button variant="ghost" size="sm" className="panel-trigger left-trigger" onClick={() => openDialog(leftDialog.current)}>打开章节导航</Button>
        <Button variant="primary" size="sm" className="panel-trigger right-trigger" onClick={() => openDialog(rightDialog.current)}>打开{currentPanel === 'revision' ? '修订' : currentPanel === 'version' ? '版本' : currentPanel === 'comment' ? '评论' : currentPanel === 'todo' ? '待办' : currentPanel === 'ai' ? 'AI 创作' : currentPanel === 'plot' ? '剧情' : '章节信息'}</Button>
        {/* 右侧功能区：入口组（写作/角色版图/剧情树/创作工具）+ 返回作品库。
            整体作为单一 flex item，margin-left:auto 推到最右；容器宽度不足换行时整组仍强制右对齐（需求2），
            避免返回按钮单独换行后出现左对齐/居中异常。 */}
        <div className="workbench-right-actions">
          <div className="workbench-feature-entries" role="group" aria-label="创作功能入口">
            <Button variant="primary" size="sm" onClick={() => switchTab('manuscript')}>写作</Button>
            <Button variant="primary" size="sm" onClick={() => switchTab('roles')}>角色版图</Button>
            <Button variant="primary" size="sm" onClick={() => switchTab('plot')}>剧情树</Button>
            <Button variant="primary" size="sm" onClick={() => switchTab('tools')}>创作工具</Button>
          </div>
          <Button variant="ghost" size="sm" className="btn-accent" onClick={() => navigate('/works')}>返回作品库</Button>
        </div>
      </div>
      {/* 第三行：富文本 / Markdown 编辑模式切换。正文编辑器通过 portal 把切换按钮挂到此容器（右对齐），
          模式状态仍留在 EditorPane 内；正文文本框填满剩余空间 */}
      <div className="workbench-editor-mode" aria-label="编辑模式切换"
        ref={(node) => { setModeSlotEl(node); }} />
    </header>
    {error && <p role="alert">{error}</p>}
    <div className="workbench-grid" style={style}>
      {/* 需求9：角色版图/剧情树/创作工具时隐藏左侧章节导航栏（grid 列宽 0 + display:none 彻底移除，避免 padding 残留窄缝） */}
      <aside className={`workbench-left${leftNavHidden ? ' is-hidden' : ''}${panels.leftCollapsed ? ' is-collapsed' : ''}`} aria-label="章节导航栏">
        {/* 折叠/展开按钮：与左侧共享导航工具栏的「展开/收起」同款样式（图标 + 文字 + 悬停底） */}
        <PanelCollapseToggle collapsed={panels.leftCollapsed} onToggle={() => updatePanels({ leftCollapsed: !panels.leftCollapsed })} />
        {!panels.leftCollapsed && navigation}
      </aside>
      <main className="workbench-center" aria-label="正文工作区">
        {/* 用 hidden 而不是卸载：切页签不能丢掉正文编辑器的未保存状态；角色版图未来也保持挂载以保留筛选状态 */}
        <div hidden={currentTab !== 'manuscript'}>
          {/* 需求4：正文区章节信息模块 —— 章名（视觉强调，双击重命名）+ 本章字数，左对齐 */}
          <div className="chapter-info-bar" aria-label="章节信息">
            <h2 className="chapter-info-bar__title" title={currentChapter?.title ?? ''}
              onDoubleClick={renameCurrentChapter}>{currentChapter?.title ?? '正在读取章节'}</h2>
            <span className="chapter-info-bar__words">本章 {currentChapter?.word_count ?? 0} 字</span>
          </div>
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
        {/* 创作工具独立中央视图：由 header「创作工具」按钮进入（tools 页签），独立展示 AI 创作面板 */}
        <div hidden={currentTab !== 'tools'}>
          <section role="tabpanel" aria-label="创作工具">
            <AiTaskPanel workId={workId} chapterId={chapterId} />
          </section>
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
      <h2 id="right-dialog-title">{currentPanel === 'revision' ? '修订' : currentPanel === 'version' ? '版本历史' : currentPanel === 'comment' ? '评论' : currentPanel === 'todo' ? '待办' : currentPanel === 'plot' ? '剧情' : currentPanel === 'role' ? '角色版图' : '章节信息'}</h2>
      <Button variant="ghost" size="sm" block onClick={() => rightDialog.current?.close()}>关闭右侧面板</Button>
      {context('dialog')}
    </dialog>
    <ConflictDialog conflict={writer.conflict} onResolve={writer.resolveConflict}
      onRestore={writer.restoreFromServer} onExport={writer.exportRecovery} />
  </div>
  </PlotStoreProvider>
  </EditorModeSlotContext.Provider>;
}
