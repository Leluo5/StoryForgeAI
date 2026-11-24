import { describe, expect, it } from 'vitest';
import { classifyEntryType, type ClassifyInput } from './classify';

// F2 §5.2 类型识别（纯函数）：论文 / 小说 / 灵感 / 文章（默认）+ 设定集永不自动识别。
function input(partial: Partial<ClassifyInput> & { rawContent: string }): ClassifyInput {
  return { ...partial };
}

describe('classifyEntryType · 手动指定', () => {
  it('手动指定优先于启发式', () => {
    const r = classifyEntryType(input({ rawContent: '论文摘要关键词参考文献', manualType: 'setting' }));
    expect(r.type).toBe('setting');
  });

  it('手动指定为 article 时不触发启发式', () => {
    const r = classifyEntryType(input({ rawContent: '这是一篇研究实验论文摘要关键词', manualType: 'article' }));
    expect(r.type).toBe('article');
  });
});

describe('classifyEntryType · 论文', () => {
  it('文件名含 论文/paper/abstract → paper', () => {
    expect(classifyEntryType(input({ rawContent: '内容', fileName: '我的论文.md' })).type).toBe('paper');
    expect(classifyEntryType(input({ rawContent: '内容', fileName: 'paper-final.txt' })).type).toBe('paper');
    expect(classifyEntryType(input({ rawContent: '内容', fileName: 'abstract_v1.pdf' })).type).toBe('paper');
  });

  it('正文含 摘要/关键词/参考文献 ≥2 个 → paper', () => {
    const r = classifyEntryType(input({ rawContent: '本文包含摘要与关键词，另有参考文献列表。' }));
    expect(r.type).toBe('paper');
  });

  it('仅含 1 个论文信号 → 不判为 paper', () => {
    const r = classifyEntryType(input({ rawContent: '这里只有摘要两个字。' }));
    expect(r.type).not.toBe('paper');
  });
});

describe('classifyEntryType · 小说', () => {
  it('含「第 X 章」≥2 处 → novel', () => {
    const r = classifyEntryType(input({ rawContent: '第一章 开局\n内容A\n第二章 发展\n内容B\n第三章 高潮\n内容C' }));
    expect(r.type).toBe('novel');
  });

  it('含「Chapter X」≥2 处 → novel', () => {
    const r = classifyEntryType(input({ rawContent: 'Chapter 1 Start\nChapter 2 Middle\nChapter 3 End' }));
    expect(r.type).toBe('novel');
  });

  it('对话引号比例高且长度 >5000 字 → novel', () => {
    // 每行约 13 字符含 2 个引号，600 行 ≈ 7800 字符 > 5000，引号比例 ≈ 0.15 > 0.05
    const longDialogue = Array.from({ length: 600 }, (_, i) => `“他说这是第${i}句对话内容”`).join('\n');
    const r = classifyEntryType(input({ rawContent: longDialogue }));
    expect(r.type).toBe('novel');
  });

  it('对话引号比例高但长度 ≤5000 字 → 不判为 novel', () => {
    const shortDialogue = '“他说一句”\n“她又说一句”';
    const r = classifyEntryType(input({ rawContent: shortDialogue }));
    expect(r.type).not.toBe('novel');
  });
});

describe('classifyEntryType · 灵感', () => {
  it('长度 <800 且含 灵感/想法/突然想到 → inspiration', () => {
    const r = classifyEntryType(input({ rawContent: '突然想到一个点子：把知识库做成图数据库。' }));
    expect(r.type).toBe('inspiration');
  });

  it('仅一段短文本（无空行）→ inspiration', () => {
    const r = classifyEntryType(input({ rawContent: '就一句话的短想法。' }));
    expect(r.type).toBe('inspiration');
  });

  it('长度 <800 但无灵感标记且有多段 → 不判为 inspiration', () => {
    const r = classifyEntryType(input({ rawContent: '第一段。\n\n第二段。\n\n第三段。' }));
    expect(r.type).not.toBe('inspiration');
  });
});

describe('classifyEntryType · 默认文章与置信度', () => {
  it('无任何信号 → article + 低置信度 + 不确定性警告', () => {
    // 多段、无灵感标记、无章节、无论文标记、长度不超 5000：纯普通文章
    const r = classifyEntryType(input({ rawContent: '第一段普通内容。\n\n第二段普通内容。\n\n第三段普通内容。' }));
    expect(r.type).toBe('article');
    expect(r.confidence).toBe('low');
    expect(r.warnings).toContain('KNOWLEDGE_TYPE_UNCERTAIN');
  });

  it('命中论文 → 高置信度且无警告', () => {
    const r = classifyEntryType(input({ rawContent: '摘要与关键词，参考文献齐全。' }));
    expect(r.confidence).toBe('high');
    expect(r.warnings).not.toContain('KNOWLEDGE_TYPE_UNCERTAIN');
  });
});
