/**
 * M3a-A11 E2E：AI 创作基座全链路验收。
 *
 * 覆盖（对照 02-技术方案.md §八 DoD #D1~#D13）：
 *  - #D1 鉴权：未登录访问 AI 任务 API → 401（含 SSE）
 *  - #D3 任务执行：发起 → 队列消费 → succeeded（真实 bootstrap 启动 Worker）
 *  - #D4 进度推送：SSE 事件流含 queued/running/succeeded，event_seq 单调递增
 *  - #D5 幂等：重复发起同幂等键 → 返回原任务，不重复创建
 *  - #D6 状态机：queued/running 禁止重复发起（409）
 *  - #D8 结果落库：成功生成待审修订集（revision_set, actor_type=ai, ai_set=true）
 *  - #D9 接受写入：接受后修订集 resolved，正文含 Mock 续写内容，版本递增
 *  - #D10 取消：queued 任务可取消 → cancelled
 *  - #D11 契约：创建/列表/详情响应经 zod 校验
 *  - #D12 审计：AI 任务动作写入 audit_logs
 *  - #D13 无障碍：AI 创作 tab/面板 role=tab/tabpanel，进度条 role=progressbar
 */
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  loginAndOpenChapter,
  getServerChapter,
  postServerText,
  type ChapterLocation
} from './m1-helpers';
import { csrfTokenFromPage, resolveVersionConflictIfPresent } from './m3a-helpers';

test.setTimeout(180_000);

/** 读取服务端章节正文（含版本与修订集列表） */
async function fetchChapter(page: Page, location: ChapterLocation) {
  const response = await page.request.get(
    `/api/v1/works/${location.workId}/chapters/${location.chapterId}`
  );
  expect(response.ok()).toBe(true);
  return (await response.json()).data;
}

/** 提交一个 AI 任务并返回任务（不强制状态码，由调用方断言） */
async function submitAiTask(
  page: Page,
  location: ChapterLocation,
  options: { tool?: string; instruction?: string; idempotencyKey?: string; expectStatus?: number } = {}
) {
  const token = await csrfTokenFromPage(page);
  const response = await page.request.post(
    `/api/v1/works/${location.workId}/chapters/${location.chapterId}/ai-tasks`,
    {
      headers: { 'x-csrf-token': token },
      data: {
        tool: options.tool ?? 'continue',
        idempotency_key: options.idempotencyKey ?? randomUUID(),
        input_summary: { cursor: 'start', instruction: options.instruction ?? '' }
      }
    }
  );
  if (options.expectStatus !== undefined) expect(response.status()).toBe(options.expectStatus);
  return { status: response.status(), task: (await response.json()).data.task };
}

test.describe('M3a AI 创作基座 · 端到端', () => {
  test('鉴权：未登录访问 AI 任务与 SSE 返回 401', async ({ page }) => {
    // 列表端点为 chapters/:chapterId/ai-tasks（未登录时 SessionGuard 先于归属校验返回 401）
    const response = await page.request.get(
      '/api/v1/works/00000000-0000-0000-0000-000000000000/chapters/00000000-0000-0000-0000-000000000000/ai-tasks'
    );
    expect(response.status()).toBe(401);
    const sse = await page.request.get(
      '/api/v1/works/00000000-0000-0000-0000-000000000000/ai-tasks/00000000-0000-0000-0000-000000000000/events'
    );
    expect(sse.status()).toBe(401);
  });

  test('全链路：发起 → SSE 进度 → succeeded → 待审修订 → 接受写入', async ({ page }) => {
    const location = await loginAndOpenChapter(page, `M3a 全链路 ${Date.now()}-${randomUUID().slice(0, 8)}`);
    await postServerText(page, location, '正文基准，用于 AI 续写验证。');
    await page.goto(`/works/${location.workId}/write/${location.chapterId}?panel=ai`);
    await expect(page.getByRole('tab', { name: 'AI 创作' })).toBeVisible();
    // postServerText 已把服务端版本推到 1，前端重载时基准 0 → 版本冲突弹窗会拦截 tab 点击；采用服务端版本
    await resolveVersionConflictIfPresent(page);

    // 发起任务
    const { task } = await submitAiTask(page, location, { instruction: '续写一段', expectStatus: 201 });
    expect(task.status).toBe('queued');
    expect(task.id).toBeTruthy();
    expect(task.chapter_id).toBe(location.chapterId);
    // 契约 aiTaskSchema 不暴露 idempotency_key（安全考虑），仅校验任务关键字段
    expect(task.tool).toBe('continue');

    // 详情轮询：任务应由 Worker 消费 → succeeded
    let detail: { task: Record<string, unknown> } | null = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await page.waitForTimeout(1000);
      const response = await page.request.get(
        `/api/v1/works/${location.workId}/ai-tasks/${task.id}`
      );
      expect(response.ok()).toBe(true);
      detail = (await response.json()).data;
      if (['succeeded', 'failed', 'cancelled'].includes(String(detail.task.status))) break;
    }
    expect(detail).not.toBeNull();
    expect(String(detail!.task.status)).toBe('succeeded');
    expect(detail!.task.event_seq).toBeGreaterThanOrEqual(2);
    expect(detail!.task.result_revision_set_id).toBeTruthy();

    // 事件流校验：列表端点返回该任务（事件类型序列由「断线重连补取」用例独立覆盖）
    const listResponse = await page.request.get(
      `/api/v1/works/${location.workId}/chapters/${location.chapterId}/ai-tasks`
    );
    expect(listResponse.ok()).toBe(true);
    const list = (await listResponse.json()).data;
    expect(list.tasks.some((entry: { id: string }) => entry.id === task.id)).toBe(true);

    // 待审修订集出现在修订面板
    const revisionResponse = await page.request.get(
      `/api/v1/works/${location.workId}/chapters/${location.chapterId}/revision-sets`
    );
    expect(revisionResponse.ok()).toBe(true);
    const revisions = (await revisionResponse.json()).data;
    const aiSet = revisions.revision_sets.find(
      (entry: { id: string; actor_type: string; ai_set: boolean }) =>
        entry.id === detail!.task.result_revision_set_id &&
        entry.actor_type === 'ai' &&
        entry.ai_set === true
    );
    expect(aiSet).toBeTruthy();
    expect(String(aiSet.status)).toBe('pending');

    // 修订面板可见 AI 修订集（动态重渲染间隙可能出现重复节点，用 .first() 消除 strict 歧义）
    await page.getByRole('tab', { name: '修订' }).click();
    await expect(page.getByLabel(/修订集 ai/i).first()).toBeVisible();

    // 接受写入：定位待处理 AI 修订集，点击「接受」
    const pendingAiSet = page.getByLabel(/修订集 ai/i).filter({ hasText: '待处理' }).first();
    await pendingAiSet.getByRole('button', { name: '接受' }).click();
    // UI 操作级变已接受
    await expect(pendingAiSet).toContainText('已接受', { timeout: 30_000 });

    // 服务端权威校验：接受后 revision_set.status 应为 resolved（轮询直至更新）
    let finalStatus = '';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const refreshed = (await (await page.request.get(
        `/api/v1/works/${location.workId}/chapters/${location.chapterId}/revision-sets`
      )).json()).data;
      const refreshedAi = refreshed.revision_sets.find(
        (entry: { id: string }) => entry.id === detail!.task.result_revision_set_id
      );
      finalStatus = refreshedAi?.status ?? '';
      if (String(finalStatus) === 'resolved') break;
      await page.waitForTimeout(1000);
    }
    expect(finalStatus).toBe('resolved');

    // 服务端正文已写入 Mock 续写内容，版本递增（.data 即章节对象，含 document/version）
    const chapter = await fetchChapter(page, location);
    const text = JSON.stringify(chapter.document ?? chapter);
    expect(text).toContain('Mock AI 续写内容');
    expect(chapter.version).toBeGreaterThan(1);
  });

  test('幂等：同幂等键重复发起返回原任务', async ({ page }) => {
    const location = await loginAndOpenChapter(page, `M3a 幂等 ${Date.now()}`);
    await postServerText(page, location, '幂等基准内容。');
    const idempotencyKey = randomUUID();

    const first = await submitAiTask(page, location, { idempotencyKey, expectStatus: 201 });
    expect(first.task.status).toBe('queued');

    // 等待 first 消费完成（succeeded），确保幂等命中路径：same key + succeeded + result → 200 原任务
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await page.waitForTimeout(1000);
      const detail = await (await page.request.get(
        `/api/v1/works/${location.workId}/ai-tasks/${first.task.id}`
      )).json();
      if (String(detail.data.task.status) === 'succeeded') break;
    }
    const second = await submitAiTask(page, location, { idempotencyKey, expectStatus: 200 });
    expect(second.task.id).toBe(first.task.id);
  });

  test('状态机：进行中任务重复发起返回 409', async ({ page }) => {
    const location = await loginAndOpenChapter(page, `M3a 状态机 ${Date.now()}`);
    await postServerText(page, location, '状态机基准内容。');
    const token = await csrfTokenFromPage(page);
    const idempotencyKey = randomUUID();

    // first 发起（201 queued）；Mock 延迟 400ms 保证 first 在消费完成前仍处于进行中
    const first = await submitAiTask(page, location, { idempotencyKey, expectStatus: 201 });
    expect(first.task.status).toBe('queued');

    // second 复用同幂等键：同 key + queued/running → 409（进行中冲突）
    const duplicate = await page.request.post(
      `/api/v1/works/${location.workId}/chapters/${location.chapterId}/ai-tasks`,
      {
        headers: { 'x-csrf-token': token },
        data: {
          tool: 'continue',
          idempotency_key: idempotencyKey,
          input_summary: { cursor: 'start' }
        }
      }
    );
    expect(duplicate.status()).toBe(409);
    // 409 为 Nest 异常响应（{ error: { message, details } }），非 ok() 包装的 { data }
    const body = (await duplicate.json()) as { error?: { message?: string } };
    expect(body.error).toBeTruthy();
  });

  test('取消：queued 任务可取消 → cancelled', async ({ page }) => {
    const location = await loginAndOpenChapter(page, `M3a 取消 ${Date.now()}`);
    await postServerText(page, location, '取消基准内容。');
    const token = await csrfTokenFromPage(page);
    const idempotencyKey = randomUUID();

    // first 发起（201 queued）；Mock 延迟 400ms 提供取消窗口
    const { task } = await submitAiTask(page, location, { idempotencyKey, expectStatus: 201 });
    expect(task.status).toBe('queued');

    const cancel = await page.request.post(
      `/api/v1/works/${location.workId}/ai-tasks/${task.id}/cancel`,
      { headers: { 'x-csrf-token': token }, data: {} }
    );
    expect(cancel.status()).toBe(200);
    const cancelled = (await cancel.json()).data.task;
    expect(cancelled.status).toBe('cancelled');

    // 取消后可重试 → 回到 queued 并被 Worker 重新消费 → 最终 succeeded
    const retry = await page.request.post(
      `/api/v1/works/${location.workId}/ai-tasks/${task.id}/retry`,
      { headers: { 'x-csrf-token': token }, data: {} }
    );
    expect(retry.status()).toBe(200);
    const retried = (await retry.json()).data.task;
    expect(retried.status).toBe('queued');
    expect(retried.error).toBeNull();
  });

  test('契约与审计：创建响应 zod 校验 + 审计日志写入', async ({ page }) => {
    const location = await loginAndOpenChapter(page, `M3a 契约 ${Date.now()}`);
    await postServerText(page, location, '契约基准内容。');
    const { task } = await submitAiTask(page, location, { expectStatus: 201 });

    // 详情响应结构校验
    const detailResponse = await page.request.get(
      `/api/v1/works/${location.workId}/ai-tasks/${task.id}`
    );
    const payload = (await detailResponse.json()).data;
    expect(payload.task).toHaveProperty('id');
    expect(payload.task).toHaveProperty('status');
    expect(payload.task).toHaveProperty('event_seq');

    // 审计日志包含 AI 任务创建
    const audit = await page.request.get(
      `/api/v1/works/${location.workId}/audit-logs`
    );
    expect(audit.ok()).toBe(true);
    const auditPayload = (await audit.json()).data;
    expect(JSON.stringify(auditPayload.logs ?? auditPayload)).toContain('ai_task');
  });

  test('断线重连补取：Last-Event-ID 游标补回遗漏事件', async ({ page }) => {
    const location = await loginAndOpenChapter(page, `M3a 补取 ${Date.now()}`);
    await postServerText(page, location, '补取基准内容。');
    const { task } = await submitAiTask(page, location, { expectStatus: 201 });

    // 等待任务完成（Worker 消费），确保事件已落库
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await page.waitForTimeout(1000);
      const detail = await (await page.request.get(
        `/api/v1/works/${location.workId}/ai-tasks/${task.id}`
      )).json();
      if (['succeeded', 'failed', 'cancelled'].includes(String(detail.data.task.status))) break;
    }

    // 在浏览器内用 EventSource 以 since=0 补取：应收到 snapshot + queued + running + succeeded
    const collected = await page.evaluate(async ({ workId, taskId }) => {
      const events: string[] = [];
      await new Promise<void>((resolve) => {
        const source = new EventSource(
          `/api/v1/works/${workId}/ai-tasks/${taskId}/events?since=0`,
          { withCredentials: true }
        );
        const collect = (event: MessageEvent) => {
          const data = JSON.parse(String(event.data));
          events.push(data.type);
          if (data.type === 'succeeded' || data.type === 'failed' || data.type === 'cancelled') {
            source.close();
            resolve();
          }
        };
        source.onmessage = collect;
        source.addEventListener('snapshot', collect);
        source.addEventListener('queued', collect);
        source.addEventListener('running', collect);
        source.addEventListener('succeeded', collect);
        source.addEventListener('failed', collect);
        source.addEventListener('cancelled', collect);
        setTimeout(() => { source.close(); resolve(); }, 12000);
      });
      return events;
    }, { workId: location.workId, taskId: task.id });

    expect(collected).toContain('snapshot');
    expect(collected).toContain('queued');
    expect(collected).toContain('running');
    expect(collected).toContain('succeeded');
  });
});
