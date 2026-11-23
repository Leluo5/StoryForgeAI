import { describe, expect, it } from 'vitest';
import {
  buildExportMarkdown,
  buildFilename,
  buildPreviewItem,
  buildZip,
  decodeBytes,
  detectConflict,
  EncodingError,
  importFiles,
  KnowledgeMarkdownService,
  parseMarkdownText,
  sanitizeFilename
} from './knowledge-markdown.service';
import { hashContent } from './knowledge.service';

const service = new KnowledgeMarkdownService();

function entry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'k_001',
    type: 'novel',
    title: '龙火传说',
    source: 'upload',
    tags: ['玄幻', '龙'],
    created_at: '2026-11-12T10:00:00',
    updated_at: '2026-11-12T10:00:00',
    raw_content: '## 第一章 觉醒\n\n林远踏入灰雾。',
    ...overrides
  };
}

describe('decodeBytes', () => {
  it('utf-8 解码', () => {
    expect(decodeBytes(Buffer.from('中文测试', 'utf8'))).toBe('中文测试');
  });

  it('gbk 兜底解码', async () => {
    const iconv = (await import('iconv-lite')).default;
    const gbk = iconv.encode('中文测试', 'gbk');
    expect(decodeBytes(gbk)).toBe('中文测试');
  });

  it('str 直通', () => {
    expect(decodeBytes('already str')).toBe('already str');
  });
});

describe('sanitizeFilename', () => {
  it('非法字符替换为 _', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('空格压缩并 trim', () => {
    expect(sanitizeFilename('  龙火   传说  ')).toBe('龙火 传说');
  });

  it('空兜底 untitled', () => {
    expect(sanitizeFilename('')).toBe('untitled');
    expect(sanitizeFilename('   ')).toBe('untitled');
  });

  it('截断 80', () => {
    expect(sanitizeFilename('长'.repeat(200))).toHaveLength(80);
  });

  it('首尾点/空格剥离', () => {
    expect(sanitizeFilename('.龙火传说.')).toBe('龙火传说');
  });
});

describe('buildFilename', () => {
  it('带时间戳格式', () => {
    const name = buildFilename('龙火传说', new Date(2026, 10, 12, 10, 30, 5));
    expect(name).toBe('龙火传说_20261112_103005.md');
  });

  it('非法字符清理', () => {
    const name = buildFilename('a/b:c*', new Date(2026, 10, 12, 10, 30, 5));
    expect(name).toBe('a_b_c_20261112_103005.md');
  });
});

describe('buildExportMarkdown', () => {
  it('MD-14：正文与 raw_content 逐字符一致', () => {
    const raw = '## 第一章 觉醒\n\n林远踏入灰雾。\n\n```python\nprint(\'hi\')\n```\n\n- 要点一\n- 要点二';
    const out = buildExportMarkdown(entry({ raw_content: raw }));
    expect(out.startsWith('<!-- knowledge-export')).toBe(true);
    expect(out).toContain('# 龙火传说');
    expect(out).toContain(raw);
    // 剥离注释与标题后逐字符一致
    const parsed = parseMarkdownText(out);
    expect(parsed.raw_content).toBe(raw);
  });

  it('with_meta=false 仅标题+正文', () => {
    const out = buildExportMarkdown(entry(), false);
    expect(out).not.toContain('knowledge-export');
    expect(out).toBe('# 龙火传说\n\n## 第一章 觉醒\n\n林远踏入灰雾。');
  });
});

describe('parseMarkdownText', () => {
  it('H1 提取标题', () => {
    const parsed = parseMarkdownText('# 龙火传说\n\n正文');
    expect(parsed.title).toBe('龙火传说');
    // 无导出注释：raw_content 保留原文（含 H1）
    expect(parsed.raw_content).toBe('# 龙火传说\n\n正文');
  });

  it('首个非空行作标题', () => {
    const parsed = parseMarkdownText('## 第二章\n\n内容');
    expect(parsed.title).toBe('## 第二章');
  });

  it('格式统计', () => {
    const text = '# 标题\n## 一\n正文\n```python\ncode\n```\n![img](a.png)\n- 列表项\n| 名 | 值 |\n|----|----|\n| a | b |\n> 引用';
    const stats = parseMarkdownText(text).format_stats;
    expect(stats.headings).toBe(2);
    expect(stats.code_blocks).toBe(1);
    expect(stats.images).toBe(1);
    expect(stats.lists).toBe(1);
    expect(stats.tables).toBe(1);
    expect(stats.blockquotes).toBe(1);
  });

  it('元数据注释剥离', () => {
    const text = '<!-- knowledge-export\nid: k_1\ntype: novel\n-->\n# 龙火传说\n\n正文';
    const parsed = parseMarkdownText(text);
    expect(parsed.title).toBe('龙火传说');
    expect(parsed.raw_content).toBe('正文');
  });

  it('无注释时原文保留', () => {
    const text = '# 标题\n\n正文';
    expect(parseMarkdownText(text).raw_content).toBe('# 标题\n\n正文');
  });

  it('空输入兜底', () => {
    expect(parseMarkdownText('').title).toBe('untitled');
    expect(parseMarkdownText('').raw_content).toBe('');
  });
});

describe('detectConflict', () => {
  it('identical：标题+哈希均同', () => {
    const entries = [{ id: 'k_1', title: '龙火', content_hash: hashContent('内容A'), raw_content: '内容A' }];
    const c = detectConflict('龙火', '内容A', entries);
    expect(c.is_dup).toBe(true);
    expect(c.reason).toBe('identical');
    expect(c.existing_id).toBe('k_1');
  });

  it('name_collision：标题同内容异', () => {
    const entries = [{ id: 'k_1', title: '龙火', content_hash: hashContent('内容A'), raw_content: '内容A' }];
    const c = detectConflict('龙火', '内容B', entries);
    expect(c.is_dup).toBe(true);
    expect(c.reason).toBe('name_collision');
  });

  it('无冲突', () => {
    const entries = [{ id: 'k_1', title: '其他', content_hash: hashContent('内容A'), raw_content: '内容A' }];
    const c = detectConflict('龙火', '内容A', entries);
    expect(c.is_dup).toBe(false);
    expect(c.reason).toBe('');
  });
});

describe('buildPreviewItem', () => {
  it('有效无冲突', () => {
    const item = buildPreviewItem({ file_name: 'a.md', content: '# 标题\n\n正文' }, [], 'article');
    expect(item.valid).toBe(true);
    expect(item.title).toBe('标题');
    expect(item.conflict).toBe('new');
  });

  it('坏扩展名', () => {
    const item = buildPreviewItem({ file_name: 'a.txt', content: '# 标题' }, [], 'article');
    expect(item.valid).toBe(false);
    expect(item.reason).toBe('bad_extension');
  });

  it('空内容', () => {
    const item = buildPreviewItem({ file_name: 'a.md', content: '   ' }, [], 'article');
    expect(item.valid).toBe(false);
    expect(item.reason).toBe('empty_content');
  });

  it('冲突标记', () => {
    const entries = [{ id: 'k_1', title: '龙火', content_hash: hashContent('内容A'), raw_content: '内容A' }];
    const item = buildPreviewItem({ file_name: '龙火.md', content: '# 龙火\n\n内容B' }, entries, 'novel');
    expect(item.valid).toBe(true);
    expect(item.conflict).toBe('name_collision');
  });
});

describe('importFiles', () => {
  const upsert = async () => {};

  it('新建无冲突', async () => {
    const r = await importFiles(
      [{ file_name: '龙火传说.md', title: '龙火传说', content: '正文内容' }],
      'rename',
      { targetType: 'novel', existing: [], upsert }
    );
    expect(r.total).toBe(1);
    expect(r.success).toBe(1);
    expect(r.created).toBe(1);
    expect(r.updated).toBe(0);
  });

  it('坏扩展名计入 failed', async () => {
    const r = await importFiles(
      [{ file_name: 'doc.txt', title: '标题', content: '# 标题' }],
      'rename',
      { targetType: 'article', existing: [], upsert }
    );
    expect(r.success).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.failed_items[0]?.reason).toBe('bad_extension');
  });

  it('overwrite 策略更新', async () => {
    const existing = [{ id: 'k_1', title: '龙火', content_hash: hashContent('内容A'), raw_content: '内容A' }];
    const r = await importFiles(
      [{ file_name: '龙火.md', title: '龙火', content: '内容B' }],
      'overwrite',
      { targetType: 'novel', existing, upsert }
    );
    expect(r.success).toBe(1);
    expect(r.updated).toBe(1);
  });

  it('rename 策略新建（加 _imported）', async () => {
    const existing = [{ id: 'k_1', title: '龙火', content_hash: hashContent('内容A'), raw_content: '内容A' }];
    const r = await importFiles(
      [{ file_name: '龙火.md', title: '龙火', content: '内容B' }],
      'rename',
      { targetType: 'novel', existing, upsert }
    );
    expect(r.success).toBe(1);
    expect(r.created).toBe(1);
  });

  it('skip 策略跳过', async () => {
    const existing = [{ id: 'k_1', title: '龙火', content_hash: hashContent('内容A'), raw_content: '内容A' }];
    const r = await importFiles(
      [{ file_name: '龙火.md', title: '龙火', content: '内容B' }],
      'skip',
      { targetType: 'novel', existing, upsert }
    );
    expect(r.success).toBe(0);
    expect(r.created).toBe(0);
    expect(r.updated).toBe(0);
  });

  it('identical + rename 视为 skip（成功不计创建）', async () => {
    const existing = [{ id: 'k_1', title: '龙火', content_hash: hashContent('内容A'), raw_content: '内容A' }];
    const r = await importFiles(
      [{ file_name: '龙火.md', title: '龙火', content: '内容A' }],
      'rename',
      { targetType: 'novel', existing, upsert }
    );
    expect(r.success).toBe(1);
    expect(r.created).toBe(0);
  });
});

describe('buildZip', () => {
  it('ZIP 字节可解包', async () => {
    const buf = await buildZip([
      { file_name: 'a.md', content: '# A' },
      { file_name: 'b.md', content: '# B' }
    ]);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files);
    expect(names).toHaveLength(2);
    expect(await zip.file('a.md')!.async('string')).toBe('# A');
    expect(await zip.file('b.md')!.async('string')).toBe('# B');
  });

  it('文件名冲突去重', async () => {
    const buf = await buildZip([
      { file_name: 'a.md', content: '# A' },
      { file_name: 'a.md', content: '# A2' }
    ]);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files);
    expect(names).toHaveLength(2);
    expect(names).toContain('a.md');
    expect(names.some((n) => n.startsWith('a_1'))).toBe(true);
  });
});

describe('KnowledgeMarkdownService · 门面', () => {
  it('validate 有效', () => {
    expect(service.validate('d.md', '# 校验\n\n正文').valid).toBe(true);
  });

  it('validate 无效扩展名', () => {
    const r = service.validate('d.txt', '内容');
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('bad_extension');
  });

  it('preview 批量', () => {
    const items = service.preview(
      [{ file_name: 'a.md', content: '# 标题\n\n正文' }],
      'article',
      []
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('标题');
    expect(items[0]?.conflict).toBe('new');
  });

  it('execute 统计', async () => {
    const r = await service.execute(
      {
        items: [
          { file_name: 'c.md', title: '新文档', type: 'article', content: '内容C' },
          { file_name: 'bad.txt', title: '坏', type: 'article', content: '# 坏' }
        ],
        target_type: 'article',
        conflict_strategy: 'rename'
      },
      [],
      async () => {}
    );
    expect(r.total).toBe(2);
    expect(r.success).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.created).toBe(1);
  });
});
