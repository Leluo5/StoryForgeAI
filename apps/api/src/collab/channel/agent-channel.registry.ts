import type { AgentChannel, AgentChannelName } from '@storyforge/contracts';
import { Injectable } from '@nestjs/common';

// F11 通道注册表：按 name 注入实现，任务处理器只依赖端口（F2 §5.1）
// 通道缺失时抛 COLLAB_CHANNEL_NOT_CONFIGURED（由任务创建阶段拦截，F2 §5.7）
@Injectable()
export class AgentChannelRegistry {
  private readonly channels = new Map<AgentChannelName, AgentChannel>();

  register(channel: AgentChannel): void {
    if (this.channels.has(channel.name)) {
      throw new Error(`Channel already registered: ${channel.name}`);
    }
    this.channels.set(channel.name, channel);
  }

  get(name: AgentChannelName): AgentChannel {
    const channel = this.channels.get(name);
    if (!channel) {
      throw new Error(`Channel not configured: ${name}`);
    }
    return channel;
  }

  has(name: AgentChannelName): boolean {
    return this.channels.has(name);
  }

  names(): AgentChannelName[] {
    return [...this.channels.keys()];
  }
}
