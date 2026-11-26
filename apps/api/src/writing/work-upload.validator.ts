// M4-T7 作品文件上传校验（纯函数，无 DB）
// 依据：01-迁移切换任务规划.md §2.7；旧实现 app.py:1119-1141
// 边界（L2 服务层）：文件类型 / 大小校验 + 文件名清洗防路径穿越。
// 迁移语义：扩展名白名单与旧实现一致（17 类）；超限返回 413（对齐完成标准「错误 400/413」）。
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

/** 单文件上限（旧实现：5MB） */
export const WORK_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** 支持格式白名单（旧实现 allowed_exts） */
export const WORK_UPLOAD_ALLOWED_EXTENSIONS = [
  '.md', '.txt', '.json', '.csv', '.xml', '.yaml', '.yml',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'
] as const;

/** 归一化文件扩展名（小写，含点；无扩展名返回空串） */
export function normalizeWorkUploadExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx < 0 ? '' : fileName.slice(idx).toLowerCase();
}

export function isWorkUploadExtensionAllowed(ext: string): boolean {
  return (WORK_UPLOAD_ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}

/** 文件名清洗：按 / 与 \ 切分取最后一段，防路径穿越；空名抛 400。 */
export function cleanWorkUploadFileName(raw: string): string {
  const parts = (raw ?? '').split(/[\\/]+/);
  const name = (parts[parts.length - 1] ?? '').trim();
  if (!name || name === '.' || name === '..') {
    throw new BadRequestException({
      code: 'WORK_UPLOAD_FILE_NAME_INVALID',
      message: '文件名为空或非法'
    });
  }
  return name;
}

export interface WorkUploadFile {
  originalname: string;
  buffer: Buffer;
  mimetype?: string;
}

/** 类型 / 大小校验：文件名非法 → 400；扩展名非法 → 400；超限 → 413。 */
export function validateWorkUploadFile(file: WorkUploadFile): { safeName: string; ext: string } {
  const originalName = file?.originalname ?? '';
  const ext = normalizeWorkUploadExtension(originalName);
  if (!isWorkUploadExtensionAllowed(ext)) {
    throw new BadRequestException({
      code: 'WORK_UPLOAD_TYPE_UNSUPPORTED',
      message: `不支持的文件类型：${ext || '无扩展名'}，仅允许：${WORK_UPLOAD_ALLOWED_EXTENSIONS.join(', ')}`
    });
  }
  if (file?.buffer && file.buffer.length > WORK_UPLOAD_MAX_BYTES) {
    throw new PayloadTooLargeException({
      code: 'WORK_UPLOAD_FILE_TOO_LARGE',
      message: `文件大小超过限制（最大 ${WORK_UPLOAD_MAX_BYTES / 1024 / 1024}MB）`
    });
  }
  return { safeName: cleanWorkUploadFileName(originalName), ext };
}