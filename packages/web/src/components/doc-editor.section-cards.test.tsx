import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { DocEditor } from './DocEditor';
// i18n 初始化 — 组件内 t() 需插值(未初始化时 notReadyT 不插值)。
import '@/i18n';

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

/** #989 Phase 3: 投影构造 helper(与 writing-editor.routeguards 同款)。 */
const projSec = (id: string, heading: string, hash: string) => ({
  id, kind: 'section' as const, heading, level: 2, hash, start: 0, end: 1, parent_id: null,
});

const BASE_BODY = ['## Intro', '', '介绍原文。', '', '## Methods', '', '方法原文。'].join('\n');

function sectionCardsData(): NonNullable<Parameters<typeof DocEditor>[0]['sectionCards']> {
  return {
    projection: {
      schema_version: 1 as const,
      body_hash: 'next11111111',
      nodes: [
        projSec('s_intro', 'Intro', 'hash-intro-2'),
        projSec('s_methods', 'Methods', 'hash-methods-1'),
      ],
    },
    meta: {
      s_intro: { author: 'ai' as const, verify_status: 'pending' as const, updated_at: 't1' },
      s_methods: { author: 'human' as const, verify_status: 'verified' as const, updated_at: 't0' },
    },
    editingIds: ['s_intro'],
    diffRows: {
      s_intro: [{ type: 'del' as const, text: '介绍原文。' }, { type: 'add' as const, text: '介绍改过了。' }],
    },
  };
}

describe('#996/#1002 节卡片化画布(装饰层)', () => {
  beforeEach(() => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  });
  afterEach(() => cleanup());

  const renderEditor = (sectionCards?: Parameters<typeof DocEditor>[0]['sectionCards']) =>
    render(
      <DocEditor
        value={BASE_BODY}
        onChange={() => {}}
        diffReview={null}
        sectionCards={sectionCards}
      />,
    );

  test('节卡片 chrome:每个节有 top/bottom 框线类,标题行带 H 徽标与折叠 chevron', async () => {
    const { container } = renderEditor(sectionCardsData());
    await new Promise((r) => setTimeout(r, 150));

    // 卡片 chrome:sec-top/sec-bottom 挂在顶层子节点上(decoration node class)
    expect(container.querySelectorAll('.ProseMirror .sec-top').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.ProseMirror .sec-bottom').length).toBeGreaterThan(0);
    // 徽标:标题行内出现 H2 芯片 + chevron(每个标题一组)
    expect(container.querySelectorAll('.sec-badge-level').length).toBe(2);
    expect(container.querySelectorAll('.sec-chevron').length).toBe(2);
    // 首段前的游离块不属于任何节(无框线)— 此文档无游离块
  });

  test('节级徽标:作者轴(ai紫/human灰)+ 可信度轴(验证中/已验证)按 section_meta 渲染', async () => {
    const { container } = renderEditor(sectionCardsData());
    await new Promise((r) => setTimeout(r, 150));
    const badges = Array.from(container.querySelectorAll('.sec-badges'));
    expect(badges.length).toBe(2);
    // s_intro: AI + pending(验证中)
    const intro = badges[0];
    expect(intro.querySelector('.sec-badge-author-ai')?.textContent).toBe('AI');
    expect(intro.querySelector('.sec-badge-verify-pending')?.textContent).toContain('Verifying');
    // s_methods: human + verified
    const methods = badges[1];
    expect(methods.querySelector('.sec-badge-author-human')?.textContent).toBe('You');
    expect(methods.querySelector('.sec-badge-verify-verified')?.textContent).toContain('Verified');
    // 高亮:编辑中的节整卡带 sec-editing(挂顶层节点;徽标 span 本身不带)
    const introNode = badges[0].closest('.ProseMirror > *') as HTMLElement;
    const methodsNode = badges[1].closest('.ProseMirror > *') as HTMLElement;
    expect(introNode.classList.contains('sec-editing')).toBe(true);
    expect(methodsNode.classList.contains('sec-editing')).toBe(false);
  });

  test('流式迷你 diff:编辑中的节标题下方渲染增删行(红删除/绿新增)', async () => {
    const { container } = renderEditor(sectionCardsData());
    await new Promise((r) => setTimeout(r, 150));
    const diffs = container.querySelectorAll('.sec-diff');
    expect(diffs.length).toBe(1); // 仅编辑中的节有迷你 diff
    const del = diffs[0].querySelector('.sec-diff-del');
    const add = diffs[0].querySelector('.sec-diff-add');
    expect(del?.textContent).toContain('介绍原文。');
    expect(add?.textContent).toContain('介绍改过了。');
  });

  test('折叠:chevron 点击后非标题子节点隐藏(sec-collapsed),再点展开', async () => {
    const { container } = renderEditor(sectionCardsData());
    await new Promise((r) => setTimeout(r, 150));
    const chevrons = container.querySelectorAll('.sec-chevron');
    fireEvent.click(chevrons[0]);
    await new Promise((r) => setTimeout(r, 100));
    // Intro 节正文被隐藏(标题保留),Methods 节不受影响
    const hidden = container.querySelectorAll('.ProseMirror .sec-collapsed');
    expect(hidden.length).toBeGreaterThan(0);
    // 再点展开 — 装饰重渲染,sec-collapsed 清空
    fireEvent.click(container.querySelectorAll('.sec-chevron')[0]);
    await new Promise((r) => setTimeout(r, 100));
    expect(container.querySelectorAll('.ProseMirror .sec-collapsed').length).toBe(0);
  });

  test('无数据时不渲染任何装饰(存量文档/审阅降级)', async () => {
    const { container } = renderEditor(undefined);
    await new Promise((r) => setTimeout(r, 150));
    expect(container.querySelectorAll('.sec-badge-level').length).toBe(0);
    expect(container.querySelectorAll('.sec-diff').length).toBe(0);
  });
});

describe('#996-followup 多级标题(H1-H3)扁平卡片', () => {
  beforeEach(() => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  });
  afterEach(() => cleanup());

  const NESTED_BODY = ['## Parent', '', 'parent text', '', '### Child', '', 'child text', '', '## Next', '', 'next text'].join('\n');

  function nestedData(): NonNullable<Parameters<typeof DocEditor>[0]['sectionCards']> {
    return {
      projection: {
        schema_version: 1 as const,
        body_hash: 'nested000000',
        nodes: [
          { id: 's_parent', kind: 'section' as const, heading: 'Parent', level: 2, hash: 'h_parent', start: 0, end: 15, parent_id: null },
          { id: 's_child', kind: 'section' as const, heading: 'Child', level: 3, hash: 'h_child', start: 15, end: 28, parent_id: null },
          { id: 's_next', kind: 'section' as const, heading: 'Next', level: 2, hash: 'h_next', start: 28, end: 40, parent_id: null },
        ],
      },
      meta: { s_parent: { author: 'ai' as const, verify_status: 'pending' as const, updated_at: 't1' } },
    };
  }

  test('每卡只包自身内容(到下一个任意级标题)— 子节独立成卡,框线不重叠', async () => {
    const { container } = render(
      <DocEditor value={NESTED_BODY} onChange={() => {}} diffReview={null} sectionCards={nestedData()} />,
    );
    await new Promise((r) => setTimeout(r, 150));

    const h2s = container.querySelectorAll('.ProseMirror > h2');
    const h3 = container.querySelector('.ProseMirror > h3') as HTMLElement;
    expect(h2s.length).toBe(2);
    expect(h3).toBeTruthy();

    // 父节标题:卡顶;其后的段落收底(flat span 到 H3 为止)
    const parentHeading = h2s[0] as HTMLElement;
    expect(parentHeading.classList.contains('sec-top')).toBe(true);
    const parentPara = parentHeading.nextElementSibling as HTMLElement;
    expect(parentPara.classList.contains('sec-in')).toBe(true);
    expect(parentPara.classList.contains('sec-bottom')).toBe(true);

    // 子节(H3)独立卡:有自己的卡顶,且不带父卡的 sec-in(旧行为会重叠)
    expect(h3.classList.contains('sec-top')).toBe(true);
    expect(h3.classList.contains('sec-in')).toBe(false);

    // 徽标:父节 AI/pending;子节仅 H3 级芯片(无 meta)
    expect(parentHeading.querySelector('.sec-badges')?.textContent).toContain('AI');
    expect(h3.querySelector('.sec-badge-level')?.textContent).toBe('H3');
  });

  test('折叠父节(H2)→ 子节(H3)标题与内容整段隐藏,大纲语义联动', async () => {
    const { container } = render(
      <DocEditor value={NESTED_BODY} onChange={() => {}} diffReview={null} sectionCards={nestedData()} />,
    );
    await new Promise((r) => setTimeout(r, 150));

    const parentHeading = container.querySelectorAll('.ProseMirror > h2')[0] as HTMLElement;
    const parentChevron = parentHeading.querySelector('.sec-chevron') as HTMLElement;
    fireEvent.click(parentChevron);
    await new Promise((r) => setTimeout(r, 100));

    // 父节自身内容 + 子节(标题节点/内容)全部 sec-collapsed
    const childHeading = container.querySelector('.ProseMirror > h3') as HTMLElement;
    expect(childHeading.classList.contains('sec-collapsed')).toBe(true);
    const collapsedNodes = container.querySelectorAll('.ProseMirror .sec-collapsed');
    expect(collapsedNodes.length).toBeGreaterThanOrEqual(3); // 父正文段 + H3 + 子正文段
    // 同级 Next(H2)不受影响
    const nextHeading = container.querySelectorAll('.ProseMirror > h2')[1] as HTMLElement;
    expect(nextHeading.classList.contains('sec-collapsed')).toBe(false);

    // 再点展开 → 子节恢复
    fireEvent.click(container.querySelectorAll('.sec-chevron')[0]);
    await new Promise((r) => setTimeout(r, 100));
    expect((container.querySelector('.ProseMirror > h3') as HTMLElement).classList.contains('sec-collapsed')).toBe(false);
  });
});

describe('#996-followup 移动端自动折叠 — 正在编辑的嵌套子节不被祖先折叠遮挡', () => {
  const NESTED_BODY = ['## Parent', '', 'parent text', '', '### Child', '', 'child text', '', '## Next', '', 'next text'].join('\n');

  /** span 按大纲语义:父节 span 包含子节(与 buildBlockProjection 同口径)。 */
  function mobileNestedData(): NonNullable<Parameters<typeof DocEditor>[0]['sectionCards']> {
    return {
      projection: {
        schema_version: 1 as const,
        body_hash: 'mobile0000000',
        nodes: [
          { id: 's_parent', kind: 'section' as const, heading: 'Parent', level: 2, hash: 'h_parent', start: 0, end: 47, parent_id: null },
          { id: 's_child', kind: 'section' as const, heading: 'Child', level: 3, hash: 'h_child', start: 24, end: 47, parent_id: null },
          { id: 's_next', kind: 'section' as const, heading: 'Next', level: 2, hash: 'h_next', start: 47, end: 65, parent_id: null },
        ],
      },
      editingIds: ['s_child'],
    };
  }

  beforeEach(() => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    (window as any).matchMedia = vi.fn().mockReturnValue({
      matches: true, media: '(max-width: 767px)', onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    });
  });
  afterEach(() => {
    cleanup();
    (window as any).matchMedia = (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    });
  });

  test('父节(祖先)与正在编辑的子节都不自动折叠,其他同级节照常折叠', async () => {
    const { container } = render(
      <DocEditor value={NESTED_BODY} onChange={() => {}} diffReview={null} sectionCards={mobileNestedData()} />,
    );
    await new Promise((r) => setTimeout(r, 200));

    const h2s = container.querySelectorAll('.ProseMirror > h2');
    const childHeading = container.querySelector('.ProseMirror > h3') as HTMLElement;
    const parentPara = h2s[0].nextElementSibling as HTMLElement;
    // 正在编辑的嵌套子节没有被父节折叠遮挡
    expect(childHeading.classList.contains('sec-collapsed')).toBe(false);
    expect(parentPara.classList.contains('sec-collapsed')).toBe(false);
    // 其他同级节(Next)照常自动折叠:标题保留、内容隐藏
    const nextPara = h2s[1].nextElementSibling as HTMLElement;
    expect(nextPara.classList.contains('sec-collapsed')).toBe(true);
  });
});

describe('#996-followup H4-H6 不占用投影节索引(防折叠按钮控错节)', () => {
  // Alpha 带 markdown 强调标记:投影 heading 是原文(**)而编辑器 textContent
  // 是纯文本 — H4 存在走文本对位路径,验证规范化后仍能挂上 meta。
  const BODY_H4 = ['## **Alpha**', '', 'alpha text', '', '#### Deep Note', '', 'deep text', '', '## Beta', '', 'beta text'].join('\n');
  const BETA_POS = BODY_H4.indexOf('## Beta');

  /** 投影只含 H1-H3(HEADING_RE);正文含 H4 — 旧回退 sections[hi] 会错位。 */
  function dataWithH4(): NonNullable<Parameters<typeof DocEditor>[0]['sectionCards']> {
    return {
      projection: {
        schema_version: 1 as const,
        body_hash: 'h4h4h4h4h4h4',
        nodes: [
          { id: 's_alpha', kind: 'section' as const, heading: '**Alpha**', level: 2, hash: 'h_alpha', start: 0, end: BETA_POS, parent_id: null },
          { id: 's_beta', kind: 'section' as const, heading: 'Beta', level: 2, hash: 'h_beta', start: BETA_POS, end: BODY_H4.length, parent_id: null },
        ],
      },
      meta: {
        s_alpha: { author: 'ai' as const, verify_status: 'pending' as const, updated_at: 't1' },
        s_beta: { author: 'human' as const, verify_status: 'verified' as const, updated_at: 't0' },
      },
    };
  }

  beforeEach(() => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  });
  afterEach(() => cleanup());

  test('H4 卡片不误挂相邻 H2 的 meta;点 H4 折叠只折叠自己,不动 Beta', async () => {
    const { container } = render(
      <DocEditor value={BODY_H4} onChange={() => {}} diffReview={null} sectionCards={dataWithH4()} />,
    );
    await new Promise((r) => setTimeout(r, 200));

    const h4 = container.querySelector('.ProseMirror > h4') as HTMLElement;
    expect(h4).toBeTruthy();
    // H4 不是节:不得拿到 Beta(旧位置回退 sections[1])的 meta
    expect(h4.querySelector('.sec-badge-author-human')).toBeNull();
    expect(h4.querySelector('.sec-badge-author-ai')).toBeNull();
    // #1021: 投影对位失败有可见标记（不再静默无提示）
    expect(h4.querySelector('.sec-badges-unmatched')).toBeTruthy();
    // 两个 H2 各自对位正确
    const h2s = container.querySelectorAll('.ProseMirror > h2');
    expect(h2s[0].querySelector('.sec-badge-author-ai')).toBeTruthy();
    expect(h2s[1].querySelector('.sec-badge-author-human')).toBeTruthy();
    expect(h2s[0].querySelector('.sec-badges-unmatched')).toBeNull();

    // 点 H4 折叠 → 只隐藏 H4 自身内容;Beta 内容不受影响(旧行为会折叠 Beta)
    fireEvent.click(h4.querySelector('.sec-chevron') as HTMLElement);
    await new Promise((r) => setTimeout(r, 100));
    const deepPara = h4.nextElementSibling as HTMLElement;
    const beta2 = container.querySelectorAll('.ProseMirror > h2')[1] as HTMLElement;
    const betaPara = beta2.nextElementSibling as HTMLElement;
    expect(deepPara.classList.contains('sec-collapsed')).toBe(true);
    expect(betaPara.classList.contains('sec-collapsed')).toBe(false);
  });
});
