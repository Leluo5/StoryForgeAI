// M3c-3 T38 知识库工作台抽屉 · 浏览器 E2E（真实 PostgreSQL + Redis + 浏览器）
// 依据：docs/04-功能交付档案/M3c-3-知识库/03-任务规划.md T38；02-技术方案.md §4.5 抽屉方案 D。
// 覆盖：未登录 401 / 抽屉打开关闭与焦点归还（正文编辑器保持挂载）/
//       两库切换（本作品默认 → 全局库）/ 快速录入表单落库 → 列表出现 → 详情原文一致 /
//       关键词检索过滤 / 无回归 a11y 审计。
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { loginAndOpenChapter } from './m1-helpers';

// 显式桌面视口：工作台顶栏「知识库」触发按钮在 ≤1023px 会被折叠进左侧窄轨（CSS 断点），
// 必须保证桌面宽度才能命中；默认值在不同环境下不稳定。
test.use({ viewport: { width: 1440, height: 900 } });

async function audit(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  await testInfo.attach(`${name}-axe`, {
    body: JSON.stringify(result.violations, null, 2),
    contentType: 'application/json'
  });
  expect(result.violations).toEqual([]);
}

/** 打开工作台知识库抽屉并返回 dialog 定位器（调用前须已登录并进入章节） */
async function openDrawer(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: '知识库' }).click();
  const dialog = page.locator('dialog.kb-drawer');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 在「快速录入知识」弹窗内用原生 setter + input 事件填值，强制触发 React 受控状态更新。 */
async function fillCreateField(page: Page, placeholder: string, value: string): Promise<void> {
  await page.evaluate(
    ({ placeholder, value }) => {
      const modal = document.querySelector('.sf-modal[aria-label="快速录入知识"]');
      if (!modal) throw new Error('create modal not found');
      const el = modal.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `input[placeholder="${placeholder}"], textarea[placeholder="${placeholder}"]`
      );
      if (!el) throw new Error(`field not found: ${placeholder}`);
      const proto =
        el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    },
    { placeholder, value }
  );
}

/** 通过抽屉「快速录入」落一条作品库条目，并断言其出现在列表中。调用前抽屉须已打开。 */
async function createEntryInDrawer(page: Page, title: string, text: string): Promise<void> {
  await page.getByRole('button', { name: '+ 快速录入' }).click();
  const modal = page.locator('.sf-modal[aria-label="快速录入知识"]');
  await expect(modal).toBeVisible();
  // getByLabel/getByPlaceholder 的可操作性判定在该弹窗下不稳定（click 等不到 stable、
  // fill 可能未真正写入 React state），故用 evaluate 显式作用域填值，再用「按钮启用」反证状态已更新。
  await fillCreateField(page, '素材标题', title);
  await fillCreateField(page, '粘贴或输入素材正文…', text);
  await expect(modal.getByRole('button', { name: '录入素材' })).toBeEnabled({ timeout: 10_000 });
  // 弹窗内元素的 Playwright click 一直等不到 stable（该 Modal 下的可操作性判定异常，
  // 但按钮确已启用），故用 DOM 原生 click 触发 React 提交处理。
  await page.evaluate(() => {
    const m = document.querySelector('.sf-modal[aria-label="快速录入知识"]');
    if (!m) throw new Error('create modal not found');
    const btn = Array.from(m.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('录入素材')
    );
    if (!btn) throw new Error('submit button not found');
    btn.click();
  });
  // 提交成功：面板关闭 + 列表刷新出现该条目
  await expect(modal).not.toBeVisible({ timeout: 20_000 });
  await expect(page.locator('dialog.kb-drawer').getByText(title)).toBeVisible({ timeout: 20_000 });
}

test('knowledge endpoints require an authenticated author', async ({ request }) => {
  const response = await request.get('/api/v1/knowledge/entries?scope=global');
  expect(response.status()).toBe(401);
});

test('opens and closes the knowledge drawer without unmounting the editor', async ({ page }) => {
  const { workId } = await loginAndOpenChapter(page, `M3c3 抽屉 ${Date.now()}`);
  // 正文编辑器在抽屉打开前已挂载
  const editorRegion = page.getByRole('region', { name: '正文编辑器' });
  expect(await editorRegion.count()).toBeGreaterThan(0);

  const dialog = await openDrawer(page);
  await expect(page.getByRole('heading', { name: '知识库' })).toBeVisible();

  // 抽屉为覆盖层：正文编辑器仍在 DOM 中（不卸载）
  expect(await editorRegion.count()).toBeGreaterThan(0);

  // 关闭后焦点归还触发按钮（方案 D §8 验收要点）
  await page.getByRole('button', { name: '关闭知识库' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: '知识库' })).toBeFocused();

  expect(workId).toBeTruthy();
});

test('defaults to 本作品 library and switches to 全局库', async ({ page }) => {
  await loginAndOpenChapter(page, `M3c3 库切换 ${Date.now()}`);
  await openDrawer(page);

  // 有作品上下文时默认落在「本作品」
  await expect(page.getByRole('tab', { name: '本作品' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: '全局库' })).toHaveAttribute('aria-selected', 'false');

  // 切到全局库
  await page.getByRole('tab', { name: '全局库' }).click();
  await expect(page.getByRole('tab', { name: '全局库' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: '本作品' })).toHaveAttribute('aria-selected', 'false');
});

test('creates an entry via 快速录入 and lists it with matching detail text', async ({ page }) => {
  const { workId } = await loginAndOpenChapter(page, `M3c3 录入 ${Date.now()}`);
  const dialog = await openDrawer(page);
  await expect(page.getByRole('tab', { name: '本作品' })).toHaveAttribute('aria-selected', 'true');

  const title = `抽屉录入条目 ${Date.now()}`;
  const text = '滚滚长江东逝水，浪花淘尽英雄。';
  await createEntryInDrawer(page, title, text);

  await expect(page.getByText('共 1 条')).toBeVisible();

  // 点击卡片 → 抽屉内展开简易详情，原文一致，可一键引用
  await dialog.getByText(title).first().click();
  await expect(dialog.getByText(text)).toBeVisible();
  await expect(dialog.getByRole('button', { name: '引用到当前作品' })).toBeVisible();

  expect(workId).toBeTruthy();
});

test('keyword search filters the entry list', async ({ page }) => {
  await loginAndOpenChapter(page, `M3c3 检索 ${Date.now()}`);
  const dialog = await openDrawer(page);

  // 通过 UI 录入两条作品库条目（覆盖真实 create → list 流程）
  await createEntryInDrawer(page, '机器学习基础', '机器学习是人工智能的一个分支。');
  await createEntryInDrawer(page, '深度学习进阶', '深度学习基于多层神经网络。');
  await expect(page.getByText('共 2 条')).toBeVisible();

  const search = page.getByRole('searchbox', { name: '搜索知识条目' });
  await search.fill('深度学习');
  // 防抖 300ms 后应用筛选
  await expect(dialog.getByText('深度学习进阶')).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText('机器学习基础')).not.toBeVisible();
  await expect(page.getByText('共 1 条')).toBeVisible();
});

test('passes accessibility audit with the drawer open (populated)', async ({ page }, testInfo) => {
  await loginAndOpenChapter(page, `M3c3 a11y ${Date.now()}`);
  await openDrawer(page);
  // 录入一条以覆盖卡片 / Chip / 详情等填充态，最大化 a11y 覆盖
  await createEntryInDrawer(page, 'a11y 验收条目', '用于无障碍审计的示例素材正文。');
  await expect(page.locator('dialog.kb-drawer')).toBeVisible();
  await audit(page, testInfo, 'm3c3-knowledge-drawer');
});
