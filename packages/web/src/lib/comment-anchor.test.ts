/**
 * #1071-2 锚点歧义消歧 + #1074-5 增量维护 — 单元测试。
 *
 * 纯 model/state 层驱动（prosemirror Schema/EditorState,无 DOM/view 依赖）:
 * - resolveAnchorSpans: 多命中就近消歧/歧义标记(不静默取首个);
 * - migrateCommentDecorations: map() 迁移 + 失效重扫,与全量重扫同位等价
 *   (行为不变底线)。
 */
import { describe, test, expect } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import {
  buildAllCommentDecorations,
  locateAllSpans,
  migrateCommentDecorations,
  normalizeWithMap,
  resolveAnchorSpans,
  type CommentAnchorItem,
} from './comment-anchor';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
  },
});

const para = (text: string) => schema.node('paragraph', null, schema.text(text));
const makeDoc = (...paras: string[]) => schema.node('doc', null, paras.map(para));

/** 文档纯文本按块拼接 + 字符级位置映射(与 buildDocTextIndex 同语义 — 测试侧重建)。 */
function docIndex(doc: PMNode): { text: string; posAt: number[] } {
  let text = '';
  const posAt: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText) {
      const s = node.text ?? '';
      for (let i = 0; i < s.length; i++) {
        posAt.push(pos + i);
        text += s[i];
      }
      return false;
    }
    if (node.isBlock && text.length > 0 && !text.endsWith('\n')) {
      text += '\n';
      posAt.push(-1);
    }
    return true;
  });
  return { text, posAt };
}

function makeItem(fx: { id?: string; anchorText: string; status?: string; located?: boolean; candidates?: Array<{ text: string; similarity?: number }> }): CommentAnchorItem {
  return {
    commentId: fx.id ?? 'c1',
    anchorText: fx.anchorText,
    status: fx.status ?? 'open',
    located: fx.located ?? true,
    ...(fx.candidates ? { candidates: fx.candidates } : {}),
  };
}

const spansOf = (set: ReturnType<typeof buildAllCommentDecorations>) =>
  set.find().map((d) => ({ from: d.from, to: d.to })).sort((a, b) => a.from - b.from);

describe('#1071-2 锚点歧义消歧 — resolveAnchorSpans', () => {
  test('唯一命中 → 直接采用', () => {
    const r = resolveAnchorSpans('u1', [{ from: 5, to: 10 }]);
    expect(r.ambiguous).toBe(false);
    expect(r.span).toEqual({ from: 5, to: 10 });
  });

  test('零命中 → 无 span 非歧义(漂移路径的候选兜底照旧)', () => {
    const r = resolveAnchorSpans('u2', []);
    expect(r.span).toBeNull();
    expect(r.ambiguous).toBe(false);
    expect(r.all).toEqual([]);
  });

  test('多命中且无定位记忆 → ambiguous(全部命中返回,不静默取首个)', () => {
    const spans = [{ from: 0, to: 3 }, { from: 30, to: 33 }, { from: 60, to: 63 }];
    const r = resolveAnchorSpans('u3', spans);
    expect(r.ambiguous).toBe(true);
    expect(r.span).toBeNull();
    expect(r.all).toEqual(spans);
  });

  test('多命中 + 上次定位记忆 → 就近命中胜出(编辑后原地小漂移不跳位)', () => {
    const spans = [{ from: 0, to: 3 }, { from: 30, to: 33 }, { from: 60, to: 63 }];
    // 先在 from=30 处建立记忆(唯一命中路径)。
    resolveAnchorSpans('u4', [{ from: 30, to: 33 }]);
    const r = resolveAnchorSpans('u4', spans);
    expect(r.ambiguous).toBe(false);
    expect(r.span).toEqual({ from: 30, to: 33 });
  });

  test('多命中 + 记忆但距离并列 → 歧义(不猜)', () => {
    resolveAnchorSpans('u5', [{ from: 46, to: 49 }]);
    // {43,46} 与 {49,52} 距记忆各 3+3=6 — 并列 → ambiguous。
    const r = resolveAnchorSpans('u5', [{ from: 43, to: 46 }, { from: 49, to: 52 }]);
    expect(r.ambiguous).toBe(true);
  });
});

describe('#1071-2 locateAllSpans — 全命中扫描', () => {
  const doc = makeDoc('alpha beta', 'beta gamma', 'delta');
  const index = docIndex(doc);
  const hay = normalizeWithMap(index.text);

  test('重复文本返回全部命中(此前只取首个)', () => {
    const spans = locateAllSpans(hay, index, 'beta');
    expect(spans.length).toBe(2);
  });

  test('未命中返回空列表', () => {
    expect(locateAllSpans(hay, index, 'omega')).toEqual([]);
  });
});

describe('#1074-5 增量迁移 — migrateCommentDecorations', () => {
  const ANCHOR = '被评论的句子';
  const item = () => makeItem({ anchorText: ANCHOR });
  const baseDoc = () => makeDoc(`第一段:${ANCHOR}在这里。`, '第二段普通内容。');

  /** 装配:state + 数据 + 初始装饰(全量重建口径)。 */
  function setup(doc = baseDoc()) {
    const state = EditorState.create({ doc });
    const data = { items: [item()] };
    const decorations = buildAllCommentDecorations(state.doc, data);
    return { state, data, decorations };
  }

  test('锚点区间外的纯插入 → 零重扫平移,与全量重扫同位', () => {
    const { state, data, decorations } = setup();
    expect(spansOf(decorations).length).toBe(1);
    const tr = state.tr;
    tr.insert(tr.doc.content.size, para('追加的新段落。'));
    expect(tr.docChanged).toBe(true);
    const migrated = migrateCommentDecorations(tr, { data, decorations });
    // 与全量重扫等价(行为不变底线)。
    expect(spansOf(migrated)).toEqual(spansOf(buildAllCommentDecorations(tr.doc, data)));
    expect(spansOf(migrated).length).toBe(1);
  });

  test('锚点区间内文本被改 → 校验失效触发单评论重扫,装饰丢弃(不再误亮)', () => {
    const { state, data, decorations } = setup();
    const span = spansOf(decorations)[0];
    // 改写锚点区间内部文本(保留首尾) — 映射后区间文本 ≠ 锚点。
    const tr = state.tr;
    tr.replaceWith(span.from + 1, span.to - 1, schema.text('已被改写'));
    const migrated = migrateCommentDecorations(tr, { data, decorations });
    expect(spansOf(migrated)).toEqual(spansOf(buildAllCommentDecorations(tr.doc, data)));
    // 改写后的文本不再含锚点 → 无装饰。
    expect(spansOf(migrated)).toEqual([]);
  });

  test('锚点文本被整体删除 → 装饰移除,不残留旧位置', () => {
    const { state, data, decorations } = setup();
    const span = spansOf(decorations)[0];
    const tr = state.tr;
    tr.delete(span.from, span.to);
    const migrated = migrateCommentDecorations(tr, { data, decorations });
    expect(spansOf(migrated)).toEqual(spansOf(buildAllCommentDecorations(tr.doc, data)));
    expect(spansOf(migrated)).toEqual([]);
  });

  test('无装饰评论 + 有插入 → 单评论重扫兜底(新文本首次命中即亮)', () => {
    const { state } = setup();
    const data = { items: [makeItem({ id: 'cx', anchorText: '尚不存在的内容' })] };
    const prevDecorations = buildAllCommentDecorations(state.doc, data);
    expect(spansOf(prevDecorations)).toEqual([]); // 前置:初始无命中
    const tr = state.tr;
    tr.insert(tr.doc.content.size, para('现在出现了尚不存在的内容。'));
    const migrated = migrateCommentDecorations(tr, { data, decorations: prevDecorations });
    expect(spansOf(migrated)).toEqual(spansOf(buildAllCommentDecorations(tr.doc, data)));
    expect(spansOf(migrated).length).toBe(1);
  });

  test('编辑波及块边界(锚点随删除失配) → 重扫结果与全量一致', () => {
    const { state, data, decorations } = setup();
    const span = spansOf(decorations)[0];
    const tr = state.tr;
    // 删除从锚点尾部跨到第二段内部的区间 — 映射后区间文本失配 → 重扫。
    tr.delete(span.to - 2, span.to + 8);
    const migrated = migrateCommentDecorations(tr, { data, decorations });
    expect(spansOf(migrated)).toEqual(spansOf(buildAllCommentDecorations(tr.doc, data)));
  });
});
