import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import iconv from 'iconv-lite';
import type {
  ImportKnowledgeResult,
  ImportKnowledgeRequest,
  ImportPreviewItem,
  KnowledgeEntry,
  KnowledgeType,
  ValidateKnowledgeMarkdownResponse
} from '@storyforge/contracts';

// ═══════════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════════

export const CONFLICT_IDENTICAL = 'identical' as const;
export const CONFLICT_NAME = 'name_collision' as const;
export const CONFLICT_NEW = 'new' as const;

// 支持的 Markdown 扩展名（对齐旧 F5：.md / .markdown；.txt 不识别为 Markdown）
const MARKDOWN_EXTENSIONS = ['.md', '.markdown'] as const;

export class EncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncodingError';
  }
}

// 导出元数据注释标记（对齐旧 F5 MD-8：首行注释供导入时剥离）
const META_PREFIX = '<!-- knowledge-export';
/** 标题最大长度（对齐旧 F5：60 字） */
const TITLE_MAX = 60;

// ═══════════════════════════════════════════════════════════════════
// 文件名工具
// ═══════════════════════════════════════════════════════════════════

const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g;

/** 清理文件名：非法字符→_，压缩空格，trim 首尾点/空格/下划线，空兜底 untitled，截断 max。 */
export function sanitizeFilename(name: string, max = 80): string {
  let result = name
    .replace(ILLEGAL_FILENAME_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. _]+|[. _]+$/g, '');
  if (!result) result = 'untitled';
  if (result.length > max) result = result.slice(0, max);
  return result;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 生成规范文件名：`{title}_{YYYYMMDD_HHMMSS}.md`。 */
export function buildFilename(title: string, date = new Date()): string {
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${sanitizeFilename(title)}_${y}${m}${d}_${hh}${mm}${ss}.md`;
}

// ═══════════════════════════════════════════════════════════════════
// 字节解码（UTF-8 优先，GBK 兜底）
// ═══════════════════════════════════════════════════════════════════

/** 解码文件字节：str 直通；Buffer 尝试 UTF-8（严格），失败尝试 GBK，再失败抛 EncodingError。 */
export function decodeBytes(input: string | Buffer): string {
  if (typeof input === 'string') return input;
  try {
    const decoded = iconv.decode(input, 'utf8');
    // UTF-8 严格校验：若含替换符说明编码不匹配，尝试 GBK
    if (decoded.includes('\uFFFD')) return iconv.decode(input, 'gbk');
    return decoded;
  } catch {
    throw new EncodingError('Unable to decode file bytes (UTF-8/GBK)');
  }
}

// ═══════════════════════════════════════════════════════════════════
// 格式统计
// ═══════════════════════════════════════════════════════════════════

export interface MarkdownFormatStats {
  headings: number;
  code_blocks: number;
  images: number;
  lists: number;
  tables: number;
  blockquotes: number;
}

/** 统计 Markdown 格式元素（粗粒度正则，对齐旧 F5 语义：表格按连续 `|` 行块计 1）。 */
export function countFormatStats(text: string): MarkdownFormatStats {
  const lines = text.split('\n');
  let headings = 0;
  let codeBlocks = 0;
  let images = 0;
  let lists = 0;
  let tables = 0;
  let blockquotes = 0;
  let inCode = false;
  let inTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inCode = !inCode;
      if (inCode) codeBlocks += 1;
      continue;
    }
    if (inCode) continue;
    if (/^#{1,6}\s+/.test(trimmed)) headings += 1;
    if (/^!\[[^\]]*\]\([^)]*\)/.test(trimmed)) images += 1;
    if (/^\s*[-*+]\s+/.test(trimmed)) lists += 1;
    // 表格块：连续 `|` 行视为一个表格
    if (/^\s*\|.+\|\s*$/.test(trimmed)) {
      if (!inTable) {
        tables += 1;
        inTable = true;
      }
    } else {
      inTable = false;
    }
    if (/^\s*>\s?/.test(trimmed)) blockquotes += 1;
  }
  return { headings, code_blocks: codeBlocks, images, lists, tables, blockquotes };
}

// ═══════════════════════════════════════════════════════════════════
// 导出渲染（MD-14：正文与 raw_content 逐字符一致）
// ═══════════════════════════════════════════════════════════════════

export interface ExportEntry {
  id: string;
  type: string;
  title: string;
  source?: string;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
  raw_content?: string;
}

/**
 * 渲染单条导出 Markdown。
 * with_meta=true：首行元数据注释 + H1 标题 + 空行 + 正文（raw_content 原样）。
 * with_meta=false：仅 `# title\n\n正文`（用于单文件下载）。
 */
export function buildExportMarkdown(entry: ExportEntry, withMeta = true): string {
  const title = entry.title?.trim() || 'untitled';
  const raw = entry.raw_content ?? '';
  if (!withMeta) {
    return `# ${title}\n\n${raw}`;
  }
  const lines = [
    `${META_PREFIX}`,
    `id: ${entry.id}`,
    `type: ${entry.type}`,
    `title: ${title}`,
    `source: ${entry.source ?? 'manual'}`,
    `tags: ${(entry.tags ?? []).join(',')}`,
    `created_at: ${entry.created_at ?? ''}`,
    `updated_at: ${entry.updated_at ?? ''}`,
    '-->'
  ];
  return `${lines.join('\n')}\n# ${title}\n\n${raw}`;
}

// ═══════════════════════════════════════════════════════════════════
// 解析导入 Markdown（剥离元数据注释 + 生成器 H1）
// ═══════════════════════════════════════════════════════════════════

export interface ParsedMarkdown {
  title: string;
  raw_content: string;
  format_stats: MarkdownFormatStats;
  meta: Record<string, string>;
}

/**
 * 解析导入文本：`{title, raw_content, format_stats, meta}`。
 * - title：首个 H1 或首行非空文本（≤ 60 字），从原始文本提取。
 * - raw_content：**保原样**，仅当文本以导出元数据注释开头时剥离（注释 + 生成器 H1），
 *   保证 MD-14 逐字符一致；用户手写 md（无注释）不剥离，保留其 H1 作为正文一部分。
 */
export function parseMarkdownText(text: string): ParsedMarkdown {
  if (!text) return { title: 'untitled', raw_content: '', format_stats: countFormatStats(''), meta: {} };

  const title = extractTitle(text);
  const raw = stripExportHeader(text);
  return { title, raw_content: raw, format_stats: countFormatStats(raw), meta: {} };
}

/** 提取标题：首个 H1，否则首个非空非注释行；截断 60 字；空回退 untitled。 */
function extractTitle(text: string): string {
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^#\s+(.+)$/);
    if (m) return m[1]!.trim().slice(0, TITLE_MAX);
  }
  for (const line of text.split('\n')) {
    const stripped = line.trim();
    if (stripped && !stripped.startsWith('<!--')) return stripped.slice(0, TITLE_MAX);
  }
  return 'untitled';
}

/**
 * 剥离导出头部块（元数据注释 + 生成器 H1）。
 * 仅当文本以导出注释开头时生效——标识为「本系统导出」，其后的首个 H1 是生成器标题。
 */
function stripExportHeader(text: string): string {
  if (!text.trimStart().startsWith(META_PREFIX)) return text;
  const idx = text.indexOf('-->');
  if (idx === -1) return text;
  let rest = text.slice(idx + 3);
  rest = rest.replace(/^\n+/, '');
  // 剥离注释后的首个 H1（生成器标题）
  const m = rest.match(/^#{1,6}\s+.+$/m);
  if (m && m.index === 0) {
    rest = rest.slice(m[0].length);
    rest = rest.replace(/^\n+/, '');
  }
  return rest;
}

// ═══════════════════════════════════════════════════════════════════
// 冲突检测
// ═══════════════════════════════════════════════════════════════════

export interface ConflictResult {
  is_dup: boolean;
  reason: string;
  existing_id?: string;
}

/**
 * 冲突检测：identical（标题 + 内容哈希均同）/ name_collision（标题同）/ 无冲突。
 * 调用方传入目标类型下已有的条目列表（含 content_hash）。
 */
export function detectConflict(
  title: string,
  rawContent: string,
  entries: Array<{ id: string; title: string; content_hash?: string; raw_content?: string }>
): ConflictResult {
  const hash = hashOf(rawContent);
  for (const e of entries) {
    if (e.title === title) {
      const eHash = e.content_hash ?? (e.raw_content ? hashOf(e.raw_content) : '');
      if (eHash && eHash === hash) {
        return { is_dup: true, reason: CONFLICT_IDENTICAL, existing_id: e.id };
      }
      return { is_dup: true, reason: CONFLICT_NAME, existing_id: e.id };
    }
  }
  return { is_dup: false, reason: '' };
}

function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ═══════════════════════════════════════════════════════════════════
// 导入预览条目
// ═══════════════════════════════════════════════════════════════════

export interface PreviewItemInput {
  file_name: string;
  content: string;
}

function isMarkdownFileName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  return (MARKDOWN_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * 生成导入预览条目（不落库）。校验扩展名 + 空内容 + 冲突标记。
 * 无效返回 reason 字段（bad_extension / empty_content）。
 */
export function buildPreviewItem(
  file: PreviewItemInput,
  entries: Array<{ id: string; title: string; content_hash?: string; raw_content?: string }>,
  targetType: KnowledgeType
): ImportPreviewItem & { valid: boolean; reason?: string } {
  if (!isMarkdownFileName(file.file_name)) {
    return {
      file_name: file.file_name,
      title: '',
      type: targetType,
      content: file.content,
      conflict: CONFLICT_NEW,
      valid: false,
      reason: 'bad_extension'
    };
  }
  const parsed = parseMarkdownText(file.content);
  if (!parsed.raw_content.trim()) {
    return {
      file_name: file.file_name,
      title: parsed.title,
      type: targetType,
      content: file.content,
      conflict: CONFLICT_NEW,
      valid: false,
      reason: 'empty_content'
    };
  }
  const conflict = detectConflict(parsed.title, parsed.raw_content, entries);
  return {
    file_name: file.file_name,
    title: parsed.title,
    type: targetType,
    content: parsed.raw_content,
    conflict: conflict.is_dup
      ? (conflict.reason as ImportPreviewItem['conflict'])
      : CONFLICT_NEW,
    valid: true
  };
}

// ═══════════════════════════════════════════════════════════════════
// 导入执行（overwrite / rename / skip）
// ═══════════════════════════════════════════════════════════════════

export interface ImportFileItem {
  file_name: string;
  title: string;
  content: string;
}

export interface ImportStats {
  total: number;
  success: number;
  failed: number;
  failed_items: Array<{ file_name: string; reason: string }>;
  created: number;
  updated: number;
}

/** 按冲突策略执行导入，返回统计。items 已由前端/预览层完成解析与冲突标记。 */
export async function importFiles(
  items: ImportFileItem[],
  strategy: 'overwrite' | 'rename' | 'skip',
  options: {
    targetType: KnowledgeType;
    existing: Array<{ id: string; title: string; content_hash?: string; raw_content?: string }>;
    upsert: (item: ImportFileItem, mode: 'create' | 'update', targetId?: string) => Promise<void>;
  }
): Promise<ImportStats> {
  let success = 0;
  let failed = 0;
  let created = 0;
  let updated = 0;
  const failedItems: Array<{ file_name: string; reason: string }> = [];

  for (const item of items) {
    if (!isMarkdownFileName(item.file_name)) {
      failed += 1;
      failedItems.push({ file_name: item.file_name, reason: 'bad_extension' });
      continue;
    }
    if (!item.content.trim()) {
      failed += 1;
      failedItems.push({ file_name: item.file_name, reason: 'empty_content' });
      continue;
    }
    const conflict = detectConflict(item.title, item.content, options.existing);
    if (conflict.is_dup) {
      if (conflict.reason === CONFLICT_IDENTICAL) {
        // identical：内容完全相同，无操作（视为 skip 成功）
        success += 1;
        continue;
      }
      if (strategy === 'skip') {
        continue; // 跳过，不计成功
      }
      if (strategy === 'overwrite') {
        const targetId = conflict.existing_id;
        if (!targetId) {
          failed += 1;
          failedItems.push({ file_name: item.file_name, reason: 'missing_target' });
          continue;
        }
        await options.upsert(item, 'update', targetId);
        success += 1;
        updated += 1;
        continue;
      }
      // rename：改名后新建（加 _imported 后缀，避免再冲突）
      const renamed = { ...item, title: `${item.title}_imported` };
      await options.upsert(renamed, 'create');
      success += 1;
      created += 1;
      continue;
    }
    // 无冲突：新建
    await options.upsert(item, 'create');
    success += 1;
    created += 1;
  }

  return { total: items.length, success, failed, failed_items: failedItems, created, updated };
}

// ═══════════════════════════════════════════════════════════════════
// ZIP 生成（jszip，文件名冲突去重）
// ═══════════════════════════════════════════════════════════════════

/** 生成 ZIP 字节。file 文件名冲突时追加序号去重（a.md → a_1.md）。 */
export async function buildZip(
  files: Array<{ file_name: string; content: string }>,
  zipName = 'knowledge-export.zip'
): Promise<Buffer> {
  const zip = new JSZip();
  const used = new Set<string>();
  for (const f of files) {
    let name = f.file_name;
    let counter = 1;
    while (used.has(name)) {
      const dot = f.file_name.lastIndexOf('.');
      const base = dot > 0 ? f.file_name.slice(0, dot) : f.file_name;
      const ext = dot > 0 ? f.file_name.slice(dot) : '';
      name = `${base}_${counter}${ext}`;
      counter += 1;
    }
    used.add(name);
    zip.file(name, f.content);
  }
  const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return Buffer.from(data);
}

// ═══════════════════════════════════════════════════════════════════
// Service 门面（供 controller 注入）
// ═══════════════════════════════════════════════════════════════════

@Injectable()
export class KnowledgeMarkdownService {
  /** 单文件格式校验（对齐旧 F5 validate 端点）。 */
  validate(fileName: string, content: string): ValidateKnowledgeMarkdownResponse {
    if (!isMarkdownFileName(fileName)) {
      return { valid: false, reason: 'bad_extension' };
    }
    const parsed = parseMarkdownText(content);
    if (!parsed.raw_content.trim()) {
      return { valid: false, reason: 'empty_content' };
    }
    return { valid: true };
  }

  /** 导入预览：批量解析 + 冲突标记。 */
  preview(
    files: Array<{ file_name: string; content: string }>,
    targetType: KnowledgeType,
    entries: Array<{ id: string; title: string; content_hash?: string; raw_content?: string }>
  ): ImportPreviewItem[] {
    return files.map((f) => buildPreviewItem(f, entries, targetType));
  }

  /** 执行导入（异步解析策略，落库由 controller 注入的 upsert 回调完成，全部 await 后才返回）。 */
  async execute(
    request: ImportKnowledgeRequest,
    entries: Array<{ id: string; title: string; content_hash?: string; raw_content?: string }>,
    upsert: (item: ImportFileItem, mode: 'create' | 'update', targetId?: string) => Promise<void>
  ): Promise<ImportKnowledgeResult> {
    const stats = await importFiles(
      request.items.map((i) => ({ file_name: i.file_name, title: i.title, content: i.content })),
      request.conflict_strategy,
      { targetType: request.target_type, existing: entries, upsert }
    );
    return {
      total: stats.total,
      success: stats.success,
      failed: stats.failed,
      failed_items: stats.failed_items,
      created: stats.created,
      updated: stats.updated
    };
  }

  /** 导出单条/批量渲染（纯函数，供 controller 组装）。 */
  renderExport(entries: ExportEntry[], withMeta = true): Array<{ file_name: string; content: string }> {
    return entries.map((e) => ({
      file_name: buildFilename(e.title),
      content: buildExportMarkdown(e, withMeta)
    }));
  }
}

// 供外部引用类型（不参与运行时）
export type { KnowledgeEntry };
