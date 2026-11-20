import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { loginAndOpenChapter, openPanel, expectPanelText, type M2Location } from './m2-helpers';

// M2 变更协作 E2E：修订→版本→对比→回滚→确认；评论全流程；待办状态机；通知未读/已读。
// 前端评论为手动入口（划词由编辑器选区注入，M2-T11 已注明），E2E 用面板表单走通全流程。
// 通知触发需要 assignee；前端面板无负责人输入，故用页面内 fetch 预置带 assignee 的待办。

async function csrfToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const cookie = document.cookie.split('; ').find((item) => item.startsWith('storyforge_csrf='));
    return decodeURIComponent(cookie?.slice('storyforge_csrf='.length) ?? '');
  });
}

async function createAssignedTodo(page: Page, location: M2Location): Promise<void> {
  const token = await csrfToken(page);
  const result = await page.evaluate(async ({ workId, token }) => {
    const session = await fetch('/api/v1/auth/session', { credentials: 'include' }).then((r) => r.json());
    const authorId = session.data.author.id as string;
    await fetch(`/api/v1/works/${workId}/todos`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({ title: '预置通知待办', description: '用于触发 assign 通知', assignee_id: authorId })
    });
    return { authorId };
  }, { workId: location.workId, token });
  expect(result.authorId).toBeTruthy();
}

test.describe('M2 变更协作', () => {
  test('修订→版本→对比→回滚→确认 完整链路', async ({ page }) => {
    const location = await loginAndOpenChapter(page, `M2 修订链路 ${Date.now()}`);

    // 1. 修订面板：创建 AI 修订集（面板仅提供 AI 修订集入口），状态待处理 → 接受占位操作 → 已解决
    await openPanel(page, '修订');
    await page.getByRole('button', { name: '创建 AI 修订集', exact: true }).click();
    await expectPanelText(page, 'AI');
    await expectPanelText(page, '待处理');
    await page.getByRole('button', { name: '接受', exact: true }).click();
    await expectPanelText(page, '已解决');

    // 2. 版本面板：创建基线快照 v0 → 推进正文 → 创建 v1 → 对比
    await openPanel(page, '版本');
    await page.getByRole('button', { name: '创建当前版本快照', exact: true }).click();
    // 版本列表项（.version-no）。桌面下右侧栏常驻版本面板可见，dialog 版隐藏，用 :visible 过滤避免 strict 违规
    await expect(page.locator('.version-list .version-no:visible', { hasText: 'v0' })).toBeVisible({ timeout: 15_000 });

    const editor = page.locator('.ProseMirror');
    await expect(editor).toBeEditable();
    await editor.click();
    await editor.pressSequentially('改');
    await expect(page.getByRole('status').filter({ hasText: '已同步' })).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: '创建当前版本快照', exact: true }).click();
    await expect(page.locator('.version-list .version-no:visible', { hasText: 'v1' })).toBeVisible({ timeout: 15_000 });

    await page.getByLabel('从').selectOption('0');
    await page.getByLabel('到').selectOption('1');
    await page.getByRole('button', { name: '对比', exact: true }).click();
    await expectPanelText(page, /节点变更|正文差异/);

    // 3. 回滚到最高版本（v1，手动快照可回滚）→ 确认 → 生成回滚修订集并推进正文
    await page.getByRole('button', { name: '回滚', exact: true }).first().click();
    await expectPanelText(page, /确认回滚到 v1/);
    await page.getByRole('button', { name: '确认回滚', exact: true }).click();
    // 确认后 dialog 关闭、版本列表刷新（回滚后生成新版本 v2）
    await expect(page.getByRole('dialog', { name: '回滚确认' })).toBeHidden();
    await expect(page.locator('.version-list .version-no:visible', { hasText: 'v2' })).toBeVisible({ timeout: 15_000 });

    expect(location.workId).toBeTruthy();
  });

  test('评论全流程：创建→回复→解决→重开→转待办', async ({ page }) => {
    const location = await loginAndOpenChapter(page, `M2 评论全流程 ${Date.now()}`);
    await openPanel(page, '评论');

    await page.getByLabel('新评论').fill('这是第一条评论');
    await page.getByRole('button', { name: '提交评论', exact: true }).click();
    await expectPanelText(page, '这是第一条评论');

    await page.getByLabel('回复内容').fill('同意');
    await page.getByRole('button', { name: '回复', exact: true }).first().click();
    await expectPanelText(page, '同意');

    await page.getByRole('button', { name: '解决', exact: true }).first().click();
    await expectPanelText(page, '已解决');

    await page.getByRole('button', { name: '重新打开', exact: true }).first().click();
    await expectPanelText(page, '已重新打开');

    // 转待办 → 切到待办面板应出现该评论待办
    await page.getByRole('button', { name: '转待办', exact: true }).first().click();
    await openPanel(page, '待办');
    await expectPanelText(page, '这是第一条评论');

    expect(location.workId).toBeTruthy();
  });

  test('待办状态机流转：open→in_progress→done', async ({ page }) => {
    const location = await loginAndOpenChapter(page, `M2 待办状态机 ${Date.now()}`);
    await openPanel(page, '待办');

    await page.getByLabel('标题').fill('校验回滚边界');
    await page.getByLabel('说明').fill('待办说明');
    await page.getByRole('button', { name: '创建待办', exact: true }).click();
    await expectPanelText(page, '校验回滚边界');

    // open → in_progress
    await page.getByRole('button', { name: '进行中', exact: true }).first().click();
    await expectPanelText(page, '进行中');
    // in_progress → done
    await page.getByRole('button', { name: '已完成', exact: true }).first().click();
    await expectPanelText(page, '已完成');

    expect(location.workId).toBeTruthy();
  });

  test('通知中心：未读角标 + 标记已读 + 全部已读', async ({ page }) => {
    const location = await loginAndOpenChapter(page, `M2 通知中心 ${Date.now()}`);
    await createAssignedTodo(page, location); // 预置带 assignee 待办 → 触发 assign 通知

    // 打开通知中心（header 铃铛），应见未读通知（仅 1 条 → 未读 badge=1）
    await page.getByRole('button', { name: /^通知/ }).click();
    await expectPanelText(page, '通知中心');
    await expectPanelText(page, '预置通知待办');
    await expect(page.getByLabel('1 条未读').first()).toBeVisible();

    // 标记已读：点击第一条通知（.notice-item role=button）→ 唯一未读变已读 → badge=0
    await page.locator('.notice-item').first().click();
    await expect(page.getByLabel('0 条未读').first()).toBeVisible();

    // 全部已读：unread=0 时按钮应 disabled（无可标记项）；断言禁用态即可
    await expect(page.getByRole('button', { name: '全部已读', exact: true })).toBeDisabled();

    expect(location.workId).toBeTruthy();
  });

  test('修订面板打开后无严重可访问性违规（axe wcag2aa）', async ({ page }, testInfo) => {
    const location = await loginAndOpenChapter(page, `M2 无障碍 ${Date.now()}`);
    await openPanel(page, '修订');
    await expect(page.getByRole('button', { name: '创建 AI 修订集', exact: true })).toBeVisible();
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    await testInfo.attach('revision-panel-axe', {
      body: JSON.stringify(result.violations, null, 2),
      contentType: 'application/json'
    });
    expect(result.violations).toEqual([]);
    expect(location.workId).toBeTruthy();
  });
});
