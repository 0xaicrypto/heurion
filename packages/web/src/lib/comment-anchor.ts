import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import i18n from '../i18n';

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
 *
 * #1071-2 — 锚点歧义消歧:归一化全文首次命中(indexOf)在重复文本场景下会
 * 静默定位到语义无关处。现在:
 * - 多命中时优先「距上次定位最近」(按 commentId 记忆最近一次确认的区间,
 *   就近消歧 — 编辑后的"原地小漂移"不再跳位);
 * - 无消歧上下文(首次渲染/并列最近)时不再静默取首个 — 全部命中渲染歧义
 *   提示态(高亮不灭 + title 说明多处匹配),定位决策显式化,配合侧边栏处理;
 * - #1093: 歧义与漂移视觉分离 — 歧义下发独立 class comment-anchor-ambiguous
 *   (虚线描边),漂移保持 comment-anchor-pending(警示实底),用户动作不同
 *   （歧义=确认位置,漂移=重定位）从正文即可区分;
 * - 跨块/跨 decoration 非法区间照旧放弃。
 *
 * #1074-5 — 增量维护:docChanged 时先 DecorationSet.map() 平移迁移既有
 * decoration,再对「映射后文本不再匹配锚点」的评论按全文重扫(单评论粒度
 * 兜底);无 decoration 的评论在有插入发生时同样重扫(新文本可能首次命中)。
 * 全量重扫保留为初始化(meta 下发)与 map 后命中失效的兜底,不再是每次
 * 编辑的固定成本。
 */

export interface CommentAnchorCandidate {
  text: string;
  similarity?: number;
  /**
   * #1089-5: 服务端候选在 markdown 正文中的起点偏移（closestTextCandidates
   * 的 raw body offset — 候选窗口首行去首部空白后的绝对下标）。装饰层按
   * 归一化前缀就近消费（见 nearestSpanToServerOffset），重扫多命中不再
   * 误判歧义。
   */
  start?: number;
  /** #1089-5: 服务端候选的所属标题摘要（侧边栏候选列表展示用）。 */
  heading?: string;
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
  /**
   * #1089-6: 用户「用此位置」显式采纳的候选 — 重定位只认它（候选序自动
   * 落位被覆盖）；多命中时消歧记忆（adoptAnchorCandidate 写入）钉住所选
   * 命中。hit = 歧义态命中的出现序（编辑器扫描，无服务端偏移可用）。
   */
  chosen?: { text: string; start?: number; hit?: number };
}

export interface CommentAnchorsData {
  items: CommentAnchorItem[];
  /**
   * #1089-5: markdown 正文 — 服务端候选 start 偏移的对齐基准（与编辑器
   * 文本同用 normalizeWithMap 归一化，前缀长度就近比较）。
   */
  bodyText?: string;
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
  /** #严重-9: posAt 的单调搜索副本 — 哨兵(-1)被替换为后继文本字符的 PM
   *  位置（无后继则 +∞），恢复非降序后二分查找才成立。posAt 本身因哨兵
   *  先升后降到 -1 再升，直接二分会跳段取错（见 rawIndexAtPmPos）。 */
  posAtSearch: number[];
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
  return { text, posAt, posAtSearch: buildPosAtSearch(posAt) };
}

/**
 * #严重-9: 由 posAt 构建单调（非降序）搜索副本。块边界哨兵 -1 本身不是 PM
 * 位置，但它在 text 里对应一个 '\n' 字符 — 用「后继有效位置」作它的搜索
 * 键，即把边界映射到其后的首个字符（末尾边界 → +∞）。这样二分查找的单调
 * 前提恢复，且返回值仍可安全用作 text 下标（落点可能是边界 '\n'）。
 */
export function buildPosAtSearch(posAt: ArrayLike<number>): number[] {
  const out = new Array<number>(posAt.length);
  let nextValid = Number.POSITIVE_INFINITY;
  for (let i = posAt.length - 1; i >= 0; i--) {
    if (posAt[i] >= 0) nextValid = posAt[i];
    out[i] = nextValid;
  }
  return out;
}

/** 归一化(空白折叠 + 忽略大小写,与服务端归一化匹配同口径)并保留 norm 索引 → 原始索引映射。 */
export function normalizeWithMap(s: string): { norm: string; map: number[] } {
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

/** PM 区间(候选命中处)。 */
export interface AnchorSpan { from: number; to: number }

/**
 * 在文档文本中定位 needle 的全部归一化命中(#1071-2:此前只取首个 indexOf)
 * → [from, to) PM 位置列表;命中块边界分隔符的单次命中放弃(跨块 inline
 * decoration 非法)但继续尝试后续命中(不再整体放弃)。
 */
export function locateAllSpans(hay: { norm: string; map: number[] }, index: DocTextIndex, needle: string): AnchorSpan[] {
  const needleNorm = normalizeWithMap(needle).norm;
  if (!needleNorm) return [];
  const spans: AnchorSpan[] = [];
  let at = 0;
  for (;;) {
    const i = hay.norm.indexOf(needleNorm, at);
    if (i < 0) break;
    at = i + 1;
    const rawStart = hay.map[i];
    const rawEnd = hay.map[i + needleNorm.length - 1];
    if (rawStart === undefined || rawEnd === undefined) continue;
    let blocked = false;
    for (let r = rawStart; r <= rawEnd; r++) {
      if (index.posAt[r] < 0) { blocked = true; break; }
    }
    if (blocked) continue;
    const from = index.posAt[rawStart];
    const to = index.posAt[rawEnd] + 1;
    if (from < 0 || to <= from) continue;
    spans.push({ from, to });
  }
  return spans;
}

/** #1071-2: commentId → 最近一次确认的定位区间(就近消歧上下文)。 */
const lastAnchorSpans = new Map<string, AnchorSpan>();
/** 容量上界 — 评论删除/切文档后残留条目不无限累积。 */
const LAST_SPAN_CAP = 512;
function rememberAnchorSpan(commentId: string, span: AnchorSpan): void {
  if (lastAnchorSpans.size >= LAST_SPAN_CAP) {
    const oldest = lastAnchorSpans.keys().next().value;
    if (oldest !== undefined) lastAnchorSpans.delete(oldest);
  }
  lastAnchorSpans.set(commentId, span);
}

export interface ResolvedAnchor {
  /** 消歧后的唯一命中(歧义/零命中为 null)。 */
  span: AnchorSpan | null;
  /** true = 多命中且无法消歧 — 不静默取首个,渲染歧义提示态。 */
  ambiguous: boolean;
  /** 全部命中(ambiguous 时逐个渲染提示态)。 */
  all: AnchorSpan[];
}

/**
 * #1071-2: 多命中消歧 — 「距上次定位最近」优先(距离唯一最小才取;并列视作
 * 歧义,不猜);无记忆上下文或就近并列时标记 ambiguous(调用方按歧义提示态
 * 渲染,#1093 起独立 class 与漂移区分),绝不静默取首个。
 */
export function resolveAnchorSpans(commentId: string, spans: AnchorSpan[]): ResolvedAnchor {
  if (spans.length === 0) return { span: null, ambiguous: false, all: spans };
  if (spans.length === 1) {
    rememberAnchorSpan(commentId, spans[0]);
    return { span: spans[0], ambiguous: false, all: spans };
  }
  const last = lastAnchorSpans.get(commentId);
  if (last) {
    let best: AnchorSpan | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    let tie = false;
    for (const s of spans) {
      const d = Math.abs(s.from - last.from) + Math.abs(s.to - last.to);
      if (d < bestDist) { bestDist = d; best = s; tie = false; }
      else if (d === bestDist) tie = true;
    }
    if (best && !tie) {
      rememberAnchorSpan(commentId, best);
      return { span: best, ambiguous: false, all: spans };
    }
  }
  return { span: null, ambiguous: true, all: spans };
}

/** 归一化文本对照 — 增量迁移后逐 span 校验「映射区间下的文本仍是锚点」。 */
function spanTextMatches(doc: PMNode, span: AnchorSpan, needleNorm: string): boolean {
  if (span.from < 0 || span.to > doc.content.size || span.from >= span.to) return false;
  const raw = doc.textBetween(span.from, span.to, '\n');
  return normalizeWithMap(raw).norm === needleNorm;
}

/**
 * #1089-5: raw 字符下标 → 归一化下标（map 严格递增，二分取首个 ≥ raw 的
 * 位置；raw 落在折叠空白/块分隔符内时取其后字符 — 归一化位置近似，漂移
 * 单调不影响就近比较）。
 */
function normIndexAt(map: ArrayLike<number>, raw: number): number {
  let lo = 0;
  let hi = map.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid] >= raw) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * PM 位置 → 文本 raw 下标（二分取首个 ≥ pmPos 的下标）。
 *
 * #严重-9: 输入必须是 `buildPosAtSearch` 产物（非降序）。此前直接对含有
 * 块边界哨兵 -1 的 posAt 二分 — 数组先升后降到 -1 再升，不单调；反例
 * [1,2,3,-1,6,7,8] 搜 2 会返回下标 4（值 6）而非 1，多段落重复文本时评论
 * 会高亮到错误的出现位置。函数导出供回归测试直接钉住哨兵行为。
 */
export function rawIndexAtPmPos(posAtSearch: ArrayLike<number>, pmPos: number): number {
  let lo = 0;
  let hi = posAtSearch.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (posAtSearch[mid] >= pmPos) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * #1089-5: 服务端偏移消费 — 重扫多命中时按「归一化前缀长度」就近选定命中：
 * want = 正文前缀（到服务端 start）的归一化长度；各命中的距离 = 编辑器全文
 * 归一化前缀长度与之的差。两文本的 markdown 标记差异（body 有 ##/**，编辑器
 * 文档无）使前缀长度存在单调漂移，就近比较不受影响 — 消除前端重扫对
 * 服务端「已定位」结果的误判歧义。
 */
export function nearestSpanToServerOffset(
  spans: AnchorSpan[],
  index: DocTextIndex,
  hay: { norm: string; map: number[] },
  serverStart: number,
  bodyText: string,
): AnchorSpan {
  const want = normalizeWithMap(bodyText.slice(0, Math.max(0, serverStart))).norm.length;
  let best = spans[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const s of spans) {
    const raw = rawIndexAtPmPos(index.posAtSearch, s.from);
    const d = Math.abs(normIndexAt(hay.map, raw) - want);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

/** #1089-6: open 线程的单条落位 — 装饰构建与侧边栏 issue 描述同源消费
 *  （候选序 + 消歧记忆 + 服务端偏移，一处逻辑不漂移）。 */
interface OpenAnchorPlacement {
  span: AnchorSpan;
  /** 实际命中的 needle（候选文本或 anchorText）— spec.needle 消费方依赖。 */
  needle: string;
  /** 漂移候选命中（提示态 + 漂移 title）。 */
  drift: boolean;
  /** 歧义态命中（全部命中提示渲染 + ambiguous title）。 */
  ambiguousSpan: boolean;
}

function resolveOpenPlacements(
  item: CommentAnchorItem,
  hay: { norm: string; map: number[] },
  index: DocTextIndex,
  data: CommentAnchorsData,
): OpenAnchorPlacement[] {
  // #1089-6: 用户显式采纳的候选优先 — 重定位只认它（候选序自动落位被覆盖）。
  const cands: Array<{ text: string; start?: number }> = item.chosen
    ? [item.chosen]
    : item.located
      ? [{ text: item.anchorText }]
      : (item.candidates ?? []).map((c) => ({ text: c.text, start: c.start }));
  for (const cand of cands) {
    const resolved = resolveAnchorSpans(item.commentId, locateAllSpans(hay, index, cand.text));
    if (resolved.ambiguous && typeof cand.start === 'number' && data.bodyText) {
      // #1089-5: 服务端候选带精确偏移 — 重扫多命中按偏移就近落位，不再误判
      // 歧义（服务端已定位无歧义的结果被前端重扫推翻，即本分支消灭的缺陷）。
      const span = nearestSpanToServerOffset(resolved.all, index, hay, cand.start, data.bodyText);
      rememberAnchorSpan(item.commentId, span);
      return [{ span, needle: cand.text, drift: !item.located, ambiguousSpan: false }];
    }
    if (resolved.ambiguous) {
      // #1071-2: 歧义 — 全部命中渲染提示态，定位决策显式交给用户。
      return resolved.all.map((span) => ({ span, needle: cand.text, drift: !item.located, ambiguousSpan: true }));
    }
    if (resolved.span) {
      return [{ span: resolved.span, needle: cand.text, drift: !item.located, ambiguousSpan: false }];
    }
    // 零命中 → 尝试下一候选（现状）。
  }
  return [];
}

/**
 * #1093: open 评论单个装饰的渲染 — 全量重建与单评论重扫共用，两处渲染不漂移。
 * 歧义与漂移视觉分离（此前共用 comment-anchor-pending，用户无法从正文区分
 * 「文本找不到了」与「文本多处请确认」）：
 * - 歧义（ambiguousSpan）→ 独立 class `comment-anchor-ambiguous`（警示虚线
 *   描边质感）+ title 引导去侧边栏确认位置；
 * - 漂移（drift）→ 保持 `comment-anchor-pending`（警示实底质感）+ 重定位
 *   title。
 */
function openAnchorDecoration(p: OpenAnchorPlacement, item: CommentAnchorItem, active: boolean): Decoration {
  return Decoration.inline(p.span.from, p.span.to, {
    class: `comment-anchor${p.ambiguousSpan ? ' comment-anchor-ambiguous' : p.drift ? ' comment-anchor-pending' : ''}${active ? ' comment-anchor-active' : ''}`,
    'data-comment-id': item.commentId,
    ...(p.ambiguousSpan
      ? { 'data-ambiguous': 'true', title: i18n.t('writing.commentAnchorAmbiguous', '锚点文本在文档中多处出现 — 点击后在侧边栏确认位置') }
      : p.drift
        ? { title: i18n.t('writing.commentAnchorDrift', '待重新定位 — 原文已改动') }
        : {}),
  }, { commentAnchorId: item.commentId, needle: p.needle });
}

/** 测试与增量路径共用 — 按数据全量重建装饰(初始化/兜底语义)。 */
export function buildAllCommentDecorations(doc: PMNode, data: CommentAnchorsData): DecorationSet {
  if (!data.items || data.items.length === 0) return DecorationSet.empty;
  const index = buildDocTextIndex(doc);
  // 归一化全文一次(不是每条评论一次)— 评论数多时避免 O(n·doc) 重复计算。
  const hay = normalizeWithMap(index.text);
  const decorations: Decoration[] = [];
  for (const item of data.items) {
    if (!item.anchorText) continue;
    if (item.status === 'resolved') {
      // #1040 用例 3:resolved → 置灰高亮(前端重定位,弱提示线程完结)。
      // #1071-2: 多命中同样消歧(就近优先);仍歧义时全部命中置灰渲染 —
      // 弱提示不做「选一个」的猜位,也不静默取首个。
      const resolved = resolveAnchorSpans(item.commentId, locateAllSpans(hay, index, item.anchorText));
      for (const span of resolved.ambiguous ? resolved.all : resolved.span ? [resolved.span] : []) {
        decorations.push(Decoration.inline(span.from, span.to, {
          class: 'comment-anchor comment-anchor-resolved',
          'data-comment-id': item.commentId,
        }, { commentAnchorId: item.commentId, needle: item.anchorText }));
      }
      continue;
    }
    // open:located 直配;漂移 → 逐个候选兜底(提示态,不静默消失)。
    // #1089-5/#1089-6: 落位决策(候选序/消歧记忆/服务端偏移)统一走
    // resolveOpenPlacements — 与侧边栏 issue 描述同源。
    for (const p of resolveOpenPlacements(item, hay, index, data)) {
      // #1093: class/title 统一走 openAnchorDecoration（歧义/漂移视觉分离）。
      decorations.push(openAnchorDecoration(p, item, data.activeCommentId === item.commentId));
    }
  }
  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

/**
 * #1074-5: 增量迁移 — docChanged 时 map() 平移既有 decoration,映射后逐
 * span 校验文本仍匹配锚点(带 needle 的 spec 在 map 中保持);失配评论按
 * 全文重扫(单评论粒度),无可迁移装饰且有插入时全量兜底(新文本可能首次
 * 命中无装饰评论)。纯平移命中零重扫 — 长文档+多评论的编辑不再每次 O(comments·doc)。
 */
export function migrateCommentDecorations(tr: Transaction, prev: PluginState): DecorationSet {
  const doc = tr.doc;
  const items = prev.data.items ?? [];
  const mapped = prev.decorations.map(tr.mapping, doc);
  if (items.length === 0) return DecorationSet.empty;
  const index = buildDocTextIndex(doc);
  const hay = normalizeWithMap(index.text);
  // 是否有内容插入 — 无装饰评论的重扫门槛(纯删除/移动不会产生新命中)。
  let inserted = false;
  for (const map of tr.mapping.maps) {
    map.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      if (newTo > newFrom) inserted = true;
    });
    if (inserted) break;
  }
  const decorations: Decoration[] = [];
  let changed = false;
  for (const item of items) {
    if (!item.anchorText) continue;
    const spansOf = mapped.find(0, doc.content.size, (spec) => spec?.commentAnchorId === item.commentId);
    if (spansOf.length === 0) {
      if (!inserted) continue;
      // 该评论此前无命中 — 插入的新文本可能首次命中,单评论全文重扫兜底。
      changed = true;
      decorations.push(...collectItemDecorations(item, hay, index, prev.data));
      continue;
    }
    // 漂移候选命中与直配命中共用 needle 语义:重扫时按 item 的候选序重定位。
    // 校验:映射区间下文本仍是其 needle(候选场景 needle = 实际命中的候选文本,
    // 经 spec.needle 读取)。
    let allValid = true;
    for (const deco of spansOf) {
      const needle = String((deco.spec as { needle?: string } | null | undefined)?.needle ?? item.anchorText);
      const needleNorm = normalizeWithMap(needle).norm;
      if (!spanTextMatches(doc, { from: deco.from, to: deco.to }, needleNorm)) { allValid = false; break; }
    }
    if (allValid) {
      for (const deco of spansOf) decorations.push(deco);
      continue;
    }
    // 命中失效 → 该评论全文重扫(重扫即重建其歧义消歧决策)。
    changed = true;
    decorations.push(...collectItemDecorations(item, hay, index, prev.data));
  }
  // mapped 里可能残留已不在 items 中的 commentId(数据被替换) — 属 changed。
  const known = new Set(items.map((i) => i.commentId));
  for (const deco of mapped.find()) {
    const id = (deco.spec as { commentAnchorId?: string } | null | undefined)?.commentAnchorId;
    if (id && !known.has(id)) changed = true;
  }
  if (!changed) return mapped;
  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

/** 单评论重扫 — 与 buildAllCommentDecorations 的逐条逻辑同源(定位+消歧+渲染)。 */
function collectItemDecorations(item: CommentAnchorItem, hay: { norm: string; map: number[] }, index: DocTextIndex, data: CommentAnchorsData): Decoration[] {
  const decorations: Decoration[] = [];
  if (item.status === 'resolved') {
    const resolved = resolveAnchorSpans(item.commentId, locateAllSpans(hay, index, item.anchorText));
    for (const span of resolved.ambiguous ? resolved.all : resolved.span ? [resolved.span] : []) {
      decorations.push(Decoration.inline(span.from, span.to, {
        class: 'comment-anchor comment-anchor-resolved',
        'data-comment-id': item.commentId,
      }, { commentAnchorId: item.commentId, needle: item.anchorText }));
    }
    return decorations;
  }
  for (const p of resolveOpenPlacements(item, hay, index, data)) {
    // #1093: class/title 统一走 openAnchorDecoration（歧义/漂移视觉分离）。
    decorations.push(openAnchorDecoration(p, item, data.activeCommentId === item.commentId));
  }
  return decorations;
}

/**
 * #1089-6: 编辑器文档的标题清单 + span 前所属标题（歧义候选的 heading 摘要）。
 */
function collectHeadings(doc: PMNode): Array<{ pos: number; text: string }> {
  const out: Array<{ pos: number; text: string }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading' && node.textContent.trim()) out.push({ pos, text: node.textContent.trim() });
    return true;
  });
  return out;
}

function headingBefore(headings: Array<{ pos: number; text: string }>, from: number): string {
  let hit = '';
  for (const h of headings) {
    if (h.pos >= from) break;
    hit = h.text;
  }
  return hit;
}

export interface AnchorIssueCandidate {
  /** 候选文本 — 歧义态为锚点原文本身（编辑器扫描无替代候选）。 */
  text: string;
  /** 命中之前的最近标题（编辑器文档扫描）。 */
  heading: string;
  /** 同文本命中序（采纳时按它精确选定 — 见 adoptAnchorCandidate）。 */
  hit: number;
}

export interface AnchorIssue {
  candidates: AnchorIssueCandidate[];
}

/**
 * #1089-6: 侧边栏「待确认位置」数据源 — open 且 located 的评论在当前文档
 * 多命中且无法消歧（无就近记忆/并列）时给出候选（命中文本 + 所属标题 +
 * 出现序）。与装饰层同一套定位/消歧逻辑（resolveAnchorSpans 同源）——用户
 * 采纳后消歧记忆钉住所选命中，此处随之不再报告（徽标消失）。
 */
export function describeAnchorIssues(doc: PMNode, items: CommentAnchorItem[]): Record<string, AnchorIssue> {
  const out: Record<string, AnchorIssue> = {};
  if (!items || items.length === 0) return out;
  const index = buildDocTextIndex(doc);
  const hay = normalizeWithMap(index.text);
  const headings = collectHeadings(doc);
  for (const item of items) {
    if (!item.anchorText || item.status === 'resolved' || !item.located || item.chosen) continue;
    const resolved = resolveAnchorSpans(item.commentId, locateAllSpans(hay, index, item.anchorText));
    if (!resolved.ambiguous) continue;
    out[item.commentId] = {
      candidates: resolved.all.map((s, i) => ({ text: item.anchorText, heading: headingBefore(headings, s.from), hit: i })),
    };
  }
  return out;
}

/**
 * #1089-6: 「用此位置」采纳 — 以候选（文本 + 可选服务端 start / 编辑器命中
 * 序 hit）在当前文档重定位，选中 span 记入消歧记忆（显式覆盖入口）；返回
 * 选中的 span，调用方随后以 items.chosen 下发数据重建装饰（侧边栏徽标/
 * 候选列表随之收口）。无命中返回 null（调用方提示，不静默）。
 * 选定优先级：hit（歧义态的显式命中序）> start（服务端偏移就近）> 首个。
 */
export function adoptAnchorCandidate(
  doc: PMNode,
  commentId: string,
  cand: { text: string; start?: number; hit?: number },
  bodyText?: string,
): AnchorSpan | null {
  if (!cand.text) return null;
  const index = buildDocTextIndex(doc);
  const hay = normalizeWithMap(index.text);
  const spans = locateAllSpans(hay, index, cand.text);
  if (spans.length === 0) return null;
  let span = spans[0];
  if (typeof cand.hit === 'number' && spans[cand.hit]) {
    span = spans[cand.hit];
  } else if (spans.length > 1 && typeof cand.start === 'number' && bodyText) {
    span = nearestSpanToServerOffset(spans, index, hay, cand.start, bodyText);
  }
  rememberAnchorSpan(commentId, span);
  return span;
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
              // meta 下发(初始化/数据更新) = 全量重扫 — 消歧决策(含最近位置
              // 记忆)以服务端诊断 + 当前全文为准。
              return { data, decorations: buildAllCommentDecorations(tr.doc, data) };
            }
            // 文档变化 → #1074-5: map() 迁移 + 失效区间(单评论粒度)重扫,
            // 不再每次编辑全文档全评论重算。行为不变:迁移后的命中与全量
            // 重扫同位(校验不过即重扫),既有测试全过为底线。
            if (tr.docChanged) {
              return { data: prev.data, decorations: migrateCommentDecorations(tr, prev) };
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
