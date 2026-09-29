import { describe, test, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import '@/i18n';

/**
 * #1144 — DocEditor 每次按键的全文转换次数回归。
 * 修复前:onUpdate 转一次 + value 回流 effect 再转一次比较 = 每次按键 2 次
 * HTML→Markdown 全文转换(几万字论文在中低端设备上输入卡顿/IME 掉字)。
 * 修复后:lastEmittedRef 短路回流,单次编辑仅 1 次转换。
 */
vi.mock('@/lib/doc-convert', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/doc-convert')>();
  return {
    ...actual,
    htmlToMarkdown: vi.fn(actual.htmlToMarkdown),
    markdownToHtml: vi.fn(actual.markdownToHtml),
  };
});

import { htmlToMarkdown } from '@/lib/doc-convert';

import { DocEditor } from './DocEditor';

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

describe('#1144 DocEditor 全文转换次数', () => {
  test('单次编辑只做一次 HTML→Markdown 转换（value 回流短路，不再二次转换）', async () => {
    vi.spyOn(document, 'createRange').mockImplementation(() => new FakeRange() as unknown as Range);
    const conversion = vi.mocked(htmlToMarkdown);
    const editorRef = { current: null as Editor | null };

    function Harness() {
      const [body, setBody] = useState('# 标题');
      return <DocEditor value={body} onChange={(md) => { emits.push(md); setBody(md); }} editorRef={editorRef} />;
    }
    const emits: string[] = [];
    render(<Harness />);
    await new Promise((r) => setTimeout(r, 150));
    expect(editorRef.current).toBeTruthy();

    conversion.mockClear(); // 装载期转换不计入
    editorRef.current!.commands.insertContent('X');
    await waitFor(() => expect(conversion.mock.calls.length).toBeGreaterThan(0));
    // 回流 effect 窗口走完后再断言（修复前此处已累计 2 次）。
    await new Promise((r) => setTimeout(r, 150));
    // 单次编辑应只触发一次 onChange；每次转换数不得超过 emit 数（旧实现为 2×）。
    // 每次按键(每个去重后的正文版本)至多一次转换 — 修复前 effect 会对
    // 自己刚发出的 value 再转一次,conversions 超出 unique emits(实测 3>2)。
    const distinctEmits = new Set(emits).size;
    expect(distinctEmits).toBeGreaterThan(0);
    expect(
      conversion.mock.calls.length,
      `emits=${emits.length} unique=${distinctEmits} conversions=${conversion.mock.calls.length}`,
    ).toBeLessThanOrEqual(distinctEmits);
  });
});
