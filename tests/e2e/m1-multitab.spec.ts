import { expect, test } from '@playwright/test';
import {
  chapterUrl,
  expectSaveStatus,
  login,
  loginAndOpenChapter,
  readLocalState
} from './m1-helpers';

test.setTimeout(90_000);

test('second tab takes over only after TTL and the stale writer loses its fencing token', async ({ page: first }) => {
  const location = await loginAndOpenChapter(first, `M1 多标签 ${Date.now()}`);
  const second = await first.context().newPage();
  await login(second);
  await second.goto(chapterUrl(location.workId, location.chapterId));
  await expectSaveStatus(second, '只读');
  await expect(second.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false');

  const before = (await readLocalState(second, location)).leases[0];
  expect(before).toBeDefined();
  await second.getByRole('button', { name: '接管写入', exact: true }).click();
  await expectSaveStatus(second, '只读');
  expect((await readLocalState(second, location)).leases[0]?.fencing_token).toBe(before!.fencing_token);

  // 无头 Chromium 不可见页面的定时器会被浏览器冻结，且 CDP 虚拟时间暂停会连 IndexedDB 回调一起卡住。
  // 这里显式清除旧标签的全部定时器，真实模拟心跳中断，页面其余 JS 仍可执行。
  await first.evaluate(() => { for (let id = 1; id < 10_000; id += 1) clearInterval(id); });
  await second.waitForTimeout(16_000);
  await second.getByRole('button', { name: '接管写入', exact: true }).click();
  await expectSaveStatus(second, '已同步');
  const after = (await readLocalState(second, location)).leases[0];
  expect(after?.fencing_token).toBeGreaterThan(before!.fencing_token);
  expect(after?.owner_id).not.toBe(before?.owner_id);

  // 旧标签重新可见时立即核对租约，发现 token 已被接管后转为只读。
  // 无头 Chromium 的 bringToFront 不派发可见性/焦点事件，这里显式触发真实 focus 事件。
  await first.bringToFront();
  await first.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expectSaveStatus(first, '只读');
  await expect(first.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
  await second.bringToFront();
  await second.locator('.ProseMirror').fill('新写入页正文');
  await expectSaveStatus(second, '已同步');
  await first.bringToFront();
  await expectSaveStatus(first, '只读');
});
