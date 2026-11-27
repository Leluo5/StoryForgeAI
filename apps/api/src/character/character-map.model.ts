// M4-T8 AI 建图：模型 Provider 契约
// 建图输入 = 已入库角色列表（不抽取角色，只生成关系边）
// 输出 = 关系边列表（from/to 用角色 name 或 id 引用，relation_type 用归一类型 code/label）

/** 建图输入的角色上下文（来自 character 表已入库角色） */
export interface CharacterMapCharacterInput {
  id: string;
  name: string;
  identity?: string | null;
  age_band?: string | null;
  faction?: string | null;
}

/** LLM 输出的一条关系边 */
export interface CharacterMapRelationOutput {
  from: string; // 角色 name 或 id
  to: string; // 角色 name 或 id
  relation_type: string; // 归一类型 code 或 label
  note?: string | null;
}

/** 建图 LLM 输出 */
export interface CharacterMapOutput {
  relations: CharacterMapRelationOutput[];
}

/** 建图模型 Provider 输入：作品上下文 + 已入库角色 */
export interface CharacterMapModelContext {
  workId: string;
  characters: CharacterMapCharacterInput[];
}

/** 可插拔建图模型 Provider 接口（character 域，不复用章节域 AiModelProvider 的 ProseMirror 结构） */
export interface CharacterMapModelProvider {
  /** 生成角色关系边；失败时抛 Error（由 handler 转 failed retryable） */
  generateCharacterMap(context: CharacterMapModelContext): Promise<CharacterMapOutput>;
}

/** DI 注入令牌（接口无运行时元数据，用 Symbol 注入） */
export const CHARACTER_MAP_MODEL_PROVIDER = Symbol('CHARACTER_MAP_MODEL_PROVIDER');

/** 建图模型错误：携带可重试标记 */
export class CharacterMapModelError extends Error {
  constructor(
    message: string,
    public readonly retryable = true
  ) {
    super(message);
    this.name = 'CharacterMapModelError';
  }
}

/** Mock 建图 Provider：固定输出 + 可配置延迟/失败，保证测试确定性 */
export class MockCharacterMapModelProvider implements CharacterMapModelProvider {
  constructor(
    private readonly options?: {
      latencyMs?: number;
      fail?: boolean;
      output?: CharacterMapOutput;
    }
  ) {}

  async generateCharacterMap(context: CharacterMapModelContext): Promise<CharacterMapOutput> {
    const opts = this.options;
    if (opts?.latencyMs) {
      await new Promise((r) => setTimeout(r, opts.latencyMs));
    }
    if (opts?.fail) {
      throw new CharacterMapModelError('mock 建图失败', true);
    }
    if (opts?.output) return opts.output;
    // 默认输出：空关系边（角色 < 2 时由 handler 前置判定，不调用本方法）
    return { relations: [] };
  }
}
