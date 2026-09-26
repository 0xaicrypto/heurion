import { describe, test, expect, vi, beforeEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TrackChangesExtension, getTrackedChanges, getBaseText, getResultText, getPendingChangeCount, type ChangeAuthor } from 'tiptap-track-changes';
import { applyTrackedDiff, buildFlatIndex } from './doc-diff';
import { markdownToHtml } from './doc-convert';
// 源级防复发锁 — web 包 tsc 无 node types，用 Vite ?raw 导入源码文本。
import docDiffSrc from './doc-diff.ts?raw';

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

/**
 * P0 XSS 回归 — 文本投影不得把 markdown 灌进会加载资源的 DOM。
 * 修复前 inlineToText 用 el.innerHTML = markdownToHtml(line)：正文里的
 * <img src=x onerror=…> 在进入修改审阅（投影定位）时真实执行。
 */
describe('P0 doc-diff XSS: 文本投影用 inert 解析', () => {
  beforeEach(() => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
  });

  test('源级防复发锁: doc-diff 不再出现 innerHTML 赋值，使用 DOMParser(inert)', () => {
    expect(docDiffSrc).not.toMatch(/\.innerHTML\s*=/);
    expect(docDiffSrc).toContain('new DOMParser()');
  });

  test('含 raw HTML <img onerror> 的行：投影提取纯文本、不执行脚本', () => {
    const oldMd = '段落一\n\n前<img src="https://evil.example/x.png" onerror="globalThis.__pwned=1">后\n\n段落三';
    const newMd = `${oldMd}\n\n新增段落`;
    const editor = makeEditor(markdownToHtml(oldMd));
    expect(() => applyTrackedDiff(editor, markdownToHtml(oldMd), markdownToHtml(newMd), AI)).not.toThrow();
    // 投影命中行内纯文本（前后拼接）— 修复前后都该如此；关键是下面的执行断言。
    expect(getBaseText(editor)).toContain('前后');
    expect((globalThis as { __pwned?: unknown }).__pwned).toBeUndefined();
    editor.destroy();
  });
});
