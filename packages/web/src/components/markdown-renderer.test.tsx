import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { normalizeLlmText } from '@/lib/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('normalizeLlmText', () => {
  it('unescapes literal \\n and \\t sequences', () => {
    const out = normalizeLlmText('1. 发热\\n2. 咳嗽\\n3. 胸痛');
    expect(out).toContain('1. 发热\n2. 咳嗽\n3. 胸痛');
    expect(out).not.toContain('\\n');
  });

  it('collapses excessive blank lines', () => {
    expect(normalizeLlmText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('inserts a blank line before list markers missing one', () => {
    const out = normalizeLlmText('初步诊断如下：\n- 肺炎\n- 胸膜炎');
    expect(out).toContain('初步诊断如下：\n\n- 肺炎');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeLlmText('  \n内容\n  ')).toBe('内容');
  });

  it('handles empty input', () => {
    expect(normalizeLlmText('')).toBe('');
    expect(normalizeLlmText(undefined as unknown as string)).toBe('');
  });
});

describe('MarkdownRenderer', () => {
  it('renders headings, bold, lists and inline code', () => {
    render(
      <MarkdownRenderer
        content={'# 标题\n\n**加粗** 和 `code`\n\n- 条目一\n- 条目二'}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: '标题' })).toBeInTheDocument();
    expect(screen.getByText('加粗')).toBeInTheDocument();
    expect(screen.getAllByText('code').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('条目一')).toBeInTheDocument();
    expect(screen.getByText('条目二')).toBeInTheDocument();
  });

  it('renders a fenced code block with a copy button', () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(
      <MarkdownRenderer
        content={'```python\ndef f():\n    return 1\n```'}
      />,
    );
    expect(screen.getByText('python')).toBeInTheDocument();
    expect(screen.getByText(/def f\(\):/)).toBeInTheDocument();
    const copyBtn = screen.getByRole('button', { name: /copy python/i });
    expect(copyBtn).toBeInTheDocument();
  });

  it('renders GFM tables', () => {
    render(
      <MarkdownRenderer
        content={'| 指标 | 值 |\n| --- | --- |\n| WBC | 11.2 |'}
      />,
    );
    expect(screen.getByText('WBC')).toBeInTheDocument();
    expect(screen.getByText('11.2')).toBeInTheDocument();
  });

  it('breaks single newlines (LLM lists without blank lines stay readable)', () => {
    const { container } = render(<MarkdownRenderer content={'第一行\n第二行\n第三行'} />);
    // With remark-breaks each line becomes a <br>-separated line within one <p>
    const para = container.querySelector('p');
    expect(para).not.toBeNull();
    expect(para!.textContent!.replace(/\n/g, '')).toBe('第一行第二行第三行');
    expect(para!.querySelectorAll('br').length).toBeGreaterThanOrEqual(2);
  });

  it('renders empty content as nothing', () => {
    const { container } = render(<MarkdownRenderer content="" />);
    expect(container.textContent).toBe('');
  });
});

describe('normalizeLlmText — single-line block recovery', () => {
  it('recovers headings, bullets and hr glued onto one line', () => {
    const out = normalizeLlmText('开头文字---## 一、标题内容**1. 项目**- 子项一- 子项二**2. 项目二**> 引用');
    expect(out).toContain('开头文字\n\n---\n\n## 一、标题内容');
    expect(out).toContain('**1. 项目**\n\n- 子项一');
    expect(out).toContain('\n- 子项二');
    expect(out).toContain('**2. 项目二**\n\n> 引用');
  });

  it('renders a single-line pasted markdown block as structured HTML', () => {
    const { container: c2 } = render(
      <MarkdownRenderer content={normalizeLlmText('前言---## 标题- 条目A- 条目B')} />,
    );
    expect(c2.querySelector('h2')).not.toBeNull();
    expect(c2.querySelector('hr')).not.toBeNull();
    expect(c2.querySelectorAll('li').length).toBeGreaterThanOrEqual(2);
  });

  it('leaves multi-line content untouched', () => {
    const md = '# 标题\n\n- 条目一\n- 条目二\n\n> 引用';
    expect(normalizeLlmText(md)).toBe(md);
  });

  it('does not split numbers like 1-5 minutes', () => {
    const out = normalizeLlmText('每次照射仅 1-5 分钟，剂量 1.8-2 Gy 常规分割。');
    expect(out).toBe('每次照射仅 1-5 分钟，剂量 1.8-2 Gy 常规分割。');
  });
});

describe('MarkdownRenderer — 标点围栏/表格容错(#598)', () => {
  it('围栏包裹单个标点 → 按普通文本(无 CodeBlock 复制按钮)', () => {
    const { container, getByText } = render(<MarkdownRenderer content={"```\n..\n```"} />);
    expect(container.querySelector('button')).toBeNull();
    expect(getByText('..')).toBeTruthy();
  });

  it('有语言标注的真实代码块仍渲染为 CodeBlock', () => {
    const { container } = render(<MarkdownRenderer content={"```python\nprint(1)\n```"} />);
    expect(container.querySelector('button')).toBeTruthy();
  });

  it('表头缺前导 | 的表格被修复渲染为表格(#598)', () => {
    const md = "On-Chain Reality| Asset | Debt |\n|---|---|---|\n| WETH | $3.93M | $3.80M |";
    const { container, getByText } = render(<MarkdownRenderer content={md} />);
    expect(container.querySelector('table')).toBeTruthy();
    expect(getByText('Asset')).toBeTruthy();
    expect(getByText('WETH')).toBeTruthy();
  });

  it('表头5列 + 分隔4列被强制修复为表格(#598)', () => {
    const md = "On-Chain Reality| Asset | Gross | Debt | Net |\n|---|---|---|---|\n| WETH | $3.93M | $3.80M | $0.13M |";
    const { container } = render(<MarkdownRenderer content={md} />);
    expect(container.querySelector('table')).toBeTruthy();
  });

  it('hr(---) 不被误判为表格(#598)', () => {
    const { container } = render(<MarkdownRenderer content={"## h2\n\n---\n\nbody"} />);
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('hr')).toBeTruthy();
  });

  it('非标准分隔行 |--| 被规范化为表格(#598)', () => {
    const md = "| A | B |\n|--|\n| 1 | 2 |";
    const { container } = render(<MarkdownRenderer content={md} />);
    expect(container.querySelector('table')).toBeTruthy();
  });
});
