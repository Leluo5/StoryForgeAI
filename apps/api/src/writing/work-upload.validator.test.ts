// M4-T7 作品文件上传校验单测
// 覆盖：扩展名白名单（合法/非法）、大小上限 413、文件名清洗防路径穿越。
import { describe, it, expect } from 'vitest';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import {
  WORK_UPLOAD_MAX_BYTES,
  validateWorkUploadFile,
  cleanWorkUploadFileName,
  isWorkUploadExtensionAllowed,
  normalizeWorkUploadExtension
} from './work-upload.validator';

describe('work-upload.validator', () => {
  it('normalizeWorkUploadExtension 小写化并处理无扩展名', () => {
    expect(normalizeWorkUploadExtension('A.B.PNG')).toBe('.png');
    expect(normalizeWorkUploadExtension('noext')).toBe('');
    expect(normalizeWorkUploadExtension('a.tar.gz')).toBe('.gz');
  });

  it('isWorkUploadExtensionAllowed 覆盖 17 类白名单，拒绝 .exe/.sh', () => {
    for (const ext of ['.md', '.txt', '.json', '.csv', '.xml', '.yaml', '.yml', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']) {
      expect(isWorkUploadExtensionAllowed(ext), ext).toBe(true);
    }
    for (const ext of ['.exe', '.sh', '.bat', '.html', '.docm']) {
      expect(isWorkUploadExtensionAllowed(ext), ext).toBe(false);
    }
  });

  it('合法文件返回清洗后的文件名与扩展名', () => {
    const res = validateWorkUploadFile({ originalname: './notes.md', buffer: Buffer.from('x') });
    expect(res.safeName).toBe('notes.md');
    expect(res.ext).toBe('.md');
  });

  it('不支持的类型 → 400 带 WORK_UPLOAD_TYPE_UNSUPPORTED', () => {
    expect(() => validateWorkUploadFile({ originalname: 'a.exe', buffer: Buffer.from('x') }))
      .toThrow(BadRequestException);
    try {
      validateWorkUploadFile({ originalname: 'a.exe', buffer: Buffer.from('x') });
    } catch (e) {
      expect((e as BadRequestException).message).toContain('不支持的文件类型');
    }
  });

  it('无扩展名 → 400', () => {
    expect(() => validateWorkUploadFile({ originalname: 'noext', buffer: Buffer.from('x') }))
      .toThrow(BadRequestException);
  });

  it('空文件名 → 400', () => {
    expect(() => validateWorkUploadFile({ originalname: '', buffer: Buffer.from('x') }))
      .toThrow(BadRequestException);
  });

  it('超过 5MB → 413 WORK_UPLOAD_FILE_TOO_LARGE', () => {
    expect(() => validateWorkUploadFile({ originalname: 'big.txt', buffer: Buffer.alloc(WORK_UPLOAD_MAX_BYTES + 1) }))
      .toThrow(PayloadTooLargeException);
  });

  it('恰好 5MB 通过', () => {
    expect(() => validateWorkUploadFile({ originalname: 'exact.txt', buffer: Buffer.alloc(WORK_UPLOAD_MAX_BYTES) })).not.toThrow();
  });

  it('cleanWorkUploadFileName 防路径穿越', () => {
    expect(cleanWorkUploadFileName('a\\b\\c.md')).toBe('c.md');
    expect(cleanWorkUploadFileName('../evil.md')).toBe('evil.md');
    expect(() => cleanWorkUploadFileName('')).toThrow(BadRequestException);
    expect(() => cleanWorkUploadFileName('./')).toThrow(BadRequestException);
  });
});