// M3c-3 知识库 T20 Markdown 导入导出（纯函数，无 DB）
// 依据：F2 §3.6、§5.9；T03 契约 knowledgeFrontMatterSchema；T20 完成标准
// 边界（L2 服务层）：front matter 解析/序列化、文件名清洗、判重分类；不写 DB、不写 controller。
import { basename } from 'node:path';
import { UnprocessableEntityException } from '@nestjs/common';
import { parse, stringify } from 'yaml';
import { knowledgeErrorCode, knowledgeFrontMatterSchema } from '@storyforge/contracts';
import type { KnowledgeEntryType } from '@storyforge/contracts';

const { KNOWLEDGE_MARKDOWN_INVALID } = knowledgeErrorCode;

// front matter 分隔符
const FM_DELIMITER = '---';

export interface ParsedMarkdownEntry {
  title: string;
  type: KnowledgeEntryType;
  tags: string[];
  favorite: boolean;
  pinned: boolean;
  created_at?: string;
  original_text: string;
}

// ───────────────────────────── 解析（§3.6） ─────────────────────────────
// 无 front matter：以文件名作标题、按文章处理
// 有 front matter：YAML 子集，未知字段拒绝，type 限五类
export function parseMarkdown(raw: string, fileName: string): ParsedMarkdownEntry {
  // 去除 BOM
  const content = raw.replace(/^\uFEFF/, '');
  const hasFrontMatter = content.startsWith(FM_DELIMITER);

  if (!hasFrontMatter) {
    const title = cleanMarkdownFileName(fileName).replace(/\.md$/i, '') || '未命名条目';
    return {
      title,
      type: 'article',
      tags: [],
      favorite: false,
      pinned: false,
      original_text: content.trim()
    };
  }

  // 定位第二个 ---
  const firstEnd = content.indexOf('\n', FM_DELIMITER.length);
  if (firstEnd === -1) throw invalid();
  const closeDelimiter = content.indexOf(`\n${FM_DELIMITER}`, firstEnd);
  if (closeDelimiter === -1) throw invalid();

  const yamlText = content.slice(firstEnd + 1, closeDelimiter).trim();
  const bodyStart = closeDelimiter + FM_DELIMITER.length + 1;
  const originalText = content.slice(bodyStart).trim();

  let parsed: unknown;
  try {
    parsed = parse(yamlText);
  } catch {
    throw invalid();
  }

  // 用契约 schema 严格校验（未知字段拒绝、type 五类）
  const fm = knowledgeFrontMatterSchema.safeParse(parsed);
  if (!fm.success) throw invalid();

  return {
    title: fm.data.title,
    type: fm.data.type,
    tags: fm.data.tags,
    favorite: fm.data.favorite,
    pinned: fm.data.pinned,
    ...(fm.data.created_at ? { created_at: fm.data.created_at } : {}),
    original_text: originalText
  };
}

// ───────────────────────────── 序列化（§3.6） ─────────────────────────────
export interface SerializeMarkdownInput {
  title: string;
  type: KnowledgeEntryType;
  tags: string[];
  favorite: boolean;
  pinned: boolean;
  original_text: string;
  created_at?: string;
}

export function serializeMarkdown(input: SerializeMarkdownInput): string {
  const fm: Record<string, unknown> = {
    title: input.title,
    type: input.type,
    tags: input.tags,
    favorite: input.favorite,
    pinned: input.pinned
  };
  if (input.created_at) fm.created_at = input.created_at;

  const yamlText = stringify(fm).trimEnd();
  const lines = [
    FM_DELIMITER,
    yamlText,
    FM_DELIMITER,
    '',
    `# ${input.title}`,
    '',
    '## 原文',
    '',
    input.original_text,
    ''
  ];
  return lines.join('\n');
}

// ───────────────────────────── 文件名清洗（§3.6 同名 -2 后缀） ─────────────────────────────
export function cleanMarkdownFileName(raw: string, existing?: Set<string>): string {
  const base = basename(raw).replace(/[\\/]/g, '').trim();
  const safe = base || 'untitled';
  if (!existing || !existing.has(safe)) return safe;
  // 同名冲突：a.md → a-2.md
  const dot = safe.lastIndexOf('.');
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : '';
  let n = 2;
  while (existing.has(`${stem}-${n}${ext}`)) n++;
  return `${stem}-${n}${ext}`;
}

// ───────────────────────────── 判重分类（§5.9：title + 归一化哈希） ─────────────────────────────
export interface MarkdownImportCandidate {
  title: string;
  original_text: string;
  content_hash: string;
}
export interface ExistingEntry {
  title: string;
  content_hash: string;
}
export interface MarkdownImportClassification {
  index: number;
  conflict_type: 'same_content' | 'same_title_diff_content' | 'new';
  matched_hash?: string;
}

export function classifyMarkdownImport(
  candidates: MarkdownImportCandidate[],
  existing: ExistingEntry[]
): MarkdownImportClassification[] {
  const existingByHash = new Map(existing.map((e) => [e.content_hash, e]));
  const existingByTitle = new Map<string, ExistingEntry>();
  for (const e of existing) {
    if (!existingByTitle.has(e.title)) existingByTitle.set(e.title, e);
  }

  return candidates.map((c, index) => {
    const byHash = existingByHash.get(c.content_hash);
    if (byHash) {
      return { index, conflict_type: 'same_content', matched_hash: c.content_hash } as const;
    }
    const byTitle = existingByTitle.get(c.title);
    if (byTitle) {
      return { index, conflict_type: 'same_title_diff_content', matched_hash: byTitle.content_hash } as const;
    }
    return { index, conflict_type: 'new' } as const;
  });
}

function invalid(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: KNOWLEDGE_MARKDOWN_INVALID,
    message: 'Markdown front matter 无效'
  });
}
