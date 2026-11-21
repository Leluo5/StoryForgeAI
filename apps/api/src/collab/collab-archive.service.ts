import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { env as defaultEnv } from '../config/env';
import { AgentArchiveOutboxEntity } from '../database/agent-archive-outbox.entity';
import { CollabUpstreamError, upstreamFailedError } from './channel/collab-upstream.error';

// 归档投递所需环境变量子集（便于单测注入替身；显式允许 undefined 以覆盖 exactOptionalPropertyTypes）
export interface CollabArchiveEnv {
  N8N_ARCHIVE_WEBHOOK_URL?: string | undefined;
  N8N_ARCHIVE_TOKEN?: string | undefined;
  COLLAB_HTTP_TIMEOUT_MS?: number | undefined;
}

// F11 归档投递服务（F2 §5.6）：把写回结果与引用快照投递到 n8n Webhook
// 只做投递与状态更新，不触碰任务与写回单；失败抛 CollabUpstreamError 交由重试队列（T17）退避重试。
// 幂等键 Idempotency-Key: storyforge-archive-{task_id}，上游按任务去重（F2 §5.6）。
// 载荷来自 outbox 行本身，结构由写回服务生成，不含凭据/作者邮箱/其他角色/正文。
@Injectable()
export class CollabArchiveService {
  private readonly logger = new Logger(CollabArchiveService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly envProvider: CollabArchiveEnv = defaultEnv
  ) {}

  /**
   * 投递一次归档记录。
   * 已 delivered 幂等返回；pending/failed 重试投递（attempts+1）。
   * 成功：置 delivered + external_id + delivered_at；失败：attempts+1 + last_error（脱敏），抛错。
   */
  async deliver(taskId: string): Promise<{ status: string; externalId: string | null; attempts: number }> {
    const { N8N_ARCHIVE_WEBHOOK_URL, N8N_ARCHIVE_TOKEN, COLLAB_HTTP_TIMEOUT_MS = 120_000 } = this.envProvider;
    if (!N8N_ARCHIVE_WEBHOOK_URL || !N8N_ARCHIVE_TOKEN) {
      throw new CollabUpstreamError('归档 Webhook 未配置', false, 'COLLAB_CHANNEL_NOT_CONFIGURED');
    }

    // 读 outbox 行（投递以行为单位，唯一 task_id）
    const repo = this.dataSource.getRepository(AgentArchiveOutboxEntity);
    const row = await repo.findOneBy({ task_id: taskId });
    if (!row) {
      throw new CollabUpstreamError('归档记录不存在', false, 'COLLAB_CHANNEL_NOT_CONFIGURED');
    }
    if (row.status === 'delivered') {
      this.logger.log(`归档已投递 task=${taskId}，幂等返回`);
      return { status: row.status, externalId: row.external_id, attempts: row.attempts };
    }

    const url = N8N_ARCHIVE_WEBHOOK_URL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COLLAB_HTTP_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${N8N_ARCHIVE_TOKEN}`,
          'Idempotency-Key': `storyforge-archive-${taskId}`
        },
        body: JSON.stringify(row.payload),
        signal: controller.signal
      });

      if (!response.ok) {
        throw upstreamFailedError(`n8n 归档返回 ${response.status}`);
      }
      // 上游返回执行标识（external_id）；缺省回退到任务标识，保证已投递可追踪
      const data = (await response.json()) as { executionId?: unknown; id?: unknown; execution_id?: unknown };
      const externalId =
        typeof data.executionId === 'string' ? data.executionId :
        typeof data.id === 'string' ? data.id :
        typeof data.execution_id === 'string' ? data.execution_id :
        taskId;

      row.status = 'delivered';
      row.external_id = externalId;
      row.delivered_at = new Date();
      row.attempts = row.attempts + 1;
      row.updated_at = new Date();
      await repo.save(row);

      this.logger.log(`归档投递成功 task=${taskId} external=${externalId}`);
      return { status: row.status, externalId: row.external_id, attempts: row.attempts };
    } catch (error) {
      if (error instanceof CollabUpstreamError) {
        // 投递失败：只更新 attempts 与 last_error（脱敏），不触碰任务与写回单
        row.attempts = row.attempts + 1;
        row.last_error = error.message.slice(0, 500);
        row.updated_at = new Date();
        await repo.save(row);
        throw error;
      }
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      const wrapped = isTimeout
        ? new CollabUpstreamError(`n8n 归档超时 ${COLLAB_HTTP_TIMEOUT_MS}ms`, true, 'COLLAB_UPSTREAM_TIMEOUT')
        : upstreamFailedError(`n8n 归档请求失败: ${error instanceof Error ? error.message : '未知错误'}`);
      row.attempts = row.attempts + 1;
      row.last_error = wrapped.message.slice(0, 500);
      row.updated_at = new Date();
      await repo.save(row);
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }
  }
}
