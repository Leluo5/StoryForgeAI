import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import type {
  ChatExperienceRequest,
  ChatExperienceEvent,
  PublicWork,
  VerifyWorkAccessRequest
} from '@storyforge/contracts';
import { WorkEntity } from '../database/work.entity';
import { env } from '../config/env';

// F3 访问 token 签名密钥（进程级随机；重启后旧 token 失效，由客户端重新 verify）
const ACCESS_TOKEN_SECRET = process.env.EXPERIENCE_TOKEN_SECRET
  ?? 'storyforge-experience-token-secret';
const ACCESS_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h（对齐旧 C-001 过期语义）

/** 体验端公开作品视图（隐藏 pat_token / access_code） */
function toPublicWork(work: WorkEntity): PublicWork {
  return {
    id: work.id,
    name: work.title,
    description: work.description,
    icon_url: work.icon_url,
    coze_bot_id: work.coze_bot_id,
    interaction_type: work.interaction_type,
    system_prompt: work.system_prompt,
    prologue: work.prologue,
    suggested_questions: (Array.isArray(work.suggested_questions) ? work.suggested_questions : []).filter(
      (item): item is string => typeof item === 'string'
    ),
    parameters: (Array.isArray(work.parameters) ? work.parameters : []).filter(
      (item): item is Record<string, unknown> => typeof item === 'object' && item !== null
    ),
    model_name: work.model_name,
    response_format: work.response_format,
    requires_access_code: Boolean(work.access_code),
    created_at: work.created_at.toISOString(),
    updated_at: work.updated_at.toISOString()
  };
}

/** 签名访问 token：`<workId>.<expiresAtMs>.<hmac>`，服务端无状态校验，防伪造 */
function signAccessToken(workId: string): string {
  const expiresAt = Date.now() + ACCESS_TOKEN_TTL_MS;
  const payload = `${workId}.${expiresAt}`;
  const sig = createHmac('sha256', ACCESS_TOKEN_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/** 校验访问 token；返回是否有效（未过期且签名匹配且 workId 一致） */
function isAccessTokenValid(token: string, workId: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const payloadWorkId = parts[0] ?? '';
  const expiresAtStr = parts[1] ?? '';
  const sig = parts[2] ?? '';
  if (payloadWorkId !== workId) return false;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  const expected = createHmac('sha256', ACCESS_TOKEN_SECRET).update(`${workId}.${expiresAtStr}`).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * F3 在线体验服务：公开列表 / 详情 / 访问码验证 / SSE 流式聊天。
 * 访问控制语义对齐旧架构 require_work_access：
 *  - 作品未公开 → 403
 *  - 设了访问码 → 需 X-Access-Token 为 verify 颁发的签名 token
 */
@Injectable()
export class ExperienceService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async listPublicWorks(): Promise<PublicWork[]> {
    const works = await this.dataSource.getRepository(WorkEntity).find({
      where: { is_public: true },
      order: { updated_at: 'DESC' }
    });
    return works.map(toPublicWork);
  }

  async getPublicWork(workId: string): Promise<PublicWork> {
    const work = await this.findPublicWork(workId);
    return toPublicWork(work);
  }

  /** 访问码验证：无码直接放行；有码比对，通过后颁发签名 token */
  async verifyAccess(workId: string, input: VerifyWorkAccessRequest): Promise<{ granted: boolean; token: string | null }> {
    const work = await this.findPublicWork(workId);
    if (!work.access_code) {
      return { granted: true, token: null };
    }
    if (work.access_code !== input.access_code) {
      throw new UnauthorizedException('访问码错误');
    }
    return { granted: true, token: signAccessToken(workId) };
  }

  /**
   * SSE 流式聊天：校验访问 → 转发 Coze /v3/chat（stream=true）为 delta/done/error 事件。
   * 复用旧架构 _build_coze_chat_request 语义：conversation_id 走 Query，消息 content_type 区分 text/object_string。
   */
  async chatStream(params: {
    workId: string;
    input: ChatExperienceRequest;
    accessToken: string | null;
    response: Response;
  }): Promise<void> {
    const { workId, input, accessToken, response } = params;
    const work = await this.findPublicWork(workId);
    // 访问控制：设了访问码则必须携带有效 token
    if (work.access_code && !(accessToken && isAccessTokenValid(accessToken, workId))) {
      throw new ForbiddenException('需要验证访问码');
    }
    if (!work.coze_bot_id || !work.pat_token) {
      throw new NotFoundException('该作品未配置对话能力');
    }

    const base = (env.COZE_API_BASE ?? 'https://api.coze.com').replace(/\/+$/, '');
    const url = `${base}/v3/chat`;
    const headers = {
      Authorization: `Bearer ${work.pat_token}`,
      'Content-Type': 'application/json'
    };
    const body: Record<string, unknown> = {
      bot_id: work.coze_bot_id,
      user_id: input.user_id,
      stream: true,
      auto_save_history: true,
      additional_messages: []
    };
    if (input.conversation_id) {
      body.conversation_id = input.conversation_id;
    }
    body.additional_messages = [{
      role: 'user',
      content: input.message,
      content_type: 'text'
    }];

    // SSE 响应头
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    let conversationId: string | null = input.conversation_id ?? null;
    try {
      const upstream = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000)
      });
      if (!upstream.ok) {
        throw new Error(`Coze 返回 ${upstream.status}`);
      }
      const contentType = upstream.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        // Coze 业务失败（HTTP200 + JSON 错误体）：透出上游错误
        const errText = await upstream.text();
        let message = errText.slice(0, 200);
        try {
          const errObj = JSON.parse(errText) as { msg?: string; message?: string };
          message = errObj.msg ?? errObj.message ?? message;
        } catch { /* 保持 text 截断 */ }
        this.emitEvent(response, { type: 'error', message });
        return;
      }

      const reader = upstream.body?.getReader();
      if (!reader) throw new Error('Coze 无响应体');
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // 按 SSE 帧解析（\n\n 分隔）
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          this.handleFrame(frame, (evt) => {
            if (evt.type === 'done' && evt.conversation_id) conversationId = evt.conversation_id;
            this.emitEvent(response, evt);
          });
        }
      }
      this.emitEvent(response, { type: 'done', conversation_id: conversationId });
    } catch (error) {
      const message = error instanceof Error ? error.message : '对话失败，请稍后重试';
      this.emitEvent(response, { type: 'error', message });
    }
  }

  /** 解析单个 Coze SSE 帧，映射为统一契约事件 */
  private handleFrame(frame: string, push: (event: ChatExperienceEvent) => void): void {
    let eventName = '';
    let dataStr = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
    }
    if (!dataStr) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      return;
    }
    const msgData = (data.data && typeof data.data === 'object')
      ? (data.data as Record<string, unknown>)
      : data;

    if (eventName === 'conversation.message.delta' || msgData.type === 'answer') {
      const content = typeof msgData.content === 'string' ? msgData.content : '';
      if (content) push({ type: 'delta', content });
    } else if (eventName === 'conversation.chat.completed') {
      const convId = (msgData.conversation_id as string) || (msgData.id as string) || null;
      push({ type: 'done', conversation_id: convId });
    } else if (eventName === 'conversation.chat.failed') {
      const message = (msgData.msg as string) || (msgData.error_msg as string) || '对话失败，请稍后重试';
      push({ type: 'error', message });
    }
  }

  private emitEvent(response: Response, event: ChatExperienceEvent): void {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  private async findPublicWork(workId: string): Promise<WorkEntity> {
    const work = await this.dataSource.getRepository(WorkEntity).findOneBy({ id: workId });
    if (!work) throw new NotFoundException('作品不存在');
    if (!work.is_public) throw new ForbiddenException('该作品未公开');
    return work;
  }
}
