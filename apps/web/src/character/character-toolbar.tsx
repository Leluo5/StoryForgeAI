import type { JSX } from 'react';
import type { CharacterFilters } from './character-state';

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

interface Props {
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

/** 角色版图工具栏：缩放 / 适应视图 / 复位 / 关键词与六维筛选入口（T33） */
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
