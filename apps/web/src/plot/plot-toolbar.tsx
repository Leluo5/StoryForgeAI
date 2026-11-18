import type { JSX } from 'react';
import type { PlotGroup, PlotNodeOrigin } from '@storyforge/contracts';

interface Props {
  view: 'canvas' | 'list';
  onView: (view: 'canvas' | 'list') => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onReset: () => void;
  search: string;
  onSearch: (value: string) => void;
  originFilter: PlotNodeOrigin | 'all';
  onOriginFilter: (value: PlotNodeOrigin | 'all') => void;
  groupFilter: string;
  onGroupFilter: (value: string) => void;
  groups: PlotGroup[];
  resultCount: number;
  onAddNode: () => void;
  onAddLink: () => void;
  linking: boolean;
  onAutoLayout: () => void;
  canUndoLayout: boolean;
  onUndoLayout: () => void;
  onExport: () => void;
  onImport: () => void;
  busy: boolean;
}

/** 剧情工具栏：结构操作、视图切换、缩放、搜索与导入导出 */
export function PlotToolbar(props: Props): JSX.Element {
  return (
    <div className="plot-toolbar" role="toolbar" aria-label="剧情工具栏">
      <div className="plot-toolbar-group">
        <button type="button" onClick={props.onAddNode} disabled={props.busy}>新增节点</button>
        <button type="button" onClick={props.onAddLink} aria-pressed={props.linking}>
          {props.linking ? '取消连线' : '建立关联'}
        </button>
        <button type="button" onClick={props.onAutoLayout} disabled={props.busy}>自动布局</button>
        <button type="button" onClick={props.onUndoLayout} disabled={props.busy || !props.canUndoLayout}>撤销布局</button>
        <button type="button" onClick={props.onExport} disabled={props.busy}>导出 JSON</button>
        <button type="button" onClick={props.onImport} disabled={props.busy}>导入 JSON</button>
      </div>
      <div className="plot-toolbar-group" role="group" aria-label="视图切换">
        <button type="button" aria-pressed={props.view === 'canvas'} onClick={() => props.onView('canvas')}>画布</button>
        <button type="button" aria-pressed={props.view === 'list'} onClick={() => props.onView('list')}>列表</button>
      </div>
      <div className="plot-toolbar-group" role="group" aria-label="缩放">
        <button type="button" onClick={props.onZoomOut} aria-label="缩小画布">−</button>
        <output className="plot-zoom" aria-label="当前缩放">{Math.round(props.zoom * 100)}%</output>
        <button type="button" onClick={props.onZoomIn} aria-label="放大画布">+</button>
        <button type="button" onClick={props.onFit}>适应视图</button>
        <button type="button" onClick={props.onReset}>复位</button>
      </div>
      <div className="plot-toolbar-group plot-search">
        <label htmlFor="plot-search-input">搜索</label>
        <input id="plot-search-input" type="search" value={props.search}
          placeholder="标题 / 概要 / 正文 / 属性" onChange={(event) => props.onSearch(event.target.value)} />
        <label htmlFor="plot-origin-filter">来源</label>
        <select id="plot-origin-filter" value={props.originFilter}
          onChange={(event) => props.onOriginFilter(event.target.value as PlotNodeOrigin | 'all')}>
          <option value="all">全部</option>
          <option value="manual">手动</option>
          <option value="derivation">推衍</option>
          <option value="outline">大纲</option>
          <option value="novel_text">章节文本</option>
          <option value="import">导入</option>
        </select>
        <label htmlFor="plot-group-filter">分组</label>
        <select id="plot-group-filter" value={props.groupFilter}
          onChange={(event) => props.onGroupFilter(event.target.value)}>
          <option value="all">全部</option>
          <option value="ungrouped">未分组</option>
          {props.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
        <span className="plot-search-count" role="status">{props.resultCount} 个结果</span>
      </div>
    </div>
  );
}
