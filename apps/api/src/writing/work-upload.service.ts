// M4-T7 作品文件上传（L2 服务层）
// 依据：docs/04-功能交付档案/M4-迁移切换/01-迁移切换任务规划.md §2.7；09-迁移切换技术方案.md §4.1
// 职责：作品归属校验 → 逐文件类型/大小校验（work-upload.validator）→ 同名冲突规避 → 落盘。
// 落盘口径：uploads/works/<workId>/<safeName>（目录结构对齐 character-avatar 的相对存储路径风格）。
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkEntity } from '../database/work.entity';
import { validateWorkUploadFile, type WorkUploadFile } from './work-upload.validator';

export interface WorkUploadedFile {
  /** 落盘后的文件名（同名冲突已追加序号） */
  name: string;
  /** 相对 uploads 根目录的路径，供前端下载引用 */
  path: string;
  size: number;
  ext: string;
}

export interface WorkUploadResult {
  work_id: string;
  count: number;
  files: WorkUploadedFile[];
}

@Injectable()
export class WorkUploadService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    /** 上传根目录（默认由调用方注入，测试可指向临时目录） */
    private readonly uploadsDir: string
  ) {}

  /** 上传 1~10 个文件到指定作品目录；空列表 → 400。 */
  async uploadFiles(
    authorId: string,
    workId: string,
    files: WorkUploadFile[]
  ): Promise<WorkUploadResult> {
    if (!files || files.length === 0) {
      throw new BadRequestException({
        code: 'WORK_UPLOAD_EMPTY',
        message: '请至少上传一个文件'
      });
    }

    const work = await this.dataSource.getRepository(WorkEntity).findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('作品不存在');

    const workDir = join(this.uploadsDir, 'works', workId);
    mkdirSync(workDir, { recursive: true });

    const uploaded: WorkUploadedFile[] = files.map((file) => {
      const { safeName, ext } = validateWorkUploadFile(file);
      const finalName = this.allocateName(workDir, safeName, ext);
      // 先写临时文件再 rename，避免中断留下半截文件
      const tempPath = join(workDir, `.${randomTempName()}`);
      const finalPath = join(workDir, finalName);
      writeTempThenMove(tempPath, finalPath, file.buffer);
      return { name: finalName, path: `works/${workId}/${finalName}`, size: file.buffer.length, ext };
    });

    return { work_id: workId, count: uploaded.length, files: uploaded };
  }

  /** 同名文件追加序号：设定.txt → 设定-1.txt → 设定-2.txt */
  private allocateName(workDir: string, safeName: string, ext: string): string {
    if (!existsSync(join(workDir, safeName))) return safeName;
    const base = safeName.slice(0, safeName.length - (ext ? ext.length : 0));
    let index = 1;
    while (existsSync(join(workDir, `${base}-${index}${ext}`))) index += 1;
    return `${base}-${index}${ext}`;
  }
}

function randomTempName(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeTempThenMove(tempPath: string, finalPath: string, buffer: Buffer): void {
  // 同步写入：单文件上限 5MB，内存存储 + 同步 IO 语义简单且避免竞态窗口
  writeFileSync(tempPath, buffer);
  renameSync(tempPath, finalPath);
}
