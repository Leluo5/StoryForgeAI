import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { loginAndOpenChapter } from './m1-helpers';

interface PlotTreePayload {
  tree: { id: string; title: string; version: number };
  nodes: Array<{
    id: string;
    title: string;
    parent_id: string | null;
    position: { x: number; y: number };
  }>;
  links: unknown[];
  groups: unknown[];
}

async function openPlotTab(page: Page): Promise<void> {
  await page.getByRole('group', { name: '创作功能入口' }).getByRole('button', { name: '剧情树' }).click();
  await expect(page).toHaveURL(/tab=plot/);
}

async function readTree(page: Page, workId: string): Promise<PlotTreePayload> {
  const response = await page.request.get(`/api/v1/works/${encodeURIComponent(workId)}/plot-tree`);
  expect(response.ok()).toBe(true);
  return (await response.json() as { data: PlotTreePayload }).data;
}

/** 工作区与右栏检查器共享 store，提示会同时出现；统一按主工作区定位 */
function notice(page: Page, text: string) {
  return page.getByRole('main').getByRole('status').filter({ hasText: text });
}

async function buildTree(page: Page, firstNodeTitle: string): Promise<void> {
  await openPlotTab(page);
  await page.getByRole('button', { name: '新建空树', exact: true }).click();
  await expect(notice(page, '剧情树已创建').first()).toBeVisible();

  const aside = page.locator('aside.workbench-right');
  for (const title of [firstNodeTitle, '转折']) {
    await page.getByRole('button', { name: '新增节点', exact: true }).click();
    await page.getByRole('button', { name: '新节点 来源 手动' }).first().click();
    await aside.getByLabel('标题', { exact: true }).fill(title);
    await aside.getByRole('button', { name: '保存节点' }).click();
    await expect(page.getByRole('button', { name: `${title} 来源 手动` })).toBeVisible();
  }
}

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

test('plot endpoints require an authenticated author', async ({ request }) => {
  const response = await request.get('/api/v1/works/00000000-0000-4000-8000-000000000000/plot-tree');
  expect(response.status()).toBe(401);
});

test('builds, edits, links, lays out and audits the plot canvas', async ({ page }, testInfo) => {
  const { workId } = await loginAndOpenChapter(page, `M3c 剧情 ${Date.now()}`);
  await buildTree(page, '开端');

  const nodeCount = page.locator('.plot-canvas [data-node-id]');
  await expect(nodeCount).toHaveCount(2);

  // 建立线性关联（必须先发生）
  await page.getByRole('main').getByRole('button', { name: '建立关联', exact: true }).click();
  await expect(notice(page, '点击起始节点')).toBeVisible();
  await page.getByRole('button', { name: '开端 来源 手动' }).click();
  await page.getByRole('button', { name: '转折 来源 手动' }).click();
  await expect(page.locator('[data-plot-edge="linear"]')).toHaveCount(1);
  await expect(notice(page, '关联已建立').first()).toBeVisible();

  // 自动布局 → 撤销
  await page.getByRole('button', { name: '自动布局', exact: true }).click();
  await expect(notice(page, '已按层级与分组重新布局').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '撤销布局', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '撤销布局', exact: true }).click();
  await expect(notice(page, '已撤销自动布局').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '撤销布局', exact: true })).toBeDisabled();

  // 搜索过滤 → 列表视图键盘操作
  // 用剧情搜索框 id 精确定位：角色版图页签（hidden 但挂载）的同名「搜索」label 会造成歧义
  const plotSearch = page.locator('#plot-search-input');
  const plotToolbar = page.getByRole('toolbar', { name: '剧情工具栏' });
  await plotSearch.fill('开端');
  await expect(plotToolbar.getByText('1 个结果')).toBeVisible();
  await plotSearch.fill('不存在');
  await expect(plotToolbar.getByText('0 个结果')).toBeVisible();
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '没有匹配的节点' })).toBeVisible();
  await plotSearch.fill('');
  const rows = page.getByRole('main').getByRole('treeitem');
  await expect(rows).toHaveCount(2);
  await rows.nth(0).click();
  await rows.nth(0).press('ArrowDown');
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');

  // 回到画布：缩放 + 拖拽持久化
  await page.getByRole('button', { name: '画布', exact: true }).click();
  await page.getByRole('button', { name: '放大画布', exact: true }).click();
  await expect(plotToolbar.getByLabel('当前缩放')).not.toHaveText('100%');

  const before = await readTree(page, workId);
  const start = before.nodes.find((node) => node.title === '开端')!;
  const nodeButton = page.getByRole('button', { name: '开端 来源 手动' });
  const box = (await nodeButton.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + 130, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => {
    const next = await readTree(page, workId);
    return next.nodes.find((node) => node.id === start.id)!.position.y;
  }, { timeout: 15_000 }).toBeGreaterThan(start.position.y + 20);

  await audit(page, testInfo, 'plot-canvas');
});

test('exports and imports the plot tree JSON', async ({ page }) => {
  const { workId } = await loginAndOpenChapter(page, `M3c 导入导出 ${Date.now()}`);
  await buildTree(page, '开端');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile((await download.path())!, 'utf8')) as {
    schema_version: number;
    tree: { title: string };
    nodes: Array<{ title: string }>;
  };
  expect(exported.schema_version).toBe(1);
  expect(exported.nodes).toHaveLength(2);
  expect(exported.nodes.map((node) => node.title)).toContain('开端');

  // 覆盖导入一份结构合法的 JSON（剧情页签的 file input；角色版图页签也有一个，需限定在剧情 region）
  await page.getByRole('region', { name: '剧情', exact: true }).locator('input[type="file"]').setInputFiles({
    name: 'plot.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      schema_version: 1,
      tree: { title: '导入后的主线' },
      nodes: [{ title: '导入节点', sibling_order: 0 }],
      links: [],
      groups: []
    }))
  });
  const dialog = page.getByRole('alertdialog', { name: '确认导入' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '确认导入' }).click();
  await expect(notice(page, '剧情树已导入').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '导入节点 来源 导入' })).toBeVisible();
  const imported = await readTree(page, workId);
  expect(imported.nodes).toHaveLength(1);

  // 非法 JSON：报错且不改动现有树
  await page.getByRole('region', { name: '剧情', exact: true }).locator('input[type="file"]').setInputFiles({
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{ not json')
  });
  await expect(page.getByRole('main').getByRole('alert').filter({ hasText: '文件不是合法 JSON' })).toBeVisible();
  await expect(page.getByRole('button', { name: '导入节点 来源 导入' })).toBeVisible();
});

test('derives a step and writes the confirmed candidate into the tree', async ({ page }) => {
  const { workId } = await loginAndOpenChapter(page, `M3c 推衍 ${Date.now()}`);
  await buildTree(page, '开端');
  const aside = page.locator('aside.workbench-right');

  await page.getByRole('button', { name: '开端 来源 手动' }).click();
  await aside.getByLabel('场所', { exact: true }).fill('客栈');
  await aside.getByLabel('核心背景', { exact: true }).fill('主角被追杀');
  await aside.getByLabel('角色 1 名称', { exact: true }).fill('林澈');
  await aside.getByRole('button', { name: '开始推衍', exact: true }).click();

  await expect(aside.getByRole('heading', { name: '第 1 步' })).toBeVisible({ timeout: 40_000 });
  await aside.getByRole('radio', { name: /追查线索/ }).check();
  await aside.getByRole('button', { name: '保存本步', exact: true }).click();
  await expect(aside.getByRole('status').filter({ hasText: '第 1 步已更新' })).toBeVisible();

  await aside.getByRole('button', { name: '结束推衍', exact: true }).click();
  await expect(aside.getByRole('status').filter({ hasText: '推衍已结束' })).toBeVisible();
  await aside.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(aside.getByRole('status').filter({ hasText: '候选节点已生成' })).toBeVisible();
  await aside.getByRole('button', { name: '确认回写', exact: true }).click();
  await expect(aside.getByRole('status').filter({ hasText: '候选已写入剧情树' })).toBeVisible();

  const tree = await readTree(page, workId);
  expect(tree.nodes).toHaveLength(3);
});

test('generates a plot tree from an outline and replaces the tree after confirmation', async ({ page }, testInfo) => {
  const { workId } = await loginAndOpenChapter(page, `M3c 自动建树 ${Date.now()}`);
  await buildTree(page, '开端');
  const before = await readTree(page, workId);

  await page.getByRole('button', { name: '自动建树', exact: true }).click();
  const panel = page.getByRole('region', { name: '自动建树' });
  await expect(panel.getByRole('heading', { name: '自动建树', exact: true })).toBeVisible();

  await panel.getByLabel('大纲内容').fill('归乡线\n第一幕：主角回到家乡。\n第二幕：发现旧案。');
  await page.getByRole('button', { name: '开始解析', exact: true }).click();

  await expect(page.getByRole('heading', { name: '解析预览' })).toBeVisible({ timeout: 40_000 });
  const rootTitle = page.getByLabel('节点 1 标题');
  await expect(rootTitle).toHaveValue('归乡线');
  await expect(page.getByLabel('节点 2 标题')).toHaveValue('开端');

  await rootTitle.fill('归乡线（修订）');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '预览已保存' })).toBeVisible();

  const submit = page.getByRole('button', { name: '提交到剧情树', exact: true });
  await expect(submit).toBeDisabled();
  await page.getByRole('checkbox', { name: '我确认覆盖现有剧情树' }).check();
  await audit(page, testInfo, 'plot-generation');
  await submit.click();

  await expect(notice(page, '自动建树已写入剧情树').first()).toBeVisible({ timeout: 20_000 });
  const after = await readTree(page, workId);
  expect(after.tree.version).toBe(before.tree.version + 1);
  expect(after.nodes).toHaveLength(3);
  expect(after.nodes.map((node) => node.title)).toContain('归乡线（修订）');
  expect(after.nodes.map((node) => node.title)).not.toContain('转折');
});

test('appends a chapter-generated subtree under an existing node', async ({ page }) => {
  const { workId, chapterId } = await loginAndOpenChapter(page, `M3c 章节自动建树 ${Date.now()}`);
  await buildTree(page, '开端');
  const before = await readTree(page, workId);
  const existingRoot = before.nodes.find((node) => node.title === '开端')!;

  await page.getByRole('button', { name: '自动建树', exact: true }).click();
  const panel = page.getByRole('region', { name: '自动建树' });
  await panel.getByRole('radio', { name: '章节正文' }).check();
  const chapterSelect = panel.getByRole('combobox');
  await expect.poll(async () => chapterSelect.locator('option').count()).toBeGreaterThan(1);
  await chapterSelect.selectOption(chapterId);
  await panel.getByRole('button', { name: '开始解析', exact: true }).click();

  await expect(page.getByRole('heading', { name: '解析预览' })).toBeVisible({ timeout: 40_000 });
  await panel.getByRole('radio', { name: '追加为子树' }).check();
  await panel.getByRole('combobox').last().selectOption(existingRoot.id);
  await page.getByRole('button', { name: '提交到剧情树', exact: true }).click();

  await expect(notice(page, '自动建树已写入剧情树').first()).toBeVisible({ timeout: 20_000 });
  const after = await readTree(page, workId);
  expect(after.tree.version).toBe(before.tree.version + 1);
  expect(after.nodes).toHaveLength(before.nodes.length + 3);
  const generatedRoot = after.nodes.find(
    (node) => node.id !== existingRoot.id && node.title === '自动剧情树'
  );
  expect(generatedRoot).toBeTruthy();
  expect(generatedRoot!.parent_id).toBe(existingRoot.id);
  expect(after.nodes.some((node) => node.id === existingRoot.id)).toBe(true);
});

test('keeps the plot workspace usable at 375/768/1024/1440', async ({ page }, testInfo) => {
  const { workId, chapterId } = await loginAndOpenChapter(page, `M3c 响应式 ${Date.now()}`);
  await buildTree(page, '开端');

  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/works/${workId}/write/${chapterId}?tab=plot&panel=plot`);
    await expect(page).toHaveURL(/tab=plot/);
    const toolbar = page.getByRole('toolbar', { name: '剧情工具栏' });
    await expect(toolbar).toBeVisible();
    await expect(page.getByRole('application', { name: /剧情画布/ })).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      content: document.documentElement.scrollWidth,
      viewport: window.innerWidth
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);

    if (width === 375 || width === 1440) {
      await audit(page, testInfo, `plot-${width}`);
      const screenshot = testInfo.outputPath(`plot-${width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach(`plot-${width}`, { path: screenshot, contentType: 'image/png' });
    }
  }
});
