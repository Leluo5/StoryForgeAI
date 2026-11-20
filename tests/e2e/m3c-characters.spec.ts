import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { loginAndOpenChapter } from './m1-helpers';

const part = encodeURIComponent;

interface SeedResult {
  viewId: string;
  characterIds: string[];
}

interface BoardPayload {
  characters: Array<{ id: string; name: string }>;
  relations: unknown[];
  layout: Array<{ character_id: string; x: number | null; y: number | null; arranged: boolean }>;
}

function canvasCards(page: Page) {
  return page.locator('.character-canvas .character-card');
}

async function csrfToken(page: Page): Promise<string> {
  const cookie = (await page.context().cookies()).find((item) => item.name === 'storyforge_csrf');
  expect(cookie).toBeTruthy();
  return cookie!.value;
}

async function apiGet<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api/v1${path}`);
  expect(response.ok(), `GET ${path} 返回 ${response.status()}`).toBe(true);
  return (await response.json() as { data: T }).data;
}

async function apiPost<T>(page: Page, path: string, data: unknown): Promise<T> {
  const token = await csrfToken(page);
  const response = await page.request.post(`/api/v1${path}`, {
    headers: { 'x-csrf-token': token },
    data
  });
  expect(response.ok(), `POST ${path} 返回 ${response.status()}`).toBe(true);
  return (await response.json() as { data: T }).data;
}

/** 用 API 预置角色并加入默认视图（比 UI 建角色稳定，且不依赖角色创建表单） */
async function seedCharacters(page: Page, workId: string, names: string[]): Promise<SeedResult> {
  const views = await apiGet<Array<{ id: string; is_default: boolean }>>(
    page,
    `/works/${part(workId)}/character-views`
  );
  const view = views.find((item) => item.is_default) ?? views[0];
  expect(view, '默认角色视图应已自动创建').toBeTruthy();

  const characterIds: string[] = [];
  for (const name of names) {
    const created = await apiPost<{ id: string }>(page, `/works/${part(workId)}/characters`, {
      name,
      aliases: [],
      identity: '测试角色',
      faction: '归乡盟',
      occupation: '剑客'
    });
    characterIds.push(created.id);
  }
  await apiPost(page, `/works/${part(workId)}/character-views/${part(view!.id)}/members`, {
    character_ids: characterIds
  });
  return { viewId: view!.id, characterIds };
}

async function seedDirectedRelation(page: Page, workId: string, sourceId: string, targetId: string): Promise<void> {
  const type = await apiPost<{ id: string }>(page, `/works/${part(workId)}/character-relation-types`, {
    code: 'test_master',
    label: '师徒',
    group_key: 'social',
    group_label: '社会',
    directed: true,
    reverse_label: '弟子'
  });
  await apiPost(page, `/works/${part(workId)}/character-relations`, {
    source_id: sourceId,
    target_id: targetId,
    type_id: type.id,
    label: '授业',
    reverse_label: '弟子',
    color: '#ef4444',
    line_style: 'dashed',
    tag: '核心'
  });
}

async function readBoard(page: Page, workId: string, viewId: string): Promise<BoardPayload> {
  return apiGet<BoardPayload>(page, `/works/${part(workId)}/character-views/${part(viewId)}/board`);
}

/** 打开角色页签（深链直达，避免依赖上一次页签状态） */
async function openRoles(page: Page, workId: string, chapterId: string): Promise<void> {
  await page.goto(`/works/${part(workId)}/write/${part(chapterId)}?tab=roles&panel=role`);
  await expect(page.getByRole('toolbar', { name: '角色版图工具栏' })).toBeVisible();
}

async function openListView(page: Page): Promise<void> {
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expect(page.getByRole('grid', { name: '角色列表' })).toBeVisible();
}

async function audit(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .include('main')
    .analyze();
  await testInfo.attach(`${name}-axe`, {
    body: JSON.stringify(result.violations, null, 2),
    contentType: 'application/json'
  });
  expect(result.violations).toEqual([]);
}

test('keeps the manuscript mounted and its save status when switching to the roles tab', async ({ page }) => {
  await loginAndOpenChapter(page, `M3c 角色并存 ${Date.now()}`);
  // hidden 子树不在可访问性树里，用 DOM 选择器验证「挂载未卸载」
  const editor = page.locator('section[aria-label="正文编辑器"]');
  await expect(editor).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '已同步' })).toBeVisible();

  await page.getByRole('tablist', { name: '中央工作区页签' }).getByRole('tab', { name: '角色版图' }).click();
  await expect(page).toHaveURL(/tab=roles/);
  await expect(page.getByRole('toolbar', { name: '角色版图工具栏' })).toBeVisible();

  // 正文编辑器用 hidden 挂载：DOM 仍在，但不可见（不卸载即不丢未保存状态）
  await expect(editor).toHaveCount(1);
  await expect(editor).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: '已同步' })).toBeVisible();

  await page.getByRole('tablist', { name: '中央工作区页签' }).getByRole('tab', { name: '正文' }).click();
  await expect(editor).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '已同步' })).toBeVisible();
});

test('switches between canvas, list and archive views', async ({ page }) => {
  const { workId, chapterId } = await loginAndOpenChapter(page, `M3c 角色视图切换 ${Date.now()}`);
  await seedCharacters(page, workId, ['林澈', '白霜']);
  await openRoles(page, workId, chapterId);

  const canvas = page.getByRole('application', { name: /角色版图画布/ });
  await expect(canvas).toHaveCount(1);
  await expect(canvasCards(page)).toHaveCount(2);

  await openListView(page);
  await expect(page.getByRole('grid', { name: '角色列表' }).getByRole('row')).toHaveCount(3);

  await page.getByRole('button', { name: '归档', exact: true }).click();
  await expect(page.getByRole('region', { name: '归档角色' })).toBeVisible();
  await expect(page.getByText('归档角色可随时恢复，系统不会永久删除角色数据。')).toBeVisible();

  await page.getByRole('button', { name: '画布', exact: true }).click();
  await expect(canvas).toHaveCount(1);
  await expect(canvasCards(page)).toHaveCount(2);
});

test('renders seeded characters as cards and relations as edges on the canvas', async ({ page }) => {
  const { workId, chapterId } = await loginAndOpenChapter(page, `M3c 角色画布 ${Date.now()}`);
  const { characterIds } = await seedCharacters(page, workId, ['林澈', '白霜']);
  await seedDirectedRelation(page, workId, characterIds[0]!, characterIds[1]!);
  await openRoles(page, workId, chapterId);

  await expect(canvasCards(page)).toHaveCount(2);
  const canvas = page.getByRole('application', { name: /角色版图画布/ });
  await expect(canvas.getByRole('button', { name: /林澈/ })).toBeVisible();
  await expect(canvas.getByRole('button', { name: /白霜/ })).toBeVisible();
  await expect(page.locator('.character-links [data-character-relation]')).toHaveCount(1);
});

test('filters by keyword and keeps the result count in sync', async ({ page }) => {
  const { workId, chapterId } = await loginAndOpenChapter(page, `M3c 角色筛选 ${Date.now()}`);
  await seedCharacters(page, workId, ['林澈', '白霜']);
  await openRoles(page, workId, chapterId);

  const search = page.getByLabel('搜索', { exact: true });
  const count = page.getByRole('main').getByRole('status').filter({ hasText: /个结果/ });
  await expect(count).toHaveText('2 个结果');

  await search.fill('林');
  await expect(count).toHaveText('1 个结果');
  await expect(canvasCards(page)).toHaveCount(1);

  await search.fill('不存在');
  await expect(count).toHaveText('0 个结果');
  await expect(canvasCards(page)).toHaveCount(0);
  await expect(page.locator('.character-canvas-empty')).toHaveCount(1);

  await search.fill('');
  await expect(count).toHaveText('2 个结果');
  await expect(canvasCards(page)).toHaveCount(2);
});

test('zooms and drags a card without unhandled errors', async ({ page }) => {
  const { workId, chapterId } = await loginAndOpenChapter(page, `M3c 角色缩放拖拽 ${Date.now()}`);
  const { viewId, characterIds } = await seedCharacters(page, workId, ['林澈']);
  await openRoles(page, workId, chapterId);

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  const zoom = page.getByLabel('当前缩放');
  await expect(zoom).toHaveText('100%');
  for (let index = 0; index < 5; index += 1) {
    await page.getByRole('button', { name: '放大画布', exact: true }).click();
  }
  await expect(zoom).toHaveText('150%');
  for (let index = 0; index < 5; index += 1) {
    await page.getByRole('button', { name: '缩小画布', exact: true }).click();
  }
  await expect(zoom).toHaveText('100%');

  // 画布视口必须有真实高度，卡片才不会被裁剪（D19）
  const viewport = page.locator('.character-viewport');
  await expect.poll(async () => (await viewport.boundingBox())?.height ?? 0).toBeGreaterThan(200);

  const card = canvasCards(page).first();
  const box = (await card.boundingBox())!;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 70, startY + 40, { steps: 6 });
  await page.mouse.up();

  await expect(card).toBeVisible();
  const characterId = characterIds[0]!;
  await expect.poll(async () => {
    const board = await readBoard(page, workId, viewId);
    return board.layout.find((entry) => entry.character_id === characterId)?.arranged ?? false;
  }, { timeout: 15_000 }).toBe(true);
  expect(errors).toEqual([]);
});

test('shows relation style and reverse label', async ({ page }) => {
  const { workId, chapterId } = await loginAndOpenChapter(page, `M3c 角色关系样式 ${Date.now()}`);
  const { characterIds } = await seedCharacters(page, workId, ['林澈', '白霜']);
  await seedDirectedRelation(page, workId, characterIds[0]!, characterIds[1]!);
  await openRoles(page, workId, chapterId);
  await openListView(page);

  const relationRow = page.getByRole('grid', { name: '关系列表' }).getByRole('row').filter({ hasText: '白霜' });
  await expect(relationRow).toHaveCount(1);
  await expect(relationRow).toContainText('核心');
  await expect(relationRow).toContainText('有向 · 虚线');

  // 打开详情 → 关系页签 → 编辑关系：反向称谓由关系数据回填
  const characterRow = page.getByRole('grid', { name: '角色列表' }).getByRole('row').filter({ hasText: '林澈' });
  await characterRow.getByRole('gridcell').first().click();
  await page.getByRole('button', { name: '打开详情', exact: true }).click();
  const panel = page.getByRole('region', { name: '角色面板' });
  await expect(panel).toBeVisible();
  await panel.getByRole('tablist', { name: '角色面板页签' }).getByRole('tab', { name: '关系' }).click();
  await panel.getByRole('button', { name: '编辑与白霜的关系' }).click();
  await expect(page.getByRole('form', { name: '编辑关系' }).getByLabel('反向称谓')).toHaveValue('弟子');
});

test('archives a character and restores it from the archive view', async ({ page }) => {
  const { workId, chapterId } = await loginAndOpenChapter(page, `M3c 角色归档恢复 ${Date.now()}`);
  await seedCharacters(page, workId, ['林澈', '白霜']);
  await openRoles(page, workId, chapterId);
  await openListView(page);

  const list = page.getByRole('grid', { name: '角色列表' });
  const targetRow = list.getByRole('row').filter({ hasText: '白霜' });
  await targetRow.getByRole('gridcell').first().focus();
  await page.keyboard.press('Delete');
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('确认归档「白霜」？');
  await confirm.getByRole('button', { name: '确认归档' }).click();

  const archiveDialog = page.getByRole('dialog', { name: '归档确认：白霜' });
  await expect(archiveDialog).toBeVisible();
  await archiveDialog.getByRole('button', { name: '关闭归档确认' }).click();

  // 归档后：列表与画布默认都不再出现该角色
  await expect(list.getByRole('row')).toHaveCount(2);
  await expect(list).not.toContainText('白霜');
  await page.getByRole('button', { name: '画布', exact: true }).click();
  await expect(canvasCards(page)).toHaveCount(1);
  await expect(page.getByRole('application', { name: /角色版图画布/ })).not.toContainText('白霜');

  // 归档视图：可恢复，且不提供永久删除
  await page.getByRole('button', { name: '归档', exact: true }).click();
  const archiveView = page.getByRole('region', { name: '归档角色' });
  await expect(archiveView).toBeVisible();
  await expect(archiveView.getByText('归档角色可随时恢复，系统不会永久删除角色数据。')).toBeVisible();
  const archivedItem = page.locator('.character-archive-view__item').filter({ hasText: '白霜' });
  await archivedItem.getByRole('button', { name: '恢复', exact: true }).click();
  const restoreDialog = page.getByRole('alertdialog', { name: '确认恢复角色' });
  await restoreDialog.getByRole('button', { name: '确认恢复' }).click();
  await expect(page.getByRole('status').filter({ hasText: '已恢复「白霜」' })).toBeVisible();

  await page.getByRole('button', { name: '画布', exact: true }).click();
  await expect(canvasCards(page)).toHaveCount(2);
  await expect(page.getByRole('application', { name: /角色版图画布/ })).toContainText('白霜');
});

test('keeps the roles workspace usable at 375/768/1024/1440', async ({ page }, testInfo) => {
  testInfo.setTimeout(120_000);
  const { workId, chapterId } = await loginAndOpenChapter(page, `M3c 角色响应式 ${Date.now()}`);
  await seedCharacters(page, workId, ['林澈', '白霜']);

  const viewports = [
    { width: 375, height: 812 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 }
  ];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await openRoles(page, workId, chapterId);
    await expect(page.getByRole('toolbar', { name: '角色版图工具栏' })).toBeVisible();
    await expect(canvasCards(page)).toHaveCount(2);

    const dimensions = await page.evaluate(() => ({
      content: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth
    }));
    expect(dimensions.content, `${viewport.width}px 出现横向滚动`).toBeLessThanOrEqual(dimensions.viewport + 1);
  }
});

test('passes axe on the roles workspace', async ({ page }, testInfo) => {
  const { workId, chapterId } = await loginAndOpenChapter(page, `M3c 角色 axe ${Date.now()}`);
  await seedCharacters(page, workId, ['林澈', '白霜']);
  await openRoles(page, workId, chapterId);
  await expect(canvasCards(page)).toHaveCount(2);

  await audit(page, testInfo, 'characters-canvas');
  await openListView(page);
  await audit(page, testInfo, 'characters-list');
});

test('meets the 100 characters / 150 relations performance target', async ({ page }) => {
  test.setTimeout(180_000);
  const { workId, chapterId } = await loginAndOpenChapter(page, `M3c 角色性能 ${Date.now()}`);
  const names = Array.from({ length: 100 }, (_, index) => `角色${String(index + 1).padStart(3, '0')}`);
  const { viewId, characterIds } = await seedCharacters(page, workId, names);

  const type = await apiPost<{ id: string }>(page, `/works/${part(workId)}/character-relation-types`, {
    code: 'perf_home',
    label: '同乡',
    group_key: 'social',
    group_label: '社会',
    directed: false
  });
  const pairs: Array<[string, string]> = [];
  for (let index = 0; index < 100; index += 1) {
    pairs.push([characterIds[index]!, characterIds[(index + 1) % 100]!]);
  }
  for (let index = 0; index < 50; index += 1) {
    pairs.push([characterIds[index]!, characterIds[(index + 2) % 100]!]);
  }
  for (const [source, target] of pairs) {
    await apiPost(page, `/works/${part(workId)}/character-relations`, {
      source_id: source,
      target_id: target,
      type_id: type.id,
      label: '同乡',
      color: '#0ea5e9',
      line_style: 'solid'
    });
  }

  const boardStarted = Date.now();
  const board = await readBoard(page, workId, viewId);
  const boardMs = Date.now() - boardStarted;
  expect(board.characters).toHaveLength(100);
  expect(board.relations).toHaveLength(150);

  await openRoles(page, workId, chapterId);
  const count = page.getByRole('main').getByRole('status').filter({ hasText: /个结果/ });
  await expect(count).toHaveText('100 个结果');

  const filterStarted = Date.now();
  await page.getByLabel('搜索', { exact: true }).fill('角色00');
  await expect(count).toHaveText('9 个结果');
  const filterMs = Date.now() - filterStarted;

  // D18：100 角色 / 150 关系的打开与筛选均在 1 秒内
  console.log(`[T50] board=${boardMs}ms filter=${filterMs}ms`);
  expect(boardMs, `board 打开耗时 ${boardMs}ms`).toBeLessThanOrEqual(1000);
  expect(filterMs, `关键词筛选耗时 ${filterMs}ms`).toBeLessThanOrEqual(1000);
});

test('supports keyboard navigation from the list into the detail panel', async ({ page }) => {
  const { workId, chapterId } = await loginAndOpenChapter(page, `M3c 角色键盘 ${Date.now()}`);
  await seedCharacters(page, workId, ['林澈', '白霜']);
  await openRoles(page, workId, chapterId);
  await openListView(page);

  const rows = page.getByRole('grid', { name: '角色列表' }).getByRole('row');
  await rows.nth(1).getByRole('gridcell').first().focus();
  await page.keyboard.press('ArrowDown');
  const secondRow = rows.nth(2);
  await expect(secondRow.getByRole('gridcell').first()).toBeFocused();

  const secondId = await secondRow.getAttribute('data-character-id');
  expect(secondId).toBeTruthy();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`characterId=${secondId}`));
  const panel = page.getByRole('region', { name: '角色面板' });
  await expect(panel).toBeVisible();
  await expect(page.getByRole('region', { name: '角色资料' })).toBeVisible();
});
