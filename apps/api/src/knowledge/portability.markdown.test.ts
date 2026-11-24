// M3c-3 知识库 T20 Markdown 导入导出（纯函数，无 DB）
// 依据：F2 §3.6、§5.9；T03 契约 knowledgeFrontMatterSchema；T20 完成标准
// 覆盖：front matter 解析（含缺省/非法 type/未知字段拒绝）；序列化往返；
//       文件名清洗与同名冲突后缀；判重分类（new/same_content/same_title_diff_content）；编码回退。
import { knowledgeErrorCode } from '@storyforge/contracts';
import {
  cleanMarkdownFileName,
  classifyMarkdownImport,
  parseMarkdown,
  serializeMarkdown
} from './portability.markdown';

const { KNOWLEDGE_PARSE_FAILED } = knowledgeErrorCode;

describe('MarkdownFrontMatter · 解析', () => {
  it('解析完整 front matter', () => {
    const md = [
      '---',
      'title: 示例标题',
      'type: article',
      'tags: [素材, 世界观]',
      'favorite: true',
      'pinned: false',
      'created_at: 2026-11-21T10:00:00.000Z',
      '---',
      '',
      '# 示例标题',
      '',
      '正文内容'
    ].join('\n');
    const res = parseMarkdown(md, 'a.md');
    expect(res.title).toBe('示例标题');
    expect(res.type).toBe('article');
    expect(res.tags).toEqual(['素材', '世界观']);
    expect(res.favorite).toBe(true);
    expect(res.original_text).toContain('正文内容');
  });

  it('缺 front matter 时以文件名作标题、按文章处理', () => {
    const res = parseMarkdown('只有正文没有元数据', '我的笔记.md');
    expect(res.title).toBe('我的笔记');
    expect(res.type).toBe('article');
  });

  it('非法 type 抛 422', () => {
    const md = ['---', 'title: x', 'type: video', '---', '', 'body'].join('\n');
    expect(() => parseMarkdown(md, 'a.md')).toThrow();
  });

  it('未知字段拒绝（strict）', () => {
    const md = ['---', 'title: x', 'type: article', 'extra: y', '---', '', 'body'].join('\n');
    expect(() => parseMarkdown(md, 'a.md')).toThrow();
  });

  it('BOM 自动去除', () => {
    const md = '\uFEFF---\ntitle: 带BOM\ntype: novel\n---\n\n正文';
    const res = parseMarkdown(md, 'a.md');
    expect(res.title).toBe('带BOM');
  });
});

describe('MarkdownFrontMatter · 序列化往返', () => {
  it('条目序列化为 md 后可再解析', () => {
    const source = {
      title: '往返标题',
      type: 'paper' as const,
      tags: ['标签A'],
      favorite: true,
      pinned: false,
      original_text: '论文正文内容',
      created_at: '2026-11-21T10:00:00.000Z'
    };
    const md = serializeMarkdown(source);
    const res = parseMarkdown(md, 'roundtrip.md');
    expect(res.title).toBe('往返标题');
    expect(res.type).toBe('paper');
    expect(res.original_text).toContain('论文正文内容');
  });

  it('serialize 输出含 YAML front matter 分隔符', () => {
    const md = serializeMarkdown({ title: 'T', type: 'article', tags: [], favorite: false, pinned: false, original_text: 'b' });
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('## 原文');
  });
});

describe('MarkdownFileName · 清洗与冲突后缀', () => {
  it('清洗非法字符与路径', () => {
    expect(cleanMarkdownFileName('../../a/b.md')).toBe('b.md');
    expect(cleanMarkdownFileName('c:\\d.md')).toBe('d.md');
  });

  it('同名冲突追加 -2 后缀', () => {
    expect(cleanMarkdownFileName('a.md', new Set(['a.md']))).toBe('a-2.md');
    expect(cleanMarkdownFileName('a.md', new Set(['a.md', 'a-2.md']))).toBe('a-3.md');
  });
});

describe('MarkdownImport · 判重分类', () => {
  it('无冲突为 new', () => {
    const res = classifyMarkdownImport(
      [{ title: '新条目', original_text: '内容', content_hash: 'h1' }],
      []
    );
    expect(res).toEqual([{ index: 0, conflict_type: 'new' }]);
  });

  it('同 content_hash 为 same_content', () => {
    const res = classifyMarkdownImport(
      [{ title: '重复', original_text: '内容', content_hash: 'abc' }],
      [{ title: '已存在', content_hash: 'abc' }]
    );
    expect(res).toEqual([{ index: 0, conflict_type: 'same_content', matched_hash: 'abc' }]);
  });

  it('同标题不同内容为 same_title_diff_content', () => {
    const res = classifyMarkdownImport(
      [{ title: '同名', original_text: '新内容', content_hash: 'h2' }],
      [{ title: '同名', content_hash: 'h1' }]
    );
    expect(res).toEqual([{ index: 0, conflict_type: 'same_title_diff_content', matched_hash: 'h1' }]);
  });
});
