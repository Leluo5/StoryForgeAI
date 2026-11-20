import { useState } from 'react';
import type { ChapterRoleMarkNotice, RoleMark } from './role-marks';

interface Props {
  source: string;
  readOnly: boolean;
  error: string;
  onChange(source: string): void;
  roleMarks?: RoleMark[] | undefined;
  chapterMarks?: ChapterRoleMarkNotice[] | undefined;
  onDismissMark?: ((mark: RoleMark) => void) | undefined;
}

// Markdown 模式是纯 textarea，无法逐段装饰；用「本章命中段落」列表作为等价路径。
export function MarkdownEditor({ source, readOnly, error, onChange, roleMarks, chapterMarks, onDismissMark }: Props) {
  const [dismissedPids, setDismissedPids] = useState<string[]>([]);
  const [dismissedNotices, setDismissedNotices] = useState<string[]>([]);

  const visibleMarks = (roleMarks ?? []).filter((mark) => !dismissedPids.includes(mark.pid));
  const notices = (chapterMarks ?? [])
    .map((notice, index) => ({ key: `${index}:${notice.label}`, label: notice.label }))
    .filter((notice) => !dismissedNotices.includes(notice.key));

  function dismiss(mark: RoleMark) {
    setDismissedPids((dismissed) => (dismissed.includes(mark.pid) ? dismissed : [...dismissed, mark.pid]));
    onDismissMark?.({ pid: mark.pid, label: mark.label });
  }

  return <div>
    {notices.length > 0 ? (
      <div role="status" className="role-mark-notice" aria-label="归档角色提示">
        {notices.map((notice) => (
          <p key={notice.key} className="role-mark-notice-item">
            <span>{notice.label}</span>
            <button
              type="button"
              aria-label={`关闭提示：${notice.label}`}
              onClick={() => setDismissedNotices((dismissed) => [...dismissed, notice.key])}
            >
              关闭
            </button>
          </p>
        ))}
      </div>
    ) : null}
    {roleMarks && roleMarks.length > 0 ? (
      <section aria-label="本章命中段落" className="role-mark-list">
        <h3>本章命中段落</h3>
        <ul>
          {visibleMarks.map((mark, index) => (
            <li key={`${index}:${mark.pid}`}>
              <span>{mark.label}</span>
              <button type="button" disabled={!onDismissMark} onClick={() => dismiss(mark)}>剔除</button>
            </li>
          ))}
        </ul>
      </section>
    ) : null}
    <label htmlFor="markdown-source">Markdown 正文</label>
    <textarea id="markdown-source" rows={24} readOnly={readOnly} value={source}
      onChange={(event) => onChange(event.target.value)} aria-describedby={error ? 'markdown-error' : undefined} />
    {error && <p id="markdown-error" role="alert">{error}</p>}
  </div>;
}
