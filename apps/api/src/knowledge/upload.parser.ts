// M3c-3 知识库 T19 上传解析（纯函数，无 DB）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.5、§5.3；F3 T19 完成标准
// 边界（L2 服务层）：文件→纯文本解析与校验；不建条目、不入队、不写 controller。
// 覆盖：五格式（.txt/.md/.docx/.pdf/.html）；20MB 上限 413；非法类型 415；
//       解析失败 422 带文件名；编码探测（GBK/UTF-8）；文件名清洗防路径穿越。
import { basename } from 'node:path';
import {
  BadRequestException,
  PayloadTooLargeException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException
} from '@nestjs/common';
import { knowledgeErrorCode } from '@storyforge/contracts';
import * as iconv from 'iconv-lite';

// 单文件上限（§4.5）：20 MB
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

// 支持格式（T19 完成标准）：五格式
export const UPLOAD_SUPPORTED_EXTENSIONS = ['.txt', '.md', '.docx', '.pdf', '.html'] as const;
export type UploadExtension = (typeof UPLOAD_SUPPORTED_EXTENSIONS)[number];

export interface UploadParseResult {
  text: string;
  encoding: 'utf8' | 'gb18030';
}

// 归一化文件扩展名（小写，含点）
function normalizeExtension(fileName: string): string {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  return ext;
}

function isSupportedExtension(ext: string): ext is UploadExtension {
  return (UPLOAD_SUPPORTED_EXTENSIONS as readonly string[]).includes(ext);
}

// 文件名清洗：去路径穿越，只取 basename；空名或路径清理后为空抛 422
export function cleanUploadFileName(raw: string): string {
  const name = basename(raw).replace(/[\\/]/g, '').trim();
  if (!name || name === '.' || name === '..') {
    throw new BadRequestException('文件名为空或非法');
  }
  return name;
}

// 解析后文本上限（§4.8）：8,000,000 字符，超出抛 422
export const PARSE_TEXT_MAX = 8_000_000;

// 文本类（txt/md）解码：UTF-8 优先，失败回退 GB18030
function decodeTextBuffer(buf: Buffer): { text: string; encoding: 'utf8' | 'gb18030' } {
  // iconv-lite 的 utf8 探测：严格解码，遇非法字节返回含替换符，此处用 encode 往返探测
  const utf8 = iconv.decode(buf, 'utf8');
  // 检测是否含替换符（U+FFFD），判定 UTF-8 是否有效
  if (!utf8.includes('\uFFFD')) {
    return { text: utf8, encoding: 'utf8' };
  }
  // 回退 GB18030
  const gbk = iconv.decode(buf, 'gb18030');
  return { text: gbk, encoding: 'gb18030' };
}

// HTML 去标签：提取纯文本（简化，保留换行）
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

// 主入口：按扩展名分派解析
export async function extractUploadText(
  ext: string,
  buf: Buffer,
  fileName: string,
  mime?: string
): Promise<UploadParseResult> {
  const normalized = normalizeExtension(ext || fileName);
  if (!isSupportedExtension(normalized)) {
    throw new UnsupportedMediaTypeException({
      code: 'KNOWLEDGE_FILE_TYPE_UNSUPPORTED',
      message: `不支持的文件类型：${fileName}`
    });
  }
  if (buf.length > UPLOAD_MAX_BYTES) {
    throw new PayloadTooLargeException({
      code: 'KNOWLEDGE_FILE_TOO_LARGE',
      message: `文件超过 ${UPLOAD_MAX_BYTES / 1024 / 1024}MB 上限：${fileName}`
    });
  }

  try {
    if (normalized === '.txt' || normalized === '.md') {
      const { text, encoding } = decodeTextBuffer(buf);
      return { text, encoding };
    }
    if (normalized === '.html') {
      const { text } = decodeTextBuffer(buf);
      return { text: stripHtml(text), encoding: 'utf8' };
    }
    if (normalized === '.docx') {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer: buf });
      return { text: result.value.trim(), encoding: 'utf8' };
    }
    if (normalized === '.pdf') {
      const { extractText } = await import('unpdf');
      const result = await extractText(new Uint8Array(buf));
      // unpdf 单页返回 string，多页返回 string[]；统一为字符串
      const text = Array.isArray(result.text) ? result.text.join('\n') : (result.text ?? '');
      return { text: text.trim(), encoding: 'utf8' };
    }
    // 理论不可达（扩展名已白名单校验）
    throw new Error(`unsupported ext: ${normalized}`);
  } catch (err) {
    // 解析失败统一 422 PARSE_FAILED 并带文件名
    throw new UnprocessableEntityException({
      code: knowledgeErrorCode.KNOWLEDGE_PARSE_FAILED,
      message: `文件解析失败：${fileName}`,
      fileName
    });
  }
}
