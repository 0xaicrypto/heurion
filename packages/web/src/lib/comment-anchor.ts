import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * #1040 — 评论锚点高亮装饰层(Decoration-only,参照 SectionCardsExtension)。
 *
 * 设计约束(与 #1039 架构决策一致):
 * - 评论锚点绝不进 schema/正文 — markdown↔html round-trip 会吃掉自定义
 *   mark,侧车数据(sidecar)只以 Decoration 叠加渲染;
 * - open 评论按服务端定位诊断渲染:located=true 实心高亮;漂移(located=
 *   false)时用返回的最近候选兜底渲染「待重新定位」提示态 — 不静默消失
 *   也不报错;
 * - resolved 评论由前端在正文里重定位,渲染置灰高亮(线程完结的弱提示);
 * - 点击高亮 → data.onAnchorClick(commentId) 通知侧边栏定位/展开线程。
 */

export interface CommentAnchorCandidate {
  text: string;
  similarity?: number;
}

export interface CommentAnchorItem {
  commentId: string;
  anchorText: string;
  /** 'open' | 'resolved' — resolved 渲染置灰。 */
  status: string;
  /** 服务端定位诊断(仅 open 评论附带;resolved 由前端重定位)。 */
  located: boolean;
  /** #1039 漂移诊断 — located=false 时的最近候选(按相似度降序)。 */
  candidates?: CommentAnchorCandidate[];
}

export interface CommentAnchorsData {
  items: CommentAnchorItem[];
  /** 当前激活线程 — 对应高亮加 active 描边(与侧边栏联动)。 */
  activeCommentId?: string | null;
  /** 点击高亮回调 — 侧边栏滚动定位并展开对应线程。 */
  onAnchorClick?: (commentId: string) => void;
}

interface PluginState {
  data: CommentAnchorsData;
  decorations: DecorationSet;
}

const stateKey = new PluginKey<PluginState>('commentAnchors');

interface DocTextIndex {
  /** 全文拼接文本(块间以 \n 分隔)。 */
  text: string;
  /** posAt[i] = text 第 i 个字符的 ProseMirror 位置;-1 = 块边界分隔符。 */
  posAt: number[];
}

/** 拼接文档纯文本并记录字符级位置映射(decoration 用 PM 位置,不是 body 偏移)。 */
function buildDocTextIndex(doc: PMNode): DocTextIndex {
  let text = '';
  const posAt: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText) {
      const s = node.text ?? '';
      for (let i = 0; i < s.length; i++) {
        // #1056:descendants 传给 text 节点的 pos 就是首字符位置(<p>abc</p> 里 text pos=1),
        // 此前 +1 使高亮整体右移一位(首字符漏亮、尾部多吞一字符)。
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

/** 归一化(空白折叠 + 忽略大小写,与服务端归一化匹配同口径)并保留 norm 索引 → 原始索引映射。 */
function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let lastWasSpace = true; // 头部空白丢弃
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        norm += ' ';
        map.push(i);
        lastWasSpace = true;
      }
      continue;
    }
    norm += ch.toLowerCase();
    map.push(i);
    lastWasSpace = false;
  }
  while (norm.endsWith(' ')) {
    norm = norm.slice(0, -1);
    map.pop();
  }
  return { norm, map };
}

/** 在文档文本中定位 needle(归一化匹配)→ [from, to) PM 位置;命中块边界分隔符时放弃(跨块 inline decoration 非法)。 */
function locateSpan(hay: { norm: string; map: number[] }, index: DocTextIndex, needle: string): { from: number; to: number } | null {
  const needleNorm = normalizeWithMap(needle).norm;
  if (!needleNorm) return null;
  const at = hay.norm.indexOf(needleNorm);
  if (at < 0) return null;
  const rawStart = hay.map[at];
  const rawEnd = hay.map[at + needleNorm.length - 1];
  if (rawStart === undefined || rawEnd === undefined) return null;
  for (let r = rawStart; r <= rawEnd; r++) {
    if (index.posAt[r] < 0) return null;
  }
  const from = index.posAt[rawStart];
  const to = index.posAt[rawEnd] + 1;
  if (from < 0 || to <= from) return null;
  return { from, to };
}

function buildCommentDecorations(doc: PMNode, data: CommentAnchorsData): DecorationSet {
  if (!data.items || data.items.length === 0) return DecorationSet.empty;
  const index = buildDocTextIndex(doc);
  // 归一化全文一次(不是每条评论一次)— 评论数多时避免 O(n·doc) 重复计算。
  const hay = normalizeWithMap(index.text);
  const decorations: Decoration[] = [];
  for (const item of data.items) {
    if (!item.anchorText) continue;
    if (item.status === 'resolved') {
      // #1040 用例 3:resolved → 置灰高亮(前端重定位,弱提示线程完结)。
      const span = locateSpan(hay, index, item.anchorText);
      if (span) {
        decorations.push(Decoration.inline(span.from, span.to, {
          class: 'comment-anchor comment-anchor-resolved',
          'data-comment-id': item.commentId,
        }));
      }
      continue;
    }
    // open:located 直配;漂移 → 逐个候选兜底(提示态,不静默消失)。
    const needles = item.located ? [item.anchorText] : (item.candidates ?? []).map((c) => c.text);
    for (const needle of needles) {
      const span = locateSpan(hay, index, needle);
      if (!span) continue;
      decorations.push(Decoration.inline(span.from, span.to, {
        class: `comment-anchor${item.located ? '' : ' comment-anchor-pending'}${data.activeCommentId === item.commentId ? ' comment-anchor-active' : ''}`,
        'data-comment-id': item.commentId,
        ...(item.located ? {} : { title: '待重新定位 — 原文已改动' }),
      }));
      break;
    }
  }
  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

/** React 侧下发数据 — dispatch 一个 meta 事务即可重建装饰。 */
export function setCommentAnchors(
  editor: { view: { state: { tr: Transaction }; dispatch: (tr: Transaction) => void } },
  data: CommentAnchorsData,
): void {
  editor.view.dispatch(editor.view.state.tr.setMeta(stateKey, data));
}

export const CommentAnchorExtension = Extension.create({
  name: 'commentAnchors',
  addProseMirrorPlugins() {
    return [
      new Plugin<PluginState>({
        key: stateKey,
        state: {
          init: () => ({ data: { items: [] }, decorations: DecorationSet.empty }),
          apply: (tr, prev) => {
            const data = tr.getMeta(stateKey) as CommentAnchorsData | undefined;
            if (data !== undefined) {
              return { data, decorations: buildCommentDecorations(tr.doc, data) };
            }
            // 文档变化 → 装饰位置失效,按当前 doc + 现有数据重建(高亮贴合)。
            if (tr.docChanged) {
              return { data: prev.data, decorations: buildCommentDecorations(tr.doc, prev.data) };
            }
            return prev;
          },
        },
        props: {
          decorations: (state) => stateKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
        // #1040 用例 2:点击高亮 → 通知侧边栏定位/展开对应线程。
        // 用 view.dom 事件委托而非 props.handleClick — 后者依赖
        // posAtCoords 坐标计算(无布局环境/极端嵌套下不可靠),委托把
        // 判定留在 DOM 侧,浏览器与无布局环境同一路径。
        view: (view) => {
          const onClick = (event: Event) => {
            const el = (event.target as HTMLElement | null)?.closest?.('[data-comment-id]') as HTMLElement | null;
            if (!el) return;
            const data = stateKey.getState(view.state)?.data;
            const id = el.getAttribute('data-comment-id');
            if (id && data?.onAnchorClick) data.onAnchorClick(id);
          };
          view.dom.addEventListener('click', onClick);
          return {
            destroy: () => view.dom.removeEventListener('click', onClick),
          };
        },
      }),
    ];
  },
});
