import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { expectSaveStatus, loginAndOpenChapter } from './m1-helpers';

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

test('375/768/1024/1440 layouts keep operations reachable and pass axe in both themes', async ({ page }, testInfo) => {
  await loginAndOpenChapter(page, `M1 无障碍 ${Date.now()}`);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await expectSaveStatus(page, '已同步');
    const dimensions = await page.evaluate(() => ({
      content: document.documentElement.scrollWidth,
      viewport: window.innerWidth
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);

    if (width < 768) {
      const trigger = page.getByRole('button', { name: '打开章节导航', exact: true });
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: '章节导航' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: '关闭章节导航' })).toBeFocused();
      await audit(page, testInfo, `${width}-navigation-dialog`);
      await dialog.getByRole('button', { name: '关闭章节导航' }).click();
      await expect(trigger).toBeFocused();
    } else if (width < 1024) {
      const trigger = page.getByRole('button', { name: '打开章节信息', exact: true });
      await trigger.click();
      await expect(page.getByRole('dialog', { name: '章节信息' })).toBeVisible();
      await audit(page, testInfo, `${width}-context-dialog`);
      // 右侧栏 dialog 的关闭按钮 aria-label 为「关闭右侧面板」（与 left dialog 的「关闭章节导航」区分）
      await page.getByRole('button', { name: '关闭右侧面板' }).click();
      await expect(trigger).toBeFocused();
    } else {
      await audit(page, testInfo, `${width}-light`);
    }

    const screenshot = testInfo.outputPath(`workbench-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`workbench-${width}`, { path: screenshot, contentType: 'image/png' });
  }

  await page.getByRole('button', { name: '切换深色主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await audit(page, testInfo, '1440-dark');
  const chapterLink = page.getByRole('link', { name: '第一章', exact: true });
  await chapterLink.focus();
  await expect(chapterLink).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(chapterLink).toBeFocused();
});
