import { expect, test } from '@playwright/test';
import {
  expectSaveStatus,
  getServerChapter,
  loginAndOpenChapter,
  postServerText,
  readLocalState
} from './m1-helpers';

test('409 keeps base, local and server versions until the author chooses local text', async ({ page }) => {
  const location = await loginAndOpenChapter(page, `M1 冲突 ${Date.now()}`);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markRequest!: () => void;
  const requestStarted = new Promise<void>((resolve) => { markRequest = resolve; });
  await page.route('**/changes', async (route) => {
    markRequest();
    await gate;
    await route.continue();
  });
  await page.locator('.ProseMirror').fill('本地未确认');
  await requestStarted;
  expect((await readLocalState(page, location)).changes).toHaveLength(1);

  const serverSave = await postServerText(page, location, '服务端当前');
  expect(serverSave.server_version).toBe(1);
  release();
  const dialog = page.getByRole('dialog', { name: '版本冲突' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('pre').filter({ hasText: '本地未确认' })).toBeVisible();
  await expect(dialog.locator('pre').filter({ hasText: '服务端当前' })).toBeVisible();
  await expect(dialog).toContainText('共同基准版本 0，服务端版本 1');
  expect((await readLocalState(page, location)).changes).toHaveLength(1);

  await dialog.getByRole('button', { name: '使用本地', exact: true }).click();
  await expectSaveStatus(page, '已同步');
  await expect(dialog).toHaveCount(0);
  const server = await getServerChapter(page, location);
  expect(server.version).toBe(2);
  expect(server.document).toMatchObject({ content: [{ content: [{ text: '本地未确认' }] }] });
  const local = await readLocalState(page, location);
  expect(local.changes).toHaveLength(0);
  expect(local.conflicts).toHaveLength(1);
  expect(local.conflicts[0]).toMatchObject({ base_version: 0, server_version: 1 });
});
