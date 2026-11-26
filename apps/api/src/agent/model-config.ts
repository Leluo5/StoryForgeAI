import { modelConfigV2Schema, type ModelConfigV2 } from '@storyforge/contracts';

/** 默认模型参数（与契约 modelConfigV2Schema 的 default 值一致；model 为 optional 缺省不输出）。 */
export const DEFAULT_MODEL_CONFIG: ModelConfigV2 = {
  temperature: 0.7,
  top_p: 1.0,
  max_tokens: 2048,
  system_prompt: '',
  stream: false,
  frequency_penalty: 0,
  presence_penalty: 0,
  response_format: 'text',
  stop: []
};

/**
 * 归一化 model_config（M4-T6：完整 LLM 参数校验 + 默认补齐）。
 * 用契约 modelConfigV2Schema.parse 强校验并补默认值；缺省字段由 Zod default 补齐，
 * 旧记录（仅 {temperature, max_tokens}）可读。返回完整 ModelConfigV2。
 * @throws ZodError 当值越界/类型错误时。
 */
export function normalizeModelConfig(raw: unknown): ModelConfigV2 {
  const cfg = modelConfigV2Schema.parse(raw ?? {});
  return cfg;
}
