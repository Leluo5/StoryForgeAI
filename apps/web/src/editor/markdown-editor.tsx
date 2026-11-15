interface Props {
  source: string;
  readOnly: boolean;
  error: string;
  onChange(source: string): void;
}
export function MarkdownEditor({ source, readOnly, error, onChange }: Props) {
  return <div>
    <label htmlFor="markdown-source">Markdown 正文</label>
    <textarea id="markdown-source" rows={24} readOnly={readOnly} value={source}
      onChange={(event) => onChange(event.target.value)} aria-describedby={error ? 'markdown-error' : undefined} />
    {error && <p id="markdown-error" role="alert">{error}</p>}
  </div>;
}
