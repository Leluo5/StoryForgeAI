import { describe, expect, it } from 'vitest';
import type { AgentChannel, AgentChannelName, AgentChannelRequest, AgentChannelResult } from '@storyforge/contracts';
import { AgentChannelRegistry } from './agent-channel.registry';

// 替身通道：记录调用参数，返回固定结果（不触真实厂商）
function makeStub(name: AgentChannelName): AgentChannel {
  return {
    name,
    async invoke(request: AgentChannelRequest): Promise<AgentChannelResult> {
      return { rawText: `stub:${name}`, model: `stub-${name}`, latencyMs: 1 };
    }
  };
}

describe('AgentChannelRegistry (T09)', () => {
  it('registers a channel and returns it by name', () => {
    const registry = new AgentChannelRegistry();
    const flowise = makeStub('flowise');
    registry.register(flowise);
    expect(registry.get('flowise')).toBe(flowise);
    expect(registry.has('flowise')).toBe(true);
    expect(registry.names()).toEqual(['flowise']);
  });

  it('throws when registering the same channel twice', () => {
    const registry = new AgentChannelRegistry();
    registry.register(makeStub('flowise'));
    expect(() => registry.register(makeStub('flowise'))).toThrow(/already registered/i);
  });

  it('throws COLLAB channel-not-configured for an unregistered channel', () => {
    const registry = new AgentChannelRegistry();
    expect(() => registry.get('coze')).toThrow(/not configured/i);
    expect(registry.has('coze')).toBe(false);
  });

  it('forwards the request to the registered channel (processor depends only on the port)', async () => {
    const registry = new AgentChannelRegistry();
    const calls: AgentChannelRequest[] = [];
    const coze: AgentChannel = {
      name: 'coze',
      async invoke(request: AgentChannelRequest): Promise<AgentChannelResult> {
        calls.push(request);
        return { rawText: 'coze-ok', model: 'coze-model', latencyMs: 5 };
      }
    };
    registry.register(coze);

    const request: AgentChannelRequest = {
      taskId: 'task-1',
      workId: 'work-1',
      author_id: 'author-1',
      channel: 'coze',
      instruction: '生成角色资料',
      roleContext: { name: '林默' },
      citations: [{ source_id: 's1', title: 't1', snippet: '片段' }],
      outputFields: ['identity', 'personality']
    };
    const result = await registry.get('coze').invoke(request);
    expect(result.rawText).toBe('coze-ok');
    expect(result.model).toBe('coze-model');
    expect(result.latencyMs).toBe(5);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.channel).toBe('coze');
  });

  it('supports multiple channels coexisting (flowise + coze) without clobbering', () => {
    const registry = new AgentChannelRegistry();
    registry.register(makeStub('flowise'));
    registry.register(makeStub('coze'));
    expect(registry.names().sort()).toEqual(['coze', 'flowise']);
    expect(registry.get('flowise').name).toBe('flowise');
    expect(registry.get('coze').name).toBe('coze');
  });
});
