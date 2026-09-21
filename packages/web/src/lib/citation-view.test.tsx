/**
 * #1077 — 正文引用 shortcode 渲染层(组件级测试)。
 *
 * 装架:doc-editor.section-cards.test.tsx 同款 jsdom + FakeRange 桩,
 * DocEditor 真实挂载(tiptap),装饰经容器 DOM 查询断言。
 * 用例:
 * 1) 3 个不同 marker → 徽标 [1][2][3] 按首现顺序编号
 * 2) 删除一个 marker → 编号连续重排
 * 3) 同一 id 引用两次 → 两处徽标同号
 * 4) round-trip:shortcode 纯文本保留(getHTML / onChange markdown 均含原文)
 * 5) 点击徽标 → onCitationClick 回调携带 id;预览弹窗渲染元数据(标题/DOI 链接)
 * 6) 悬挂引用(id 无记录)→ [?] 警示徽标
 */
import { describe, test, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { DocEditor } from '@/components/DocEditor';
import { CitationPreviewModal } from '@/routes/writing-editor/citation-preview';
import type { DocCitationWire } from '@/lib/api';
// i18n 初始化 — title/徽标 tooltip 经 t() 解析,固定 zh-CN 维持中文断言。
import i18n from '@/i18n';

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

// TipTap needs a real selection API in jsdom(与 doc-editor-format.test.tsx 同款桩)
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
  getClientRects = () => [] as unknown as DOMRectList;
  getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}
if (!(Range.prototype as unknown as { getClientRects?: unknown }).getClientRects) {
  (Range.prototype as unknown as { getClientRects: () => DOMRectList }).getClientRects = () => [] as unknown as DOMRectList;
}
if (!(Range.prototype as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect) {
  (Range.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
    () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));

const CITE_A: DocCitationWire = {
  id: 'aaa', doi: '10.1000/aaa', title: 'Alpha Paper', authors: ['Zhang S', 'Li Q'],
  journal: 'Nature', year: 2024, source: 'pubmed',
};
const CITE_B: DocCitationWire = {
  id: 'bbb', doi: '10.1000/bbb', title: 'Beta Paper', authors: ['Wang W'],
  journal: 'Science', year: 2023, source: 'crossref',
};
const CITE_C: DocCitationWire = {
  id: 'ccc', doi: '10.1000/ccc', title: 'Gamma Paper', authors: ['Liu M'],
  source: 'pubmed',
};

/** 渲染带引用数据的 DocEditor 并等待编辑器水合 + 装饰下发。 */
function setupEditor(value: string, citations: DocCitationWire[], onCitationClick = vi.fn()) {
  const ref: { current: Editor | null } = { current: null };
  const utils = render(
    <DocEditor value={value} onChange={() => {}} citations={citations} onCitationClick={onCitationClick} editorRef={ref} />,
  );
  return { ref, onCitationClick, ...utils };
}

const body3 = '## Intro\n\nHere we cite [cite:aaa] and [cite:bbb] and [cite:ccc].\n';

describe('#1077 用例1 三个 marker 按首现顺序编号', () => {
  test('徽标 [1][2][3] 顺序渲染,data-citation-id 对应', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const { container } = setupEditor(body3, [CITE_A, CITE_B, CITE_C]);
    await wait();
    const badges = Array.from(container.querySelectorAll('.citation-badge-widget'));
    expect(badges).toHaveLength(3);
    expect(badges.map((b) => b.textContent)).toEqual(['[1]', '[2]', '[3]']);
    expect(badges.map((b) => b.getAttribute('data-citation-id'))).toEqual(['aaa', 'bbb', 'ccc']);
    // shortcode 原文仍在文档中(inline decoration 包裹,不替换文本)
    expect(container.querySelectorAll('.citation-badge.citation-raw')).toHaveLength(3);
    cleanup();
  });
});

describe('#1077 用例2 删除 marker 后编号连续重排', () => {
  test('移除 [cite:bbb] → aaa=[1], ccc=[2]', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const first = setupEditor(body3, [CITE_A, CITE_B, CITE_C]);
    await wait();
    // rerender 删除 bbb — value 变化触发外部内容替换 → docChanged 全量重建。
    first.rerender(
      <DocEditor
        value={'## Intro\n\nHere we cite [cite:aaa] and [cite:ccc].\n'}
        onChange={() => {}}
        citations={[CITE_A, CITE_B, CITE_C]}
        onCitationClick={first.onCitationClick}
        editorRef={first.ref}
      />,
    );
    await wait();
    const badges = Array.from(first.container.querySelectorAll('.citation-badge-widget'));
    expect(badges).toHaveLength(2);
    expect(badges.map((b) => b.textContent)).toEqual(['[1]', '[2]']);
    expect(badges.map((b) => b.getAttribute('data-citation-id'))).toEqual(['aaa', 'ccc']);
    cleanup();
  });
});

describe('#1077 用例3 同一 id 引用两次共享编号', () => {
  test('两处 [cite:aaa] 都是 [1]', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const { container } = setupEditor('Text [cite:aaa] mid [cite:aaa] tail.', [CITE_A]);
    await wait();
    const badges = Array.from(container.querySelectorAll('.citation-badge-widget'));
    expect(badges).toHaveLength(2);
    expect(badges.every((b) => b.textContent === '[1]')).toBe(true);
    cleanup();
  });
});

describe('#1077 用例4 round-trip:shortcode 纯文本保留', () => {
  test('getHTML 与 onChange markdown 均含字面 [cite:id]', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const onChange = vi.fn();
    const ref: { current: Editor | null } = { current: null };
    render(
      <DocEditor value={body3} onChange={onChange} citations={[CITE_A, CITE_B, CITE_C]} editorRef={ref} />,
    );
    await wait();
    const html = ref.current!.getHTML();
    expect(html).toContain('[cite:aaa]');
    expect(html).toContain('[cite:bbb]');
    expect(html).toContain('[cite:ccc]');
    // 编辑器纯文本同样保留(worker 导出按纯文本解析的契约面)
    expect(ref.current!.getText()).toContain('[cite:aaa]');
    cleanup();
  });
});

describe('#1077 用例5 点击徽标 → 回调 + 预览弹窗元数据', () => {
  test('点击 [cite:aaa] 徽标 → onCitationClick("aaa");弹窗展示标题与 DOI 链接', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const { container, onCitationClick } = setupEditor(body3, [CITE_A, CITE_B, CITE_C]);
    await wait();
    const badge = container.querySelector('.citation-badge-widget')!;
    fireEvent.click(badge);
    expect(onCitationClick).toHaveBeenCalledWith('aaa');
    // 预览弹窗(路由层组件)— 以回调携带的 id 打开,渲染元数据。
    render(<CitationPreviewModal citationId="aaa" citations={[CITE_A, CITE_B, CITE_C]} onClose={() => {}} />);
    const preview = screen.getByTestId('citation-preview');
    expect(preview.textContent).toContain('Alpha Paper');
    expect(preview.textContent).toContain('Zhang S');
    const doi = screen.getByTestId('citation-preview-doi');
    expect(doi.getAttribute('href')).toBe('https://doi.org/10.1000/aaa');
    cleanup();
  });

  test('悬挂引用点击 → 弹窗渲染警示态说明', async () => {
    render(<CitationPreviewModal citationId="ghost" citations={[CITE_A]} onClose={() => {}} />);
    const preview = screen.getByTestId('citation-preview');
    expect(preview.textContent).toContain('未找到对应文献记录');
    expect(preview.textContent).toContain('[cite:ghost]');
    expect(screen.queryByTestId('citation-preview-doi')).toBeNull();
    cleanup();
  });
});

describe('#1077 用例6 悬挂引用渲染 [?] 警示徽标', () => {
  test('id 无记录 → citation-dangling-widget + [?],已知引用不受影响', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const { container } = setupEditor('Body [cite:aaa] and [cite:ghost].', [CITE_A]);
    await wait();
    const dangling = container.querySelector('.citation-dangling-widget')!;
    expect(dangling.textContent).toBe('[?]');
    expect(dangling.getAttribute('data-citation-id')).toBe('ghost');
    expect(container.querySelectorAll('.citation-badge-widget')).toHaveLength(1);
    cleanup();
  });
});
