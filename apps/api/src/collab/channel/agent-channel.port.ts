import type {
  AgentChannel,
  AgentChannelName,
  AgentChannelRequest,
  AgentChannelResult
} from '@storyforge/contracts';

// F11 通道端口：任务处理器只依赖本端口，不出现厂商分支（F2 §5.1）
// 端口契约类型来自 packages/contracts（跨层共享），此处仅做 api 侧统一出口
export type { AgentChannel, AgentChannelName, AgentChannelRequest, AgentChannelResult };
