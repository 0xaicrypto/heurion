import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { assignCitationNumbers, CITE_SHORTCODE_PATTERN } from '@heurion/contracts';
import i18n from '../i18n';
import type { DocCitationWire } from './api';

/**
 * #1077 — 正文引用 shortcode 渲染层(Decoration-only,参照 comment-anchor.ts)。
 *
 * 设计约束(与 #1039/#1040 架构决策一致):
 * - `[cite:<id>]` shortcode 是文档纯文本契约 — 绝不进 schema/mark,否则
 *   markdown↔html round-trip 会吃掉它(worker 导出 #1099 按纯文本解析)。
 *   渲染分两层:inline decoration 包裹原 shortcode(保留原文可选中/可编辑,
 *   仅视觉弱化)+ widget decoration 在其前方渲染 `[n]` 编号徽标。
 * - 编号由 contracts 的 assignCitationNumbers 统一计算(按首次出现顺序),
 *   与 References 列表(#1078)/worker 导出(#1099)同源,禁止前端另算。
 * - 悬挂引用(id 不在 citations 列表)渲染警示态 badge `[?]` + 说明 title,
 *   不静默消失(与 #1081 悬挂横幅同口径)。
 * - 点击徽标/shortcode → data.onCitationClick(citationId) 通知路由层弹
 *   文献详情预览。
 *
 * #1077-性能:与锚点(#1074-5 增量 map+重扫)不同,shortcode 命中是**精确
 * 索引匹配**(无归一化/消歧语义),docChanged 全量重建 = O(doc) 一次正则 +
 * 一次编号 map,量级与 section-cards 的重建同阶;增量 map 维护 widget/inline
 * 双 decoration 的正确性验证复杂度远超重建本身,故每次 docChanged 直接重建
 * (权衡:长文档高频击键下有固定 O(doc) 成本,可接受;如成瓶颈再引入
 * map+失效区间重扫)。
 */

export interface CitationViewData {
  /** 文献元数据查询表(id → DocCitationWire);不在表内的 id 按悬挂渲染。 */
  citations: DocCitationWire[];
  /** 点击引用徽标回调 — 路由层弹文献详情预览(#1077)。 */
  onCitationClick?: (citationId: string) => void;
}

interface PluginState {
  data: CitationViewData;
  decorations: DecorationSet;
}

const stateKey = new PluginKey<PluginState>('citationView');

/** 空数据模块级常量 — 避免内联对象身份抖动(EMPTY_COMMENTS 同款教训)。 */
export const EMPTY_CITATION_VIEW: CitationViewData = { citations: [] };

interface DocTextIndex {
  /** 全文拼接文本(块间以 \n 分隔)。 */
  text: string;
  /** posAt[i] = text 第 i 个字符的 ProseMirror 位置;-1 = 块边界分隔符。 */
  posAt: number[];
}

/**
 * 拼接文档纯文本并记录字符级位置映射 — 与 comment-anchor.ts 的
 * buildDocTextIndex 同语义(未导出,此处镜像实现;两处必须保持一致口径)。
 */
function buildDocTextIndex(doc: PMNode): DocTextIndex {
  let text = '';
  const posAt: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText) {
      const s = node.text ?? '';
      for (let i = 0; i < s.length; i++) {
        // descendants 传给 text 节点的 pos 就是首字符位置(#1056 同款修正)。
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

/** 已知文献的 title 提示串 — 元数据拼装(空字段跳过,不留空壳括号)。 */
function knownCitationTitle(c: DocCitationWire, n: number): string {
  const authors = c.authors?.length ? c.authors.join(', ') : '';
  const parts = [
    authors,
    c.journal ?? '',
    c.year != null ? String(c.year) : '',
    c.doi ? `doi:${c.doi}` : '',
  ].filter(Boolean);
  return i18n.t('writing.citationBadgeTitle', '引用 {{n}}：{{detail}}', { n, detail: `${c.title}${parts.length ? `(${parts.join(' · ')})` : ''}` });
}

/**
 * #1077: 按数据全量重建装饰(初始化/meta 下发/docChanged 共用)。
 * 编号全篇一次(assignCitationNumbers 首现顺序),逐命中产出:
 * - widget(side:-1)`[n]`/`[?]` 徽标(渲染在 shortcode 之前);
 * - inline decoration 包裹原 shortcode(原文本保留,视觉弱化由 CSS 承担)。
 */
export function buildAllCitationDecorations(doc: PMNode, data: CitationViewData): DecorationSet {
  const index = buildDocTextIndex(doc);
  const matches = [...index.text.matchAll(CITE_SHORTCODE_PATTERN)];
  if (matches.length === 0) return DecorationSet.empty;
  // 编号全篇一次 — 与 References 列表/worker 导出同源(assignCitationNumbers)。
  const numbers = assignCitationNumbers(index.text);
  const known = new Map((data.citations ?? []).map((c) => [c.id, c]));
  const decorations: Decoration[] = [];
  for (const m of matches) {
    const id = m[1];
    const rawStart = m.index ?? -1;
    const rawEnd = rawStart + m[0].length - 1;
    if (rawStart < 0) continue;
    const from = index.posAt[rawStart];
    const to = index.posAt[rawEnd] + 1;
    // shortcode 跨块边界(理论上不会发生,防御)或位置非法 → 放弃该命中。
    if (from < 0 || to <= from || index.posAt[rawEnd] < 0) continue;
    const citation = known.get(id);
    if (citation) {
      const n = numbers.get(id) ?? 0;
      decorations.push(
        Decoration.widget(from, () => {
          const span = document.createElement('span');
          span.className = 'citation-badge-widget';
          span.setAttribute('data-citation-id', id);
          span.setAttribute('data-citation-number', String(n));
          span.contentEditable = 'false';
          span.textContent = `[${n}]`;
          return span;
        }, { side: -1, key: `cite-${id}-${n}` }),
        Decoration.inline(from, to, {
          class: 'citation-badge citation-raw',
          'data-citation-id': id,
          title: knownCitationTitle(citation, n),
        }, { citationId: id }),
      );
    } else {
      // #1077: 悬挂引用 — 警示态(与 #1081 横幅 warning 同色系),不静默。
      decorations.push(
        Decoration.widget(from, () => {
          const span = document.createElement('span');
          span.className = 'citation-dangling-widget';
          span.setAttribute('data-citation-id', id);
          span.contentEditable = 'false';
          span.textContent = '[?]';
          return span;
        }, { side: -1, key: `cite-dangling-${id}` }),
        Decoration.inline(from, to, {
          class: 'citation-dangling citation-raw',
          'data-citation-id': id,
          title: i18n.t('writing.citationDanglingBadge', '未解析的引用标记 — 未找到对应文献记录'),
        }, { citationId: id }),
      );
    }
  }
  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

/** React 侧下发数据 — dispatch 一个 meta 事务即可重建装饰。 */
export function setCitationView(
  editor: { view: { state: { tr: Transaction }; dispatch: (tr: Transaction) => void } },
  data: CitationViewData,
): void {
  editor.view.dispatch(editor.view.state.tr.setMeta(stateKey, data));
}

export const CitationViewExtension = Extension.create({
  name: 'citationView',
  addProseMirrorPlugins() {
    return [
      new Plugin<PluginState>({
        key: stateKey,
        state: {
          init: () => ({ data: EMPTY_CITATION_VIEW, decorations: DecorationSet.empty }),
          apply: (tr, prev) => {
            const data = tr.getMeta(stateKey) as CitationViewData | undefined;
            if (data !== undefined) {
              // meta 下发(初始化/数据更新) = 全量重建。
              return { data, decorations: buildAllCitationDecorations(tr.doc, data) };
            }
            if (tr.docChanged) {
              // #1077-性能:docChanged 全量重建(O(doc) 正则 + 编号) — 权衡
              // 见文件头注释;shortcode 精确匹配无需锚点式增量维护。
              return { data: prev.data, decorations: buildAllCitationDecorations(tr.doc, prev.data) };
            }
            return prev;
          },
        },
        props: {
          decorations: (state) => stateKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
        // #1077: 点击徽标/shortcode → 通知路由层弹文献详情预览。
        // 用 view.dom 事件委托而非 props.handleClick — 与 comment-anchor
        // 同款理由(无布局环境下 posAtCoords 不可靠,委托把判定留在 DOM 侧)。
        view: (view) => {
          const onClick = (event: Event) => {
            const el = (event.target as HTMLElement | null)?.closest?.('[data-citation-id]') as HTMLElement | null;
            if (!el) return;
            const data = stateKey.getState(view.state)?.data;
            const id = el.getAttribute('data-citation-id');
            if (id && data?.onCitationClick) data.onCitationClick(id);
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
