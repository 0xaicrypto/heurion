import { describe, test, expect, vi } from 'vitest';
import { Profiler } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { DocEditor } from './DocEditor';
// i18n 初始化 — ProposalCard 的统计文案经 t() 插值,未初始化时 notReadyT
// 不做插值(渲染原始 {{a}} 模板),断言会拿到假串。
import '@/i18n';

// TipTap needs a real selection API in jsdom
class FakeRange {  startContainer: Node = document;
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
  // #996-followup: heading 切换命令的 focus→scrollToSelection 路径需要
  // getClientRects（jsdom 缺失，此前用例不触发该路径）。
  getClientRects = () => [] as unknown as DOMRectList;
  getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}
// jsdom Selection.getRangeAt 返回内部 Range（非上面的 FakeRange）— 同步补桩。
if (!(Range.prototype as unknown as { getClientRects?: unknown }).getClientRects) {
  (Range.prototype as unknown as { getClientRects: () => DOMRectList }).getClientRects = () => [] as unknown as DOMRectList;
}
if (!(Range.prototype as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect) {
  (Range.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
    () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
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
    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(screen.getByText(/2 pending|2 处待处理/)).toBeInTheDocument();
    // #fix: 逐条确认 — 导航即选中,显示「选中修改」+ 接受/拒绝按钮
    // (此前覆盖判定对导航选区不成立,只能全部接受/全部拒绝)。
    const acceptOne = screen.getByTitle(/Accept|接受/);
    expect(acceptOne).toBeInTheDocument();
    expect(screen.getByTitle(/Reject|拒绝/)).toBeInTheDocument();
    // 下一处可点,选中同步。
    screen.getByTitle(/Next change|下一处修改/).click();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByText('2/2')).toBeInTheDocument();
    // 上一处回退。
    screen.getByTitle(/Previous change|上一处修改/).click();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByText('1/2')).toBeInTheDocument();
    // 逐条接受后 pending 减少,自动跳到下一处。
    acceptOne.click();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByText(/1 pending|1 处待处理/)).toBeInTheDocument();
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
    screen.getByRole('button', { name: /Keep AI's edit|保留 AI 的修改/ }).click();
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
    expect(screen.getByText(/3 pending|3 处待处理/)).toBeInTheDocument();
    expect(screen.getByText('1/3')).toBeInTheDocument();
    // 新增章节与两处润色的内容都已在编辑框中(标记态)
    const editorText = container.querySelector('.ProseMirror')?.textContent ?? '';
    expect(editorText).toContain('新增结果章节。');
    expect(editorText).toContain('第一段已润色。');
    expect(editorText).toContain('第二段已润色。');
  });
});

describe('#996-followup 标题级别选择器(H1-H3)', () => {
  test('触发器显示当前级别;选择 H3 即把当前块转为三级标题', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const ref: { current: Editor | null } = { current: null };
    render(<DocEditor value={'## 原标题\n\n段落'} onChange={() => {}} editorRef={ref} />);
    await new Promise((r) => setTimeout(r, 250));

    // 光标默认在文档首(标题行)→ 触发器显示 H2
    const trigger = screen.getByRole('button', { name: /文本样式|Text style/ });
    expect(trigger.textContent).toContain('H2');

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'H3' }));
    await new Promise((r) => setTimeout(r, 150));

    expect(ref.current?.getHTML()).toContain('<h3');
    // 选择正文 → 标题退回段落
    fireEvent.click(screen.getByRole('button', { name: /文本样式|Text style/ }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /正文|Paragraph/ }));
    await new Promise((r) => setTimeout(r, 150));
    expect(ref.current?.getHTML()).not.toContain('<h3');
  });

  test('review 复核#7: 点击当前已生效的级别 → 保持标题,不再 toggle 降级', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const ref: { current: Editor | null } = { current: null };
    render(<DocEditor value={'## 原标题\n\n段落'} onChange={() => {}} editorRef={ref} />);
    await new Promise((r) => setTimeout(r, 250));

    // 当前是 H2;点菜单里的 H2(radio 语义 = 确认当前项)不应取消标题
    fireEvent.click(screen.getByRole('button', { name: /文本样式|Text style/ }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'H2' }));
    await new Promise((r) => setTimeout(r, 150));

    expect(ref.current?.getHTML()).toContain('<h2');
    expect(ref.current?.getHTML()).not.toContain('<p>原标题</p>');
    expect(screen.getByRole('button', { name: /文本样式|Text style/ }).textContent).toContain('H2');
  });
});

// #1066-5: 事务订阅重渲染收敛 — 此前每事务无条件 bumpTick 全组件重渲染,
// 流式写入期间开销放大。收敛为"渲染相关状态(签名)变化才 bump"。
describe('#1066-5 事务订阅按渲染相关状态变化才重渲染', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('渲染无关事务(内容位移但 marks/选区/可用态不变)不触发重渲染;active 变化仍刷新', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const ref: { current: Editor | null } = { current: null };
    const phases: string[] = [];
    const { container } = render(
      <Profiler id="doc-editor" onRender={(_id, phase) => phases.push(phase)}>
        <DocEditor value={'<p>签名测试段落。</p>'} onChange={() => {}} editorRef={ref} />
      </Profiler>,
    );
    await wait(300);
    // 等挂载期渲染平息后再清零计数,只观测后续事务的影响。
    await wait(150);
    phases.length = 0;
    const ed = ref.current!;
    expect(ed).toBeTruthy();

    // 渲染无关事务:no-op transaction(marks/选区/undo/redo 等全部不变)
    // — 收敛后不得触发重渲染(修复前每事务无条件 bump → 必然重渲染)。
    ed.view.dispatch(ed.state.tr.setMeta('noop', true));
    await wait(120);
    const rendersAfterNoop = phases.length;

    // 功能不回退:active mark 变化的事务仍触发重渲染(工具栏高亮刷新)。
    ed.chain().focus().toggleBold().run();
    await wait(120);
    expect(ed.isActive('bold')).toBe(true);

    expect(rendersAfterNoop).toBe(0);
    expect(phases.length).toBeGreaterThan(0);
    // 工具栏高亮确实随 active 刷新(bold 按钮高亮)。
    const boldBtn = container.querySelector('button[title="Bold"]') as HTMLButtonElement;
    expect(boldBtn.className).toContain('bg-surface');
  });
});

/**
 * P1 回归 — 按键回流不得重建全文。
 *
 * 此前「退出审阅」effect 无守卫地在每次 value 变化时 applyExternalContent：
 * 用户每按一键 → onChange → 父级 value 回流 → setContent 重建整篇文档，
 * 带来性能损耗、撤销历史被污染、中文输入法组合被打断。
 */
describe('P1 编辑回流不重建文档', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('本地输入 → value 回流（内容等价）不再调用 setContent', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const ref: { current: Editor | null } = { current: null };
    const onChange = vi.fn();
    const { rerender } = render(<DocEditor value={'# 标题'} onChange={onChange} editorRef={ref} />);
    await wait(300);
    const ed = ref.current!;
    expect(ed).toBeTruthy();
    const setContentSpy = vi.spyOn(ed.commands as unknown as { setContent: (...a: unknown[]) => unknown }, 'setContent');

    // 模拟一次用户输入事务 → onUpdate 上报 markdown。
    ed.chain().focus().insertContent('新打的字').run();
    await wait(80);
    const md = String(onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] ?? '');
    expect(md).toContain('新打的字');

    // 父级以等价内容回流 value（真实编辑链路）。
    rerender(<DocEditor value={md} onChange={onChange} editorRef={ref} />);
    await wait(150);
    expect(setContentSpy).not.toHaveBeenCalled();
  });

  test('外部内容变化（AI 更新）仍正常应用', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const { rerender, container } = render(<DocEditor value={'# 旧'} onChange={() => {}} />);
    await wait(200);
    rerender(<DocEditor value={'# 新标题'} onChange={() => {}} />);
    await wait(300);
    expect(container.querySelector('.ProseMirror')?.textContent ?? '').toContain('新标题');
  });
});
