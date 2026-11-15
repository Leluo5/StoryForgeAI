import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import {
  chapterUrl,
  expectSaveStatus,
  loginAndOpenChapter,
  readLocalState
} from './m1-helpers';

test('author writes one chapter in both modes, reopens its deep link and exports recovery data', async ({ page }, testInfo) => {
  const location = await loginAndOpenChapter(page, `M1 主流程 ${Date.now()}`);
  const editor = page.locator('.ProseMirror');
  await expect(editor).toBeEditable();
  await editor.fill('第一章正文');
  await expectSaveStatus(page, '已同步');

  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  const source = page.getByLabel('Markdown 正文');
  await expect(source).toHaveValue(/第一章正文/);
  await source.fill('# 第一章\n\n云端正文');
  await page.getByRole('button', { name: '富文本', exact: true }).click();
  await expectSaveStatus(page, '已同步');
  await expect(editor).toContainText('云端正文');

  await page.goto(chapterUrl(location.workId, location.chapterId));
  await expectSaveStatus(page, '已同步');
  await expect(page.locator('.ProseMirror')).toContainText('云端正文');
  expect(new URL(page.url()).pathname).toBe(`/works/${location.workId}/write/${location.chapterId}`);
  expect(new URL(page.url()).search).toBe('?tab=manuscript&panel=chapter');
  expect((await readLocalState(page, location)).changes).toHaveLength(0);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出恢复数据', exact: true }).click();
  const download = await downloadPromise;
  const evidence = testInfo.outputPath('chapter-recovery.json');
  await download.saveAs(evidence);
  const exported = JSON.parse(await readFile(evidence, 'utf8')) as {
    format: string;
    snapshot: { work_id: string; chapter_id: string; server_version: number };
    changes: unknown[];
  };
  expect(exported.format).toBe('storyforge-wal-v1');
  expect(exported.snapshot).toMatchObject({
    work_id: location.workId,
    chapter_id: location.chapterId,
    server_version: 2
  });
  expect(exported.changes).toEqual([]);
  await testInfo.attach('chapter-recovery', { path: evidence, contentType: 'application/json' });
});
