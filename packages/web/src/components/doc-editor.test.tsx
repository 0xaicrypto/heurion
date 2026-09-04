import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DocEditor } from './DocEditor';

// TipTap needs a real selection API in jsdom
class FakeRange {
  startContainer: Node = document;
  startOffset = 0;
  endContainer: Node = document;
  endOffset = 0;
  collapsed = true;
  commonAncestorContainer: Node = document;
  setStart() {}
  setEnd() {}
  collapse() {}
  selectNodeContents() {}
  deleteContents() {}
  insertNode() {}
  createContextualFragment = () => document.createDocumentFragment();
  toString = () => '';
}

describe('DocEditor (TipTap canvas)', () => {
  test('#1 markdown loads as editor content (table becomes <table>)', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const md = '# 标题\n\n| 药物 | 剂量 |\n|---|---|\n| A | 100mg |';
    render(<DocEditor value={md} onChange={() => {}} />);
    // wait for the editor to hydrate
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByText('药物')).toBeInTheDocument();
    expect(screen.getByText('100mg')).toBeInTheDocument();
  });
});

describe('DocEditor behaviors', () => {
  test('#2/#3 editor edits round-trip to markdown (table insert → pipe rows)', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const onChange = vi.fn();
    render(<DocEditor value="# 标题" onChange={onChange} />);
    await new Promise((r) => setTimeout(r, 100));

    const insertTableBtn = screen.getByTitle('Insert table');
    insertTableBtn.click();
    await new Promise((r) => setTimeout(r, 100));

    // onChange receives markdown containing a GFM table
    const calls = onChange.mock.calls.map((c) => String(c[0]));
    expect(calls.some((md) => md.includes('|') && md.includes('---'))).toBe(true);
  });

  test('#4 AI update: value prop change applies new markdown', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const { rerender, container } = render(<DocEditor value="# 旧标题" onChange={() => {}} />);
    await new Promise((r) => setTimeout(r, 100));

    rerender(<DocEditor value="# 新标题\n\n| A | B |\n|---|---|\n| 1 | 2 |" onChange={() => {}} />);
    await new Promise((r) => setTimeout(r, 400));

    const text = container.querySelector('.ProseMirror')?.textContent ?? '';
    expect(text).toContain('新标题');
    expect(text).toContain('1');
    expect(text).not.toContain('旧标题');
  });

  test('#5 审阅模式:多修改逐条导航(第 N/M 处)渲染', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    // 两处独立修改(中间隔未改段落,不会被 diff 合并成一组)。
    const md = '第一段原文。\n\n## 未改章节\n\n保持不变的段落。\n\n第二段原文。';
    const next = '第一段已润色。\n\n## 未改章节\n\n保持不变的段落。\n\n第二段已润色。';
    render(
      <DocEditor
        value={md}
        onChange={() => {}}
        diffReview={{ key: 'rev_1', old: md, next }}
        onDiffResolve={() => {}}
      />,
    );
    await new Promise((r) => setTimeout(r, 300));
    // 两处修改:进入审阅自动聚焦第 1 处。
    expect(screen.getByText('第 1/2 处')).toBeInTheDocument();
    expect(screen.getByText(/2 处待处理/)).toBeInTheDocument();
    // #fix: 逐条确认 — 导航即选中,显示「选中修改」+ 接受/拒绝按钮
    // (此前覆盖判定对导航选区不成立,只能全部接受/全部拒绝)。
    expect(screen.getByText(/选中修改/)).toBeInTheDocument();
    const acceptOne = screen.getByRole('button', { name: /^接受$/ });
    expect(acceptOne).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^拒绝$/ })).toBeInTheDocument();
    // 下一处可点,选中同步。
    screen.getByTitle('下一处修改').click();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByText('第 2/2 处')).toBeInTheDocument();
    expect(screen.getByText(/选中修改/)).toBeInTheDocument();
    // 上一处回退。
    screen.getByTitle('上一处修改').click();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByText('第 1/2 处')).toBeInTheDocument();
    // 逐条接受后 pending 减少,自动跳到下一处。
    acceptOne.click();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByText(/1 处待处理/)).toBeInTheDocument();
  });

  // #837: AI 写回多块内容(小节标题+多段)接受后必须保持块结构 —
  // 生产事故:扁平 diff 直接 markdownToHtml 把单换行当软换行,整块内容
  // 粘进一个段落,接受后 htmlToMarkdown 再把行首 '#' 逃逸成 '\##'。
  test('#837 写回多块内容全部接受后保持块结构(标题/段落不粘连、无逃逸)', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const md = [
      '# 论文',
      '',
      '## Introduction',
      '',
      'Briefly present the background and current state of knowledge.',
      '',
      '## Methods',
      '',
      '方法段落。',
    ].join('\n');
    const next = [
      '# 论文',
      '',
      '## Introduction',
      '',
      'EGFR-Mutant NSCLC and the TKI Era',
      '',
      'EGFR mutations occur in approximately 15–50% of patients with NSCLC.',
      '',
      '- 首次应用',
      '- 填补空白',
      '',
      '## Methods',
      '',
      '方法段落。',
    ].join('\n');
    const onResolve = vi.fn();
    render(
      <DocEditor value={md} onChange={() => {}} diffReview={{ key: 'rev_837', old: md, next }} onDiffResolve={onResolve} />,
    );
    await new Promise((r) => setTimeout(r, 300));
    screen.getByRole('button', { name: /全部接受/ }).click();
    await new Promise((r) => setTimeout(r, 300));
    expect(onResolve).toHaveBeenCalled();
    const resultMd = String(onResolve.mock.calls[0][0].md);
    // 小节标题独占一行、与正文分块
    expect(resultMd).toMatch(/EGFR-Mutant NSCLC and the TKI Era\n\n?EGFR mutations occur/);
    // 列表保持
    expect(resultMd).toMatch(/-\s+首次应用/);
    // 无 '#' 逃逸、无字面 ## 残留
    expect(resultMd).not.toContain('\\#');
    expect(resultMd).not.toContain('## EGFR-Mutant NSCLC and the TKI Era EGFR mutations');
  });

  // #837-ux: 多处变更必须**同时**全部标记 — 用户在左侧编辑框一次看到
  // 所有 diff(逐条导航 第 N/M 处),而不是只显示一个。
  test('#837-ux 多处变更同时标记(导航 第 1/N 处,全部可见)', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const md = [
      '# 论文',
      '',
      '第一段原文。',
      '',
      '## Middle',
      '',
      '第二段原文。',
      '',
      '## Methods',
      '',
      '方法段落。',
    ].join('\n');
    const next = [
      '# 论文',
      '',
      '第一段已润色。',
      '',
      '## Middle',
      '',
      '第二段已润色。',
      '',
      '## Results',
      '',
      '新增结果章节。',
      '',
      '## Methods',
      '',
      '方法段落。',
    ].join('\n');
    const { container } = render(
      <DocEditor value={md} onChange={() => {}} diffReview={{ key: 'rev_multi', old: md, next }} onDiffResolve={() => {}} />,
    );
    await new Promise((r) => setTimeout(r, 300));
    // 两处替换 + 一处新增 = 3 组,全部同时标记
    expect(screen.getByText(/3 处待处理/)).toBeInTheDocument();
    expect(screen.getByText(/第 1\/3 处/)).toBeInTheDocument();
    // 新增章节与两处润色的内容都已在编辑框中(标记态)
    const editorText = container.querySelector('.ProseMirror')?.textContent ?? '';
    expect(editorText).toContain('新增结果章节。');
    expect(editorText).toContain('第一段已润色。');
    expect(editorText).toContain('第二段已润色。');
  });
});
