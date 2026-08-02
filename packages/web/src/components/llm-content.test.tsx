import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LlmContent } from '@/components/LlmContent';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LlmContent auto-detection', () => {
  it('renders markdown tables inside a ```markdown fence as real tables', () => {
    const { container } = render(
      <LlmContent
        content={'```markdown\n| 类型 | 特点 |\n|------|------|\n| 调强放疗（IMRT） | 射线强度可调节 |\n```'}
      />,
    );
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('td')?.textContent).toContain('调强放疗');
  });

  it('pretty-prints a pure JSON reply in a json code block', () => {
    const { container } = render(
      <LlmContent content={'{"name":"WBC","value":"11.2","abnormal":true}'} />,
    );
    const code = container.querySelector('pre code');
    expect(code).not.toBeNull();
    expect(code!.textContent).toContain('"name": "WBC"');
    expect(code!.textContent).toContain('"abnormal": true');
    // Indented pretty print
    expect(code!.textContent).toContain('\n  ');
  });

  it('pretty-prints a JSON array reply', () => {
    const { container } = render(
      <LlmContent content={'[{"category":"fact","content":"A"}]'} />,
    );
    expect(container.querySelector('pre code')?.textContent).toContain('"category": "fact"');
  });

  it('renders a ```json fence as a formatted json block', () => {
    const { container } = render(
      <LlmContent content={'```json\n{"items":[{"a":1}]}\n```'} />,
    );
    const code = container.querySelector('pre code');
    expect(code!.textContent).toContain('"items"');
  });

  it('treats invalid JSON-looking text as markdown (no crash)', () => {
    const { container } = render(<LlmContent content={'{"unclosed": really'} />);
    // Rendered as markdown text, not a JSON block
    expect(container.querySelector('pre code')).toBeNull();
    expect(container.textContent).toContain('unclosed');
  });

  it('renders plain markdown (headings + lists)', () => {
    render(<LlmContent content={'# 标题\n\n- 条目一\n- 条目二'} />);
    expect(screen.getByRole('heading', { level: 1, name: '标题' })).toBeInTheDocument();
    expect(screen.getByText('条目一')).toBeInTheDocument();
  });

  it('renders empty content as nothing', () => {
    const { container } = render(<LlmContent content="" />);
    expect(container.textContent).toBe('');
  });
});
