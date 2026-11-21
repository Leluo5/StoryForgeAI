import {
  arkClawChatRequestSchema,
  arkClawChatResponseSchema,
  type ArkClawChatResponse
} from '@storyforge/contracts';
import { apiRequest } from '../api/client';

export function sendArkClawMessage(message: string): Promise<ArkClawChatResponse> {
  const input = arkClawChatRequestSchema.parse({ message });
  return apiRequest('/api/v1/arkclaw/chat', arkClawChatResponseSchema, {
    method: 'POST',
    body: JSON.stringify(input)
  });
}
