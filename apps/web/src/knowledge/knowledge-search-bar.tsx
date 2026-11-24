import { useEffect, useRef, useState } from 'react';
import { Button } from '@storyforge/ui';

interface Props {
  /** 初始关键词（库切换保留搜索词时由上层传入） */
  initialValue?: string;
  /** 防抖延迟（ms），默认 300 */
  debounceMs?: number;
  onSearch: (keyword: string) => void;
  disabled?: boolean;
}

/**
 * 检索栏（M3c-3 T30）：关键词输入 + 清空 + 300ms 防抖触发检索。
 * 满足 F2 §6.2：防抖触发、支持清空；输入框带 label 保证键盘可达。
 */
export function KnowledgeSearchBar({ initialValue = '', debounceMs = 300, onSearch, disabled }: Props) {
  const [value, setValue] = useState(initialValue);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 上层重置（如库切换）时同步输入值
  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleChange = (next: string) => {
    setValue(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onSearch(next), debounceMs);
  };

  const handleClear = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setValue('');
    onSearch('');
  };

  return (
    <div className="knowledge-search-bar">
      <label className="visually-hidden" htmlFor="knowledge-search-input">搜索素材</label>
      <input
        id="knowledge-search-input"
        type="search"
        placeholder="搜索标题、标签、内容…"
        value={value}
        disabled={disabled}
        onChange={(e) => handleChange(e.target.value)}
      />
      {value && (
        <Button variant="ghost" size="sm" className="knowledge-search-clear" onClick={handleClear} disabled={disabled}>
          清空
        </Button>
      )}
    </div>
  );
}
