/** 展开/收起箭头路径（右 / 左），与共享导航工具栏 side-nav 保持一致 */
const CHEVRON_RIGHT = 'M9 6l6 6-6 6';
const CHEVRON_LEFT = 'M15 6l-6 6 6 6';

interface Props {
  /** 当前是否处于折叠态 */
  collapsed: boolean;
  onToggle(): void;
}

/**
 * 面板折叠 / 展开切换按钮：与左侧共享导航工具栏「展开/收起」同款样式
 * （图标 + 文字标签 + 悬停底，结构见 layout/side-nav.css 的 .side-nav__toggle）。
 */
export function PanelCollapseToggle({ collapsed, onToggle }: Props) {
  return (
    <button type="button" className="panel-collapse-toggle" onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={collapsed ? '展开左侧栏' : '收起左侧栏'}>
      <svg className="panel-collapse-toggle__icon" viewBox="0 0 24 24" width="20" height="20" fill="none"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={collapsed ? CHEVRON_RIGHT : CHEVRON_LEFT} />
      </svg>
      <span className="panel-collapse-toggle__label">{collapsed ? '展开' : '收起'}</span>
    </button>
  );
}