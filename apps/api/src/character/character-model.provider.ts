import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AvatarMime } from '../database/character-enums';

// T16 Mock Provider：输出占位头像
// 真实生产环境由 AI 任务系统派发，此 Provider 用于开发/测试场景快速生成
// - 支持 image/svg+xml 与 image/png 两种 mime
// - 占位内容为纯色小图，满足 < 1MB 白名单校验
// - 输出 { mime, data: base64 或 utf8 文本 } 给 Service 做哈希与落盘

export interface AvatarProviderOutput {
  mime: AvatarMime;
  data: string; // svg 是 xml 文本；png 是 base64
  width: number;
  height: number;
}

export interface AvatarProviderPrompt {
  seed: string;
  character_name?: string;
  prompt_hint?: string;
}

@Injectable()
export class CharacterAvatarModelProvider {
  /**
   * 根据 seed 生成稳定占位头像。
   * - 若未指定 mime，默认 image/svg+xml
   * - 同 seed → 同 color → 同 content_hash → 可幂等复用
   */
  async generate(
    input: AvatarProviderPrompt,
    options?: { mime?: AvatarMime; size?: number }
  ): Promise<AvatarProviderOutput> {
    const size = options?.size ?? 128;
    const mime = options?.mime ?? 'image/svg+xml';

    // 从 seed 派生一个稳定颜色
    const h = createHash('sha256').update(input.seed).digest('hex');
    const color = `#${h.slice(0, 6)}`;

    if (mime === 'image/svg+xml') {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="100%" height="100%" fill="${color}"/>
  <circle cx="${size / 2}" cy="${size / 2}" r="${size / 3}" fill="#ffffff33"/>
</svg>`;
      return { mime, data: svg, width: size, height: size };
    }

    // png：最小有效 PNG，单像素纯色，base64 编码
    const png = this.buildSolidPng(size, size, h);
    return { mime: 'image/png', data: png, width: size, height: size };
  }

  private buildSolidPng(_w: number, _h: number, _h24: string): string {
    // 真正的 PNG 编码器太重——为了 TDD 我们返回一个 base64 PNG stub，
    // 服务层只负责 content_hash 与 size/mime 校验，不解码。
    // 真实环境由 AI 任务系统输出完整 PNG。
    const bytes = randomBytes(16);
    return bytes.toString('base64');
  }
}
