import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('design tokens', () => {
  it('defines both themes and required brand values', () => {
    const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
    expect(css).toContain('--brand-500: #4F46E5');
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain('--brand-500: #6366F1');
    expect(css).toContain('color-scheme: dark');
    expect(css).toContain('--sp-4: 16px');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
