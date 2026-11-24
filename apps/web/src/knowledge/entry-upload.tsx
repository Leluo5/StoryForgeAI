// ============================================================================
// M3c-3 知识库 · 文件上传（T32）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.5、§5.3
//
// 职责：文件选择 / 拖拽上传，客户端预校验（五格式白名单 + 单文件 ≤20MB
//       + 单次 ≤10 个）。通过 knowledgeClient.uploadFiles 走 multipart 上传，
//       每个文件建一个 ingest 作业；格式/大小非法文件逐条拒绝，其余继续。
//       上传是异步作业（状态经 SSE 订阅刷新），本组件只发起并展示受理结果。
// ============================================================================

import { useRef, useState } from 'react';
import { Button } from '@storyforge/ui';
import type { KnowledgeScope, KnowledgeEntryType } from '@storyforge/contracts';
import { knowledgeClient, type KnowledgeUploadInput } from './knowledge-client';
import { knowledgeErrorMessage } from './knowledge-state';
import { TypeSelector, type KnowledgeTypeValue } from './type-selector';

/** 客户端预校验常量（对齐后端 upload.parser.ts 与 §4.5） */
export const UPLOAD_SUPPORTED_EXTENSIONS = ['.txt', '.md', '.docx', '.pdf', '.html'] as const;
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const UPLOAD_MAX_FILES = 10;

/** 文件扩展名（小写），无扩展名返回 '' */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

export interface UploadRejected {
  fileName: string;
  reason: string;
}

export interface UploadAccepted {
  fileName: string;
  jobId: string;
}

export interface UploadResult {
  accepted: UploadAccepted[];
  rejected: UploadRejected[];
}

/** 客户端预校验：返回被拒文件与通过文件，不调用网络。 */
export function validateUploadFiles(files: File[]): UploadResult {
  const accepted: UploadAccepted[] = [];
  const rejected: UploadRejected[] = [];
  for (const file of files.slice(0, UPLOAD_MAX_FILES)) {
    const ext = fileExtension(file.name);
    if (!(UPLOAD_SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
      rejected.push({ fileName: file.name, reason: `不支持的文件类型（${ext || '无扩展名'}）` });
      continue;
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      rejected.push({ fileName: file.name, reason: `文件超过 ${UPLOAD_MAX_BYTES / 1024 / 1024}MB 上限` });
      continue;
    }
    accepted.push({ fileName: file.name, jobId: '' });
  }
  return { accepted, rejected };
}

interface Props {
  scope: KnowledgeScope;
  workId?: string;
  entryType?: KnowledgeEntryType;
  /** 上传完成（作业已受理）后回调，携带受理结果 */
  onResult?: (result: UploadResult) => void;
  /** 网络/校验失败回调 */
  onError?: (message: string) => void;
}

/** 文件上传组件（M3c-3 T32）。 */
export function EntryUpload({ scope, workId, entryType, onResult, onError }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [typeValue, setTypeValue] = useState<KnowledgeTypeValue>(entryType ?? 'auto');
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<UploadResult | null>(null);

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setSubmitting(true);
    setError(null);
    setLastResult(null);
    const local = validateUploadFiles(files);
    const acceptedFiles = files.filter((file) =>
      local.accepted.some((a) => a.fileName === file.name)
    );
    const accepted: UploadAccepted[] = [];
    const rejected = [...local.rejected];

    if (acceptedFiles.length > 0) {
      const input: KnowledgeUploadInput = {
        files: acceptedFiles,
        scope,
        ...(workId ? { work_id: workId } : {}),
        ...(typeValue !== 'auto' ? { entry_type: typeValue } : {})
      };
      try {
        const response = await knowledgeClient.uploadFiles(input);
        for (const item of response.jobs) {
          accepted.push({ fileName: item.file_name, jobId: item.job_id });
        }
        for (const item of response.rejected) {
          rejected.push({ fileName: item.file_name, reason: item.message });
        }
      } catch (cause) {
        const message = knowledgeErrorMessage(cause);
        setError(message);
        onError?.(message);
      }
    }

    const result: UploadResult = { accepted, rejected };
    setLastResult(result);
    onResult?.(result);
    setSubmitting(false);
  };

  const openPicker = () => inputRef.current?.click();

  return (
    <div className="entry-upload">
      <div
        className={['entry-upload__dropzone', dragging ? 'is-dragging' : ''].filter(Boolean).join(' ')}
        role="button"
        tabIndex={0}
        aria-label="选择或拖拽文件上传"
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPicker();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handleFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <p className="entry-upload__hint">拖拽文件到此处，或点击选择</p>
        <p className="entry-upload__meta">支持 .txt / .md / .docx / .pdf / .html，单文件 ≤20MB，单次 ≤10 个</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={UPLOAD_SUPPORTED_EXTENSIONS.join(',')}
          aria-hidden="true"
          tabIndex={-1}
          style={{ display: 'none' }}
          onChange={(e) => {
            void handleFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>

      <TypeSelector value={typeValue} onChange={setTypeValue} disabled={submitting} />

      {error && (
        <p className="entry-upload__error" role="alert">{error}</p>
      )}

      {lastResult && (lastResult.accepted.length > 0 || lastResult.rejected.length > 0) && (
        <div className="entry-upload__result" aria-live="polite">
          {lastResult.accepted.length > 0 && (
            <p>已受理 {lastResult.accepted.length} 个文件，解析将在后台进行。</p>
          )}
          {lastResult.rejected.length > 0 && (
            <ul className="entry-upload__rejected">
              {lastResult.rejected.map((item, i) => (
                <li key={`${item.fileName}-${i}`} role="alert">{item.fileName}：{item.reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="entry-upload__actions">
        <Button type="button" variant="secondary" onClick={openPicker} disabled={submitting}>
          {submitting ? '上传中…' : '选择文件上传'}
        </Button>
      </div>
    </div>
  );
}
