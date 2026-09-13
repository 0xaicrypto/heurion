import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { diffLines } from 'diff';
import type { BlockProjection, SectionMetaMap } from '@heurion/contracts';

/**
 * #996/#1002 — 节卡片化画布的装饰层。
 *
 * 设计（WRITING_MODULE_REDESIGN 二节）：文档 = 一串节卡片（描边 + 标题徽标 +
 * 作者/可信度标签 + 折叠 chevron），AI 编辑中卡片蓝框高亮 + 行内迷你 diff。
 *
 * 实现约束与决策：
 * - 卡片 chrome 用 ProseMirror decoration 呈现（不拆编辑器、不改 markdown
 *   往返与 #837 块结构不变量）；真相源翻转（#994）Go 后可换原生块寻址。
 * - 零服务端哈希复制（与 web/src/lib/block-projection.ts 同纪律）：编辑器
 *   标题 → 投影 section 用 (标题文本, 文档序) 对位；投影缺失/标题已改时
 *   降级为 fallback 键（徽标消失，chrome 保留）。
 * - 流式迷你 diff 由调用方预计算后传入，本层只渲染 — 块级 widget 挂在标题
 *   之后，不触碰编辑器内容，与 #837 三路合并/审阅互不踩踏。
 * - 折叠态由 DocEditor 持有（React state），经数据下行（onToggleCollapse 回调
 *   → setState → 重新 dispatch），widget 重渲染跟随。
 */

export interface SectionCardRow {
  type: 'add' | 'del';
  text: string;
}

/** 按投影 span 从 body 提取节文本（span 即原文索引，服务端同帧保证一致）。 */
export function extractSectionText(body: string, projection: BlockProjection | null | undefined, sectionId: string): string | null {
  const node = projection?.nodes.find((n) => n.kind === 'section' && n.id === sectionId);
  if (!node) return null;
  const start = Math.max(0, Math.min(node.start ?? 0, body.length));
  const end = Math.max(start, Math.min(node.end ?? start, body.length));
  return body.slice(start, end);
}

/** 行级迷你 diff — 只保留增删行（cap 截断，前端 mini diff 展示用）。 */
export function lineDiffRows(before: string, after: string, cap = 40): SectionCardRow[] {
  const rows: SectionCardRow[] = [];
  for (const part of diffLines(before, after)) {
    if (!part.added && !part.removed) continue;
    const lines = part.value.replace(/\n$/, '').split('\n');
    for (const line of lines) {
      if (rows.length >= cap) return rows;
      rows.push({ type: part.added ? 'add' : 'del', text: line });
    }
  }
  return rows;
}

export interface SectionCardsData {
  /** 服务端投影（最新一帧，文档序）— 标题对位用。 */
  projection?: import('@heurion/contracts').BlockProjection | null;
  /** 节级作者/可信度徽标（缺失不渲染徽标）。 */
  meta?: SectionMetaMap;
  /** AI 正在编辑的 section id 列表（蓝框高亮 + mini diff 渲染开关）。 */
  editingIds?: string[];
  /** 流式迷你 diff 行（键 = section id，仅编辑中的节渲染）。 */
  diffRows?: Record<string, SectionCardRow[]>;
  /** 折叠中的 section key 集合。 */
  collapsedKeys?: string[];
  /** 折叠切换回调（widget chevron 点击 → DocEditor setState）。 */
  onToggleCollapse?: (key: string) => void;
}

interface PluginState {
  data: SectionCardsData;
  decorations: DecorationSet;
}

const stateKey = new PluginKey<PluginState>('sectionCardsData');

/** 标题内徽标（inline widget）：H 级 + 作者轴 + 可信度轴 + 折叠 chevron。 */
function buildBadgeEl(data: SectionCardsData, sectionId: string, level: number, secMeta: SectionMetaMap[string] | undefined): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'sec-badges';
  wrap.setAttribute('contenteditable', 'false');
  wrap.dataset.secId = sectionId;

  const levelChip = document.createElement('span');
  levelChip.className = 'sec-badge sec-badge-level';
  levelChip.textContent = `H${level}`;
  wrap.appendChild(levelChip);

  if (secMeta) {
    const author = document.createElement('span');
    author.className = `sec-badge sec-badge-author sec-badge-author-${secMeta.author}`;
    author.textContent = secMeta.author === 'ai' ? 'AI' : 'You';
    wrap.appendChild(author);

    const verify = document.createElement('span');
    verify.className = `sec-badge sec-badge-verify sec-badge-verify-${secMeta.verify_status}`;
    verify.textContent =
      secMeta.verify_status === 'verified' ? '✓ Verified'
      : secMeta.verify_status === 'failed' ? '⚠ Failed' : '● Verifying';
    wrap.appendChild(verify);
  }

  const chevron = document.createElement('button');
  chevron.type = 'button';
  chevron.className = 'sec-badge sec-chevron';
  chevron.setAttribute('aria-label', `Toggle section ${sectionId}`);
  chevron.textContent = '▾';
  chevron.addEventListener('mousedown', (e) => e.preventDefault());
  chevron.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    data.onToggleCollapse?.(sectionId);
  });
  wrap.appendChild(chevron);

  if ((data.collapsedKeys ?? []).includes(sectionId)) wrap.classList.add('sec-badges-collapsed');
  return wrap;
}

/** 流式迷你 diff（块级 widget）：红删除线/绿新增行，40 行截断。 */
function buildDiffWidgetEl(rows: SectionCardRow[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'sec-diff';
  wrap.setAttribute('contenteditable', 'false');
  for (const row of rows.slice(0, 40)) {
    const line = document.createElement('div');
    line.className = row.type === 'add' ? 'sec-diff-add' : 'sec-diff-del';
    line.textContent = `${row.type === 'add' ? '+' : '−'} ${row.text}`;
    wrap.appendChild(line);
  }
  if (rows.length > 40) {
    const more = document.createElement('div');
    more.className = 'sec-diff-more';
    more.textContent = `+${rows.length - 40} …`;
    wrap.appendChild(more);
  }
  return wrap;
}

function buildSectionDecorations(doc: PMNode, data: SectionCardsData): DecorationSet {
  const collapsed = new Set(data.collapsedKeys ?? []);
  const editing = new Set(data.editingIds ?? []);
  if (collapsed.size === 0 && editing.size === 0 && !data.meta && !data.diffRows) {
    return DecorationSet.empty;
  }

  const children: Array<{ node: PMNode; pos: number }> = [];
  doc.forEach((node, offset) => children.push({ node, pos: offset }));

  const headings: Array<{ index: number; pos: number; level: number; text: string; nodeSize: number; contentSize: number }> = [];
  children.forEach((c, i) => {
    if (c.node.type.name === 'heading') {
      headings.push({
        index: i,
        pos: c.pos,
        level: Number(c.node.attrs.level ?? 2),
        text: c.node.textContent,
        nodeSize: c.node.nodeSize,
        contentSize: c.node.content.size,
      });
    }
  });

  const sections = (data.projection?.nodes ?? []).filter((n) => n.kind === 'section');
  const decorations: Decoration[] = [];

  headings.forEach((h, hi) => {
    // span：到下一个 level<=自身 的标题（大纲语义，嵌套子节含在父 span 内 —
    // 与服务端 block-projection 的 section span 同口径）。
    let endIdx = children.length;
    for (let j = h.index + 1; j < children.length; j++) {
      const n = children[j].node;
      if (n.type.name === 'heading' && Number(n.attrs.level ?? 2) <= h.level) {
        endIdx = j;
        break;
      }
    }

    // 对位：数量相等按序对位；数量不等（投影过期/标题已改）按文本匹配，
    // 退化同序号；对位失败 → fallback key（chrome 保留、徽标降级）。
    let section: { id: string; heading?: string } | null = null;
    if (sections.length === headings.length) section = sections[hi] ?? null;
    else if (sections.length > 0) {
      section = sections.find((s) => (s.heading ?? '').trim() === h.text.trim()) ?? sections[hi] ?? null;
    }
    const sectionId = section?.id ?? `h_${hi}`;
    const secMeta = section ? data.meta?.[section.id] : undefined;
    const isEditing = (data.editingIds ?? []).includes(sectionId);
    const isCollapsed = collapsed.has(sectionId);

    for (let i = h.index; i < endIdx; i++) {
      const c = children[i];
      const classes: string[] = [];
      if (endIdx - 1 === h.index) classes.push('sec-top', 'sec-bottom');
      else if (i === h.index) classes.push('sec-top');
      else if (i === endIdx - 1) classes.push('sec-in', 'sec-bottom');
      else classes.push('sec-in');
      if (isEditing) classes.push('sec-editing');
      if (secMeta) classes.push(`sec-author-${secMeta.author}`, `sec-verify-${secMeta.verify_status}`);
      if (isEditing && secMeta?.verify_status === 'failed') classes.push('sec-verify-failed-node');
      if (isCollapsed && i > h.index) classes.push('sec-collapsed');
      decorations.push(Decoration.node(c.pos, c.pos + c.node.nodeSize, { class: classes.join(' ') }));
    }

    // 标题内徽标（inline widget，紧随标题文本之后）。
    decorations.push(Decoration.widget(
      h.pos + 1 + h.contentSize,
      buildBadgeEl(data, sectionId, h.level, secMeta),
      { side: 10, ignoreSelection: true },
    ));

    // 流式迷你 diff（块级 widget，标题与正文之间 — 与截图一致的位置）。
    const rows = isEditing ? data.diffRows?.[sectionId] : undefined;
    if (rows && rows.length > 0) {
      decorations.push(Decoration.widget(
        h.pos + h.nodeSize,
        buildDiffWidgetEl(rows),
        { side: -1, ignoreSelection: true },
      ));
    }
  });

  return DecorationSet.create(doc, decorations);
}

/** React 侧下发数据 — dispatch 一个 meta 事务即可重建装饰。 */
export function setSectionCards(
  editor: { view: { state: { tr: Transaction }; dispatch: (tr: Transaction) => void } },
  data: SectionCardsData,
): void {
  editor.view.dispatch(editor.view.state.tr.setMeta(stateKey, data));
}

export const SectionCardsExtension = Extension.create({
  name: 'sectionCards',
  addProseMirrorPlugins() {
    return [
      new Plugin<PluginState>({
        key: stateKey,
        state: {
          init: () => ({ data: {}, decorations: DecorationSet.empty }),
          apply: (tr, prev) => {
            const data = tr.getMeta(stateKey) as SectionCardsData | undefined;
            if (data !== undefined) {
              return { data, decorations: buildSectionDecorations(tr.doc, data) };
            }
            // 文档变化 → 装饰位置失效，按当前 doc + 现有数据重建（chrome 贴合）。
            if (tr.docChanged) {
              return { data: prev.data, decorations: buildSectionDecorations(tr.doc, prev.data) };
            }
            return prev;
          },
        },
        props: {
          decorations: (state) => stateKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
      }),
    ];
  },
});
