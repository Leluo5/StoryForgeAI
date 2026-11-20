import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type {
  ArchiveScanStatus,
  ChapterMark,
  ChapterParagraphMark
} from '@storyforge/contracts';
import type { CharacterClient } from './character-client';
import { characterAnchorClient, type CharacterAnchorClient } from './character-anchor-client';
import { characterErrorMessage } from './character-state';
import './character-anchor-panel.css';

/** 归档影响计数（与 contracts 的 characterArchiveImpactSchema 同构） */
export interface ArchiveImpactSummary {
  relations: number;
  growth_events: number;
  chapters: number;
  exclusive_plot_nodes: number;
}

interface Props {
  workId: string;
  characterId: string;
  client?: CharacterClient;
  /** 章节列表来源；不传则仅展示锚点自身携带的 chapter_id，无法解析章节名时降级显示 id 前 8 位 */
  chapters?: { id: string; title: string }[];
  /** 需要读取命中段落的章节；为空时展示「需要先选择章节」空态 */
  chapterIds?: string[];
  /** 由归档确认流程传入的影响摘要；不传时按已加载数据统计 */
  impact?: ArchiveImpactSummary;
  /** 依赖注入点：默认使用共享的 characterAnchorClient */
  anchorClient?: CharacterAnchorClient;
  onDismissed?: () => void;
}

type LoadedMark = ChapterParagraphMark & { chapter_id: string };
type LoadedChapterMark = ChapterMark & { chapter_id: string };

interface ScanView {
  status: ArchiveScanStatus;
  scanned: number;
  total: number;
}

const SCAN_STATUS_TEXT: Record<ArchiveScanStatus, string> = {
  pending: '扫描中',
  running: '扫描中',
  succeeded: '已完成',
  failed: '扫描失败'
};

// 文字 + 图标双通道，避免只靠颜色传达状态
const SCAN_STATUS_ICON: Record<ArchiveScanStatus, string> = {
  pending: '⏳',
  running: '⏳',
  succeeded: '✓',
  failed: '!'
};

/**
 * 归档命中面板（T38）：
 * 1) 影响摘要（外部 impact 优先，否则按已加载锚点统计，不编造数字）；
 * 2) 扫描进度三态：扫描中 / 扫描失败（可重试）/ 仅 succeeded 显示已完成；
 * 3) 命中段落列表：章节名 + 摘录 + 命中名称，支持单条 / 全选 / 反选 / 批量剔除。
 */
export function CharacterAnchorPanel(props: Props): JSX.Element {
  const anchorClientRef = useRef<CharacterAnchorClient>(props.anchorClient ?? characterAnchorClient);
  anchorClientRef.current = props.anchorClient ?? characterAnchorClient;

  const [marks, setMarks] = useState<LoadedMark[]>([]);
  const [chapterMarks, setChapterMarks] = useState<LoadedChapterMark[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [scan, setScan] = useState<ScanView | null>(null);
  const [scanError, setScanError] = useState('');
  const [scanBusy, setScanBusy] = useState(false);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const chapterKey = (props.chapterIds ?? []).join(',');

  const titleOf = useCallback(
    (chapterId: string): string =>
      props.chapters?.find((chapter) => chapter.id === chapterId)?.title ?? chapterId.slice(0, 8),
    [props.chapters]
  );

  const load = useCallback(async () => {
    const chapterIds = props.chapterIds ?? [];
    if (chapterIds.length === 0) {
      setMarks([]);
      setChapterMarks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError('');
    try {
      const results = await Promise.all(
        chapterIds.map(async (chapterId) => ({
          chapterId,
          marks: await anchorClientRef.current.getChapterRoleMarks(props.workId, chapterId)
        }))
      );
      setMarks(
        results.flatMap(({ chapterId, marks: result }) =>
          result.paragraph_marks.map((mark) => ({ ...mark, chapter_id: chapterId }))
        )
      );
      setChapterMarks(
        results.flatMap(({ chapterId, marks: result }) =>
          result.chapter_marks.map((mark) => ({ ...mark, chapter_id: chapterId }))
        )
      );
      const first = results[0];
      if (first) {
        const firstScan = first.marks.scan;
        setScan((prev) => prev ?? {
          status: firstScan.status,
          scanned: firstScan.scanned_chapters,
          total: firstScan.total_chapters
        });
      }
      setSelected(new Set());
    } catch (cause) {
      setMarks([]);
      setChapterMarks([]);
      setLoadError(characterErrorMessage(cause));
    } finally {
      setLoading(false);
    }
    // chapterKey 覆盖 chapterIds 的内容变化；chapterIds 数组本身可能每次渲染都是新引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workId, chapterKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const rescan = useCallback(async () => {
    setScanBusy(true);
    setScanError('');
    try {
      const result = await anchorClientRef.current.rescanArchive(props.workId, props.characterId);
      setScan({
        status: result.scan.status,
        scanned: result.scan.scanned_chapters,
        total: result.scan.total_chapters
      });
    } catch (cause) {
      setScan({ status: 'failed', scanned: 0, total: 0 });
      setScanError(characterErrorMessage(cause));
    } finally {
      setScanBusy(false);
    }
  }, [props.workId, props.characterId]);

  const dismissOne = useCallback(
    async (mark: LoadedMark) => {
      setDismissingId(mark.id);
      setLoadError('');
      try {
        await anchorClientRef.current.dismissAnchor(props.workId, mark.chapter_id, mark.id);
        setMarks((prev) => prev.filter((item) => item.id !== mark.id));
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(mark.id);
          return next;
        });
        setNotice('已剔除 1 条');
        props.onDismissed?.();
      } catch (cause) {
        setLoadError(characterErrorMessage(cause));
      } finally {
        setDismissingId(null);
      }
    },
    [props.workId, props.onDismissed]
  );

  const batchDismiss = useCallback(async () => {
    if (selected.size === 0) return;
    const byChapter = new Map<string, string[]>();
    for (const mark of marks) {
      if (!selected.has(mark.id)) continue;
      const bucket = byChapter.get(mark.chapter_id);
      if (bucket) bucket.push(mark.id);
      else byChapter.set(mark.chapter_id, [mark.id]);
    }
    setBatchBusy(true);
    setLoadError('');
    try {
      const results = await Promise.all(
        [...byChapter].map(([chapterId, anchorIds]) =>
          anchorClientRef.current.dismissAnchorsBatch(props.workId, chapterId, anchorIds)
        )
      );
      const total = results.reduce((sum, result) => sum + result.dismissed, 0);
      setMarks((prev) => prev.filter((mark) => !selected.has(mark.id)));
      setSelected(new Set());
      setNotice(`已剔除 ${total} 条`);
      props.onDismissed?.();
    } catch (cause) {
      setLoadError(characterErrorMessage(cause));
    } finally {
      setBatchBusy(false);
    }
  }, [marks, selected, props.workId, props.onDismissed]);

  const impactText = useMemo(() => {
    if (props.impact) {
      const { relations, growth_events, chapters, exclusive_plot_nodes } = props.impact;
      return `归档影响：关系 ${relations} 条、成长事件 ${growth_events} 个、涉及章节 ${chapters} 章、专属剧情节点 ${exclusive_plot_nodes} 个。`;
    }
    if ((props.chapterIds ?? []).length === 0) {
      return '选择章节后可统计命中段落与章节级提示。';
    }
    const covered = new Set(marks.map((mark) => mark.chapter_id)).size;
    return `命中段落 ${marks.length} 条，覆盖 ${covered} 章；章节级提示 ${chapterMarks.length} 条。`;
  }, [props.impact, props.chapterIds, marks, chapterMarks]);

  const allSelected = marks.length > 0 && selected.size === marks.length;
  const hasChapters = (props.chapterIds ?? []).length > 0;

  function toggleOne(id: string, checked: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(): void {
    setSelected(allSelected ? new Set() : new Set(marks.map((mark) => mark.id)));
  }

  function invertSelection(): void {
    setSelected(new Set(marks.filter((mark) => !selected.has(mark.id)).map((mark) => mark.id)));
  }

  return (
    <section className="character-anchor-panel" aria-label="归档命中段落">
      <h2 className="character-anchor-panel__title">角色归档影响</h2>
      <p className="character-anchor-panel__impact">{impactText}</p>

      <section className="character-anchor-panel__scan" aria-label="归档扫描进度">
        <h3>归档扫描</h3>
        {scan ? (
          <>
            <p className="character-anchor-panel__scan-status" role="status">
              <span aria-hidden="true">{SCAN_STATUS_ICON[scan.status]}</span>{' '}
              {SCAN_STATUS_TEXT[scan.status]} · 进度 {scan.scanned}/{scan.total} 章
            </p>
            {scanError ? <p className="character-anchor-panel__alert" role="alert">{scanError}</p> : null}
            {scan.status === 'failed' ? (
              <button type="button" onClick={() => { void rescan(); }} disabled={scanBusy}>重试</button>
            ) : null}
            {scan.status === 'pending' || scan.status === 'running' ? (
              <button type="button" onClick={() => { void load(); }}>刷新进度</button>
            ) : null}
          </>
        ) : (
          <p className="character-anchor-panel__scan-status" role="status">尚未扫描</p>
        )}
        <button
          type="button"
          className="character-anchor-panel__rescan"
          onClick={() => { void rescan(); }}
          disabled={scanBusy || scan?.status === 'pending' || scan?.status === 'running'}
        >
          立即扫描
        </button>
      </section>

      <section className="character-anchor-panel__marks-section" aria-label="命中段落列表">
        <h3>命中段落</h3>

        {loadError ? (
          <div className="character-anchor-panel__alert" role="alert">
            <span>{loadError}</span>
            <button type="button" onClick={() => { void load(); }}>重新加载</button>
          </div>
        ) : null}

        {!hasChapters ? (
          <p className="character-anchor-panel__status" role="status">需要先选择章节</p>
        ) : loading ? (
          <p className="character-anchor-panel__status" role="status">正在读取命中段落…</p>
        ) : marks.length === 0 ? (
          <p className="character-anchor-panel__status" role="status">当前章节暂无命中段落。</p>
        ) : (
          <>
            <div className="character-anchor-panel__bulk">
              <label className="character-anchor-panel__check-all">
                <input
                  type="checkbox"
                  aria-label="全选命中段落"
                  checked={allSelected}
                  onChange={toggleAll}
                />
                全选
              </label>
              <button type="button" onClick={invertSelection}>反选</button>
              <button
                type="button"
                onClick={() => { void batchDismiss(); }}
                disabled={selected.size === 0 || batchBusy}
              >
                批量剔除（{selected.size}）
              </button>
            </div>

            <ul className="character-anchor-panel__marks">
              {marks.map((mark) => {
                const chapterTitle = titleOf(mark.chapter_id);
                return (
                  <li
                    key={mark.id}
                    className="character-anchor-panel__mark"
                    data-anchor-id={mark.id}
                    data-chapter-id={mark.chapter_id}
                  >
                    <input
                      type="checkbox"
                      className="character-anchor-panel__mark-check"
                      aria-label={`选择 ${chapterTitle} 中「${mark.excerpt || mark.matched_name}」`}
                      checked={selected.has(mark.id)}
                      onChange={(event) => toggleOne(mark.id, event.target.checked)}
                    />
                    <div className="character-anchor-panel__mark-body">
                      <span className="character-anchor-panel__chapter">{chapterTitle}</span>
                      <span className="character-anchor-panel__excerpt">{mark.excerpt || '（无摘录）'}</span>
                      <span className="character-anchor-panel__matched">命中：{mark.matched_name}</span>
                      <span className="character-anchor-panel__character">角色：{mark.character_name}</span>
                    </div>
                    <button
                      type="button"
                      aria-label={`剔除命中：${mark.matched_name}`}
                      disabled={dismissingId === mark.id}
                      onClick={() => { void dismissOne(mark); }}
                    >
                      剔除
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {notice ? (
          <p className="character-anchor-panel__notice" role="status">{notice}</p>
        ) : null}
      </section>
    </section>
  );
}
