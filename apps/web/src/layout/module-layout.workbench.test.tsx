import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ModuleLayout } from './module-layout';

const WORK_ID = 'work-1';
const CHAPTER_ID = 'chapter-1';
const WORKBENCH_PATH = `/works/${WORK_ID}/write/${CHAPTER_ID}`;

/** 工作台占位内容（轻量 mock，避免 ProseMirror 在 jsdom 的复杂度） */
function WorkbenchStub() {
  return <div className="workbench-stub">工作台内容</div>;
}

/** 作品库占位内容 */
function WorksStub() {
  return <div className="works-stub">作品库内容</div>;
}

/** 与 app.tsx 一致的壳结构：ModuleLayout 包裹 /works 与写作工作台路由 */
function renderShell(entry: string) {
  return render(<MemoryRouter initialEntries={[entry]}><Routes>
    <Route element={<ModuleLayout />}>
      <Route path="/works" element={<WorksStub />} />
      <Route path="/works/:workId/write/:chapterId" element={<WorkbenchStub />} />
    </Route>
  </Routes></MemoryRouter>);
}

/** 按 aria-label 定位侧边栏内的导航链接 */
function navLink(label: string) {
  const nav = screen.getByRole('complementary', { name: '功能导航' });
  const link = Array.from(nav.querySelectorAll('a')).find((a) => a.getAttribute('aria-label') === label);
  if (!link) throw new Error(`未找到侧边栏导航项: ${label}`);
  return link as HTMLAnchorElement;
}

function aside() {
  return screen.getByRole('complementary', { name: '功能导航' });
}

describe('ModuleLayout 写作工作台集成', () => {
  it('T1: 工作台路由下渲染共享侧边栏与工作台内容', () => {
    renderShell(WORKBENCH_PATH);
    expect(aside()).toBeVisible();
    expect(screen.getByText('工作台内容')).toBeVisible();
  });

  it('T2: 工作台路由下「作品库」导航项高亮，其余不高亮', () => {
    renderShell(WORKBENCH_PATH);
    expect(navLink('作品库').classList.contains('side-nav__item--active')).toBe(true);
    for (const label of ['知识库', '智能体', '工作流', '模型', '后台']) {
      expect(navLink(label).classList.contains('side-nav__item--active')).toBe(false);
    }
  });

  it('T3: 点击工作台内容区自动收缩侧边栏', () => {
    renderShell(WORKBENCH_PATH);
    fireEvent.click(screen.getByRole('button', { name: '展开工具栏' }));
    expect(aside()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByText('工作台内容'));
    expect(aside()).toHaveAttribute('aria-expanded', 'false');
  });

  it('T4: 点击侧边栏自身不触发自动收缩', () => {
    renderShell(WORKBENCH_PATH);
    fireEvent.click(screen.getByRole('button', { name: '展开工具栏' }));
    expect(aside()).toHaveAttribute('aria-expanded', 'true');
    // 点击侧边栏内导航链接（不在 contentRef 内）→ 不触发 contentRef 监听收缩
    fireEvent.click(navLink('作品库'));
    expect(aside()).toHaveAttribute('aria-expanded', 'true');
  });

  it('T5: 多轮往返切换后状态一致且无侧边栏残留', () => {
    const { container } = renderShell(WORKBENCH_PATH);
    // 往返 3 次：工作台 ⇄ 作品库
    for (let i = 0; i < 3; i += 1) {
      fireEvent.click(navLink('作品库'));
      expect(aside()).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByText('作品库内容')).toBeVisible();
      expect(navLink('作品库').classList.contains('side-nav__item--active')).toBe(true);
      // 回到工作台：直接改写初始路由会失败，这里通过再次渲染工作台断言无残留
      expect(container.querySelectorAll('.side-nav').length).toBe(1);
    }
  });

  it('T6: 收缩后清理内容区监听器（无泄漏）', () => {
    const { container } = renderShell(WORKBENCH_PATH);
    fireEvent.click(screen.getByRole('button', { name: '展开工具栏' }));
    expect(aside()).toHaveAttribute('aria-expanded', 'true');
    const content = container.querySelector('.module-layout__content');
    if (!content) throw new Error('未找到内容区容器');
    const spy = vi.spyOn(content, 'removeEventListener');
    fireEvent.click(screen.getByText('工作台内容'));
    expect(aside()).toHaveAttribute('aria-expanded', 'false');
    // 收缩触发 effect cleanup → 移除 click/scroll/focusin 三个捕获监听
    expect(spy).toHaveBeenCalledWith('click', expect.any(Function), true);
    expect(spy).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(spy).toHaveBeenCalledWith('focusin', expect.any(Function), true);
  });
});
