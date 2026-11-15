import { expect, test } from '@playwright/test';
import {
  corruptSnapshot,
  expectSaveStatus,
  getServerChapter,
  loginAndOpenChapter,
  readLocalState
} from './m1-helpers';

test('offline edits remain pending and retry persists them after reconnection', async ({ page, context }) => {
  const location = await loginAndOpenChapter(page, `M1 断网 ${Date.now()}`);
  await context.setOffline(true);
  await page.locator('.ProseMirror').fill('离线正文');
  await expectSaveStatus(page, '离线待同步');
  expect((await readLocalState(page, location)).changes).toHaveLength(1);
  expect((await getServerChapter(page, location)).version).toBe(0);

  await context.setOffline(false);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expectSaveStatus(page, '已同步');
  expect((await readLocalState(page, location)).changes).toHaveLength(0);
  expect((await getServerChapter(page, location)).document).toMatchObject({
    content: [{ content: [{ text: '离线正文' }] }]
  });
});

test('unsafe Markdown keeps its source and never executes or reaches the server', async ({ page }) => {
  const location = await loginAndOpenChapter(page, `M1 非法 Markdown ${Date.now()}`);
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  const source = page.getByLabel('Markdown 正文');
  const unsafe = '<script>window.__m1Unsafe = true</script>';
  await source.fill(unsafe);
  await page.getByRole('button', { name: '富文本', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Line 1, column 1');
  await expect(source).toHaveValue(unsafe);
  await expect(source).toBeVisible();
  expect(await page.evaluate(() => '__m1Unsafe' in window)).toBe(false);
  expect((await getServerChapter(page, location)).version).toBe(0);
});

test('quota failure shows save_failed, retains the snapshot and still permits recovery export', async ({ page }) => {
  const location = await loginAndOpenChapter(page, `M1 配额 ${Date.now()}`);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === 'changes') {
        IDBObjectStore.prototype.add = original;
        throw new DOMException('M1 quota injection', 'QuotaExceededError');
      }
      return original.call(this, value, key);
    };
  });
  await page.locator('.ProseMirror').fill('无法写入 WAL');
  await expectSaveStatus(page, '保存失败');
  expect((await readLocalState(page, location)).changes).toHaveLength(0);
  expect((await readLocalState(page, location)).snapshot).toBeDefined();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出恢复数据', exact: true }).click();
  expect((await downloadPromise).suggestedFilename()).toBe(`chapter-${location.chapterId}-recovery.json`);
});

test('corrupt local data is retained in a backup and explicit server restore re-enables writing', async ({ page }) => {
  const location = await loginAndOpenChapter(page, `M1 损坏 ${Date.now()}`);
  await corruptSnapshot(page, location);
  await page.reload();
  await expectSaveStatus(page, '保存失败');
  expect((await readLocalState(page, location)).snapshot?.document).toEqual({ type: 'paragraph' });

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '从服务端恢复', exact: true }).click();
  await expectSaveStatus(page, '已同步');
  const recovered = await readLocalState(page, location);
  expect(recovered.snapshot?.document).toMatchObject({ type: 'doc' });
  expect(recovered.conflicts).toHaveLength(1);
  expect(recovered.conflicts[0]?.local_document).toEqual({ type: 'paragraph' });
  await page.locator('.ProseMirror').fill('恢复后可写');
  await expectSaveStatus(page, '已同步');
  expect((await getServerChapter(page, location)).version).toBe(1);
});
