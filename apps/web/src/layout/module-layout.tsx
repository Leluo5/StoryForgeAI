import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Outlet } from 'react-router-dom';
import { SideNav } from './side-nav';
import './module-layout.css';

/**
 * 功能模块布局壳：左侧共享导航工具栏 + 右侧内容区。
 * 内容区预留 64px 安全边距（工具栏收起态宽度），工具栏展开为浮层覆盖其左缘，
 * 不改变内容布局/尺寸/展示状态。
 * 展开态下，用户在内容区点击/输入/滚动时自动收缩工具栏。
 * 作为嵌套布局路由的 element 使用，子模块内容经 <Outlet/> 注入。
 */
export function ModuleLayout(): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const collapse = useCallback(() => setExpanded(false), []);

  // 展开态：监听内容区交互，自动收缩
  useEffect(() => {
    if (!expanded) return;
    const root = contentRef.current;
    if (!root) return;
    const onInteract = () => collapse();
    root.addEventListener('click', onInteract, true);
    root.addEventListener('scroll', onInteract, true);
    root.addEventListener('focusin', onInteract, true);
    return () => {
      root.removeEventListener('click', onInteract, true);
      root.removeEventListener('scroll', onInteract, true);
      root.removeEventListener('focusin', onInteract, true);
    };
  }, [expanded, collapse]);

  return (
    <div className="module-layout">
      <SideNav expanded={expanded} onToggle={() => setExpanded((prev) => !prev)} />
      <div className="module-layout__content" ref={contentRef}>
        <Outlet />
      </div>
    </div>
  );
}
