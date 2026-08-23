import { describe, test, expect, vi, beforeEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TrackChangesExtension, getTrackedChanges, getBaseText, getResultText, getPendingChangeCount, type ChangeAuthor } from 'tiptap-track-changes';
import { applyTrackedDiff, buildFlatIndex } from './doc-diff';
import { markdownToHtml } from './doc-convert';

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

const AI: ChangeAuthor = { id: 'ai', name: 'AI', color: '#0ea5e9' };

function makeEditor(content: string): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      TrackChangesExtension.configure({ author: AI, mode: 'suggest' }),
    ],
    content,
  });
}

describe('doc-diff (AI 编辑 → track-changes 标记)', () => {
  beforeEach(() => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
  });

  test('buildFlatIndex 还原行级文本并映射 doc 位置', () => {
    const editor = makeEditor('<p>第一段</p><p>第二段</p>');
    const idx = buildFlatIndex(editor);
    expect(idx.text).toBe('第一段\n第二段');
    // 文本字符 + 1 个分隔符占位
    expect(idx.toDoc.length).toBe('第一段第二段'.length + 1);
    // 第一段第一个字符的 doc 位置
    expect(idx.toDoc[0]).toBeGreaterThanOrEqual(1);
    editor.destroy();
  });

  test('纯新增段 → 生成 insertion 标记;getBaseText=原文 / getResultText=新文', () => {
    const editor = makeEditor(markdownToHtml('第一段\n\n第二段'));
    const oldHtml = editor.getHTML();
    applyTrackedDiff(editor, oldHtml, markdownToHtml('第一段\n\n第二段\n\n新增段落'), AI);
    const changes = getTrackedChanges(editor);
    expect(changes.some((c) => c.type === 'insertion')).toBe(true);
    expect(getBaseText(editor)).toContain('第二段');
    expect(getResultText(editor)).toContain('新增段落');
    editor.destroy();
  });

  test('纯删除段 → deletion 标记,全部接受后等于新文', () => {
    const editor = makeEditor(markdownToHtml('第一段\n\n将被删除\n\n第三段'));
    const oldHtml = editor.getHTML();
    const n = applyTrackedDiff(editor, oldHtml, markdownToHtml('第一段\n\n第三段'), AI);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(getTrackedChanges(editor).some((c) => c.type === 'deletion')).toBe(true);
    expect(getPendingChangeCount(editor)).toBeGreaterThan(0);
    // 全部接受
    (editor.commands as any).acceptAll?.();
    expect(editor.getText().replace(/\s+/g, '')).toContain('第三段');
    editor.destroy();
  });

  test('替换(改词)→ 同一 changeId 的 insertion+deletion 配对', () => {
    const editor = makeEditor(markdownToHtml('患者血压 120/80'));
    const oldHtml = editor.getHTML();
    applyTrackedDiff(editor, oldHtml, markdownToHtml('患者血压 135/85'), AI);
    const grouped = new Map<string, number>();
    for (const c of getTrackedChanges(editor)) {
      grouped.set(c.changeId, (grouped.get(c.changeId) || 0) + 1);
    }
    // 至少有一组同时含 insertion + deletion
    expect([...grouped.values()].some((v) => v >= 2)).toBe(true);
    expect(getResultText(editor)).toContain('135/85');
    expect(getBaseText(editor)).toContain('120/80');
    editor.destroy();
  });
});
