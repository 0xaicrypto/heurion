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
