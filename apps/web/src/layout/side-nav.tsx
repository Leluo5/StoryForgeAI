import type { JSX } from 'react';
import { NavLink } from 'react-router-dom';
import './side-nav.css';

/** 侧栏导航项定义 */
interface NavItem {
  key: string;
  to: string;
  label: string;
  /** 内联 SVG 路径（24x24 视口，仅描边） */
  path: string;
}

/** 六个功能模块入口，按需求顺序排列 */
const NAV_ITEMS: NavItem[] = [
  { key: 'works', to: '/works', label: '作品库', path: 'M4 6.5C4 5.12 5.12 4 6.5 4h11C18.88 4 20 5.12 20 6.5v11c0 1.38-1.12 2.5-2.5 2.5h-11C5.12 20 4 18.88 4 17.5v-11Zm3 1h10M4 11h16M4 15h16' },
  { key: 'knowledge', to: '/knowledge', label: '知识库', path: 'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Zm3 3h10M7 12h10M7 16h6' },
  { key: 'agents', to: '/agents', label: '智能体', path: 'M12 3a2 2 0 0 1 2 2v1a6 6 0 0 1 6 6h1a2 2 0 0 1 0 4h-1a6 6 0 0 1-6 6v1a2 2 0 0 1-4 0v-1a6 6 0 0 1-6-6H3a2 2 0 0 1 0-4h1a6 6 0 0 1 6-6V5a2 2 0 0 1 2-2Z' },
  { key: 'workflows', to: '/workflows', label: '工作流', path: 'M6 4v16M18 4v16M4 6h4M4 18h4M16 6h4M16 18h4M4 12h16' },
  { key: 'models', to: '/models', label: '模型', path: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 0v18M4 7.5l8 4.5 8-4.5' },
  { key: 'admin', to: '/admin', label: '后台', path: 'M12 4a2 2 0 0 1 2 2v.6a2 2 0 0 1 2.4 1.4l.1.4a2 2 0 0 1 1.5 1.5l.4.1a2 2 0 0 1 1.4 2.4H20a2 2 0 0 1 0 4h-.6a2 2 0 0 1-1.4 2.4l-.4.1a2 2 0 0 1-1.5 1.5l-.1.4a2 2 0 0 1-2.4 1.4H14a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.6a2 2 0 0 1-2.4-1.4l-.1-.4a2 2 0 0 1-1.5-1.5l-.4-.1A2 2 0 0 1 6.2 16H6a2 2 0 0 1 0-4h.2a2 2 0 0 1 1.4-2.4l.4-.1a2 2 0 0 1 1.5-1.5l.1-.4a2 2 0 0 1 2.4-1.4H12a2 2 0 0 1 2-2Z' },
];

/** 展开/收起箭头路径（右 / 左） */
const CHEVRON_RIGHT = 'M9 6l6 6-6 6';
const CHEVRON_LEFT = 'M15 6l-6 6 6 6';

interface SideNavProps {
  /** 是否处于展开态（图标 + 名称） */
  expanded: boolean;
  /** 展开/收起切换回调 */
  onToggle: () => void;
}

/**
 * 共享左侧导航工具栏（受控组件）。
 * 收起态：固定 64px 窄条，仅显示功能图标；展开态：fixed 224px 浮层显示图标 + 名称，
 * 直接覆盖在右侧内容区左缘，不改变内容布局。
 * 展开/收起状态由布局壳 ModuleLayout 管理，自动收缩监听也在布局壳内容容器上。
 */
export function SideNav({ expanded, onToggle }: SideNavProps): JSX.Element {
  return (
    <aside
      className={`side-nav${expanded ? ' side-nav--expanded' : ''}`}
      aria-label="功能导航"
      aria-expanded={expanded}
    >
      <nav className="side-nav__list">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.key}
            to={item.to}
            className={({ isActive }) => `side-nav__item${isActive ? ' side-nav__item--active' : ''}`}
            title={item.label}
            aria-label={item.label}
          >
            <svg className="side-nav__icon" viewBox="0 0 24 24" width="20" height="20" fill="none"
              stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={item.path} />
            </svg>
            <span className="side-nav__label">{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <button
        type="button"
        className="side-nav__toggle"
        onClick={onToggle}
        aria-label={expanded ? '收起工具栏' : '展开工具栏'}
      >
        <svg className="side-nav__icon" viewBox="0 0 24 24" width="20" height="20" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={expanded ? CHEVRON_LEFT : CHEVRON_RIGHT} />
        </svg>
        <span className="side-nav__label">{expanded ? '收起' : '展开'}</span>
      </button>
    </aside>
  );
}
