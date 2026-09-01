import { describe, test, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
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

/**
 * #752-followup 回归: 提供 onBubbleAction 时 BubbleMenu 插件必须注册到
 * 编辑器(此前手写 registerPlugin(extension) 传错对象导致白屏;改为官方
 * React 组件后插件 key 应存在)。内容按钮经 portal 渲染于插件管理的
 * 浮层,jsdom 不附加到 document,点击分发逻辑由线上 bundle 验证。
 */
describe('DocEditor Selection Bubble (#752)', () => {
  // #792: 气泡运行态回调收敛为单个 bubble 对象 — 提供时注册插件。
  const bubbleProp = {
    run: null,
    onStart: () => {},
    onApply: () => {},
    onDiscard: () => {},
    onRetry: () => {},
    onRefine: () => {},
  };

  test('onBubbleAction + bubble 提供时 bubbleMenu 插件已注册', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const editorRef = { current: null };
    render(<DocEditor value="# 标题" onChange={() => {}} onBubbleAction={() => {}} bubble={bubbleProp} editorRef={editorRef} />);
    await new Promise((r) => setTimeout(r, 200));
    const editor = editorRef.current as any;
    expect(editor).toBeTruthy();
    const keys = (editor.state.plugins as Array<{ key?: string }>).map((p) => String(p.key ?? ''));
    expect(keys.some((k) => k.includes('bubbleMenu'))).toBe(true);
  });

  test('未提供 onBubbleAction 时不注册 bubble 插件', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const editorRef = { current: null };
    render(<DocEditor value="# 标题" onChange={() => {}} editorRef={editorRef} />);
    await new Promise((r) => setTimeout(r, 200));
    const editor = editorRef.current as any;
    const keys = (editor.state.plugins as Array<{ key?: string }>).map((p) => String(p.key ?? ''));
    expect(keys.some((k) => k.includes('bubbleMenu'))).toBe(false);
  });
});
