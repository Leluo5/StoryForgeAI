// 剧情推衍模型端口：与章节创作模型（AiModelProvider）隔离，
// 避免剧情任务复用 ProseMirror 文档生成路径。

export interface PlotContextNode {
  id: string;
  title: string;
  summary: string | null;
}

export interface PlotStepContext {
  workId: string;
  sessionId: string;
  stepNo: number;
  place: string;
  background: string;
  timeNode: string | null;
  premiseNodes: PlotContextNode[];
  relatedNodes: PlotContextNode[];
  characters: Array<{ name: string; description: string }>;
  randomEnabled: boolean;
  randomCharacterEnabled: boolean;
  history: string[];
}

export interface PlotStepCandidate {
  content: string;
  event: { title: string; description: string } | null;
  new_characters: Array<{ name: string; description: string }>;
  branches: Array<{ id: string; label: string; description: string }>;
}

export interface PlotModelProvider {
  generateStep(context: PlotStepContext): Promise<PlotStepCandidate>;
}

export const PLOT_MODEL_PROVIDER = Symbol('PLOT_MODEL_PROVIDER');

export class PlotModelError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
    readonly code = 'PLOT_MODEL_ERROR'
  ) {
    super(message);
    this.name = 'PlotModelError';
  }
}

export interface MockPlotModelOptions {
  fail?: boolean;
  delayMs?: number;
}

/** 确定性 Mock：无外部依赖，供本地开发与测试使用 */
export class MockPlotModelProvider implements PlotModelProvider {
  constructor(private readonly options: MockPlotModelOptions = {}) {}

  async generateStep(context: PlotStepContext): Promise<PlotStepCandidate> {
    if (this.options.delayMs) await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    if (this.options.fail) throw new PlotModelError('mock plot generation failure', true, 'MOCK_PLOT_FAIL');

    const when = context.timeNode ? `（${context.timeNode}）` : '';
    const premise = context.premiseNodes.map((node) => node.title).join('、');
    return {
      content: [
        `第 ${context.stepNo} 步：${context.place}${when}。`,
        premise ? `承接前情：${premise}。` : '',
        `${context.characters.map((character) => character.name).join('、')}推进了调查。`,
        context.history.length > 0 ? `已知经过：${context.history.slice(-2).join('；')}` : ''
      ]
        .filter(Boolean)
        .join(''),
      event: context.randomEnabled ? { title: '突发变故', description: '局势在此时出现意外转折。' } : null,
      new_characters: context.randomCharacterEnabled
        ? [{ name: `神秘人${context.stepNo}`, description: '身份不明，似乎掌握关键线索' }]
        : [],
      branches: [
        { id: 'branch_a', label: '追查线索', description: '顺藤摸瓜，风险较低' },
        { id: 'branch_b', label: '正面冲突', description: '直接对峙，代价更高' }
      ]
    };
  }
}
