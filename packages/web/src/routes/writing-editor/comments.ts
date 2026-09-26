/**
 * #1040/#1089-6: 文档评论状态机 hook — 评论线程列表/面板状态/选区提交/
 * deck 评论/回复/resolved，以及锚点采纳态与「待确认位置」派生数据。
 *
 * 从 writing-editor.tsx 抽出（拆分记录: persistence / write-back / comments
 * 三块中的 comments）— 路由只保留编排与布局。行为与抽出前逐行等价:
 * 锚点诊断/采纳与装饰层共用 lib/comment-anchor 同一套定位实现。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { Editor } from '@tiptap/react';
import { findSectionAtOffset, type BlockProjection } from '@heurion/contracts';
import { api, type DocCommentWire } from '@/lib/api';
import { adoptAnchorCandidate, describeAnchorIssues } from '@/lib/comment-anchor';
import type { AnchorConfirmState } from './comments-panel';

/** #1051: 评论草稿判别联合 — 正文选区 { text, from, to } | deck slide 页。 */
export type CommentDraft =
  | { text: string; from: number; to: number }
  | { target: 'deck_slide'; slideIndex0: number; anchorText: string };

export type AnchorAdoption = { text: string; start?: number; hit?: number };

export interface UseDocCommentsInput {
  docId?: string;
  bodyRef: MutableRefObject<string>;
  /** 节引用反查投影（chat 最新写回优先，否则 getDoc 投影）— 事件期读取。 */
  getProjection: () => BlockProjection | null | undefined;
  /** 编辑器实例（非响应式 ref）— 锚点扫描/采纳用。 */
  getEditor: () => Editor | null;
  onNotice: (text: string, ttlMs?: number) => void;
  /** 评论页码上限回退（body markdown 估算）— 事件期读取。 */
  getDeckSlideCountFallback: () => number;
  deckSlideCount: number | null;
  deckAssetSlidesLength?: number;
}

export interface DocCommentsController {
  docComments: DocCommentWire[];
  setDocComments: Dispatch<SetStateAction<DocCommentWire[]>>;
  commentsPanelOpen: boolean;
  setCommentsPanelOpen: Dispatch<SetStateAction<boolean>>;
  activeCommentId: string | null;
  setActiveCommentId: Dispatch<SetStateAction<string | null>>;
  commentDraft: CommentDraft | null;
  setCommentDraft: Dispatch<SetStateAction<CommentDraft | null>>;
  commentSubmitting: boolean;
  submitComment: (text: string) => Promise<void>;
  addDeckComment: () => void;
  replyToComment: (commentId: string, text: string) => Promise<void>;
  toggleCommentResolved: (c: DocCommentWire) => Promise<void>;
  anchorAdoptions: Record<string, AnchorAdoption>;
  setAnchorAdoptions: Dispatch<SetStateAction<Record<string, AnchorAdoption>>>;
  anchorConfirms: Record<string, AnchorConfirmState>;
  handleAdoptAnchorCandidate: (c: DocCommentWire, cand: AnchorAdoption) => void;
  /** 切文档清账 — 旧文档线程/激活态/草稿/锚点采纳不得串染新文档。 */
  resetForDocSwitch: () => void;
}

export function useDocComments(input: UseDocCommentsInput): DocCommentsController {
  const { docId, bodyRef, onNotice } = input;
  const { t } = useTranslation();

  // getter 走 latest-ref（父级内联箭头不进依赖）— 回调身份保持稳定,
  // 与抽出前 useCallback 依赖面等价。
  const getEditorRef = useRef(input.getEditor);
  getEditorRef.current = input.getEditor;
  const getProjectionRef = useRef(input.getProjection);
  getProjectionRef.current = input.getProjection;
  const getDeckFallbackRef = useRef(input.getDeckSlideCountFallback);
  getDeckFallbackRef.current = input.getDeckSlideCountFallback;

  const [docComments, setDocComments] = useState<DocCommentWire[]>([]);
  const [commentsPanelOpen, setCommentsPanelOpen] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [commentSubmitting, setCommentSubmitting] = useState(false);

  // #1089-5/#1089-6: 锚点偏移消费 + 「待确认位置」确认路径。
  // 用户「用此位置」采纳态（commentId → 候选）— 经 items.chosen 下发装饰层
  // （重定位只认采纳的候选），采纳后候选列表收起、歧义徽标随重建消失。
  const [anchorAdoptions, setAnchorAdoptions] = useState<Record<string, AnchorAdoption>>({});
  // 编辑器实例为非响应式 ref — 就绪后 bump 一次触发首扫（徽标/候选列表不因
  // 首扫空窗缺席）；此后 docComments/采纳态变化照常重扫。
  const [anchorEditorTick, setAnchorEditorTick] = useState(0);
  useEffect(() => {
    if (getEditorRef.current()) {
      setAnchorEditorTick((v) => v + 1);
      return;
    }
    const timer = setInterval(() => {
      if (getEditorRef.current()) {
        clearInterval(timer);
        setAnchorEditorTick((v) => v + 1);
      }
    }, 100);
    return () => clearInterval(timer);
  }, []);

  // 侧边栏「待确认位置」数据 — 歧义态经编辑器全文扫描（describeAnchorIssues，
  // 与装饰层同一套定位/消歧/服务端偏移逻辑，不漂移）；漂移态直接用服务端候选。
  const anchorConfirms = useMemo(() => {
    const out: Record<string, AnchorConfirmState> = {};
    const ed = getEditorRef.current();
    const locatedItems = docComments
      .filter((c) => c.status !== 'resolved' && c.target === 'section' && c.anchor?.located !== false && !anchorAdoptions[c.id])
      .map((c) => ({ commentId: c.id, anchorText: c.anchor_text, status: c.status, located: true }));
    const issues = ed && locatedItems.length > 0 ? describeAnchorIssues(ed.state.doc, locatedItems) : {};
    for (const c of docComments) {
      if (c.status === 'resolved' || c.target !== 'section') continue;
      const issue = issues[c.id];
      if (issue) {
        out[c.id] = { kind: 'ambiguous', candidates: issue.candidates };
        continue;
      }
      const driftCands = c.anchor?.located === false ? c.anchor.candidates : undefined;
      if (driftCands && driftCands.length > 0 && !anchorAdoptions[c.id]) {
        out[c.id] = { kind: 'drift', candidates: driftCands.map((x) => ({ text: x.text, heading: x.heading, start: x.start })) };
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 编辑器 ref 非响应式（anchorEditorTick 就绪触发重扫）
  }, [docComments, anchorAdoptions, anchorEditorTick]);

  /** #1089-6: 「用此位置」— 以候选重定位（显式 span/记忆注入）+ 采纳态记录。 */
  const handleAdoptAnchorCandidate = useCallback((c: DocCommentWire, cand: AnchorAdoption) => {
    const ed = getEditorRef.current();
    if (!ed) return;
    const span = adoptAnchorCandidate(ed.state.doc, c.id, cand, bodyRef.current);
    if (!span) {
      onNotice(t('writing.commentAnchorAdoptFailed', '未能在正文中定位该候选，请稍后重试'), 4000);
      return;
    }
    setAnchorAdoptions((prev) => ({ ...prev, [c.id]: cand }));
    setActiveCommentId(c.id);
  }, [onNotice, t, bodyRef]);

  // #1040: 评论列表 — 文档挂载后拉取(resolved/漂移诊断都以服务端为准)。
  // 拉取失败不打扰(侧边栏空态),下次操作后重拉。
  const loadComments = useCallback(() => {
    if (!docId) return;
    // #1064: 诊断懒计算 — 评论面板需要锚点定位状态,显式 with_anchor=1。
    api.listDocComments(docId, { with_anchor: true })
      .then((r) => setDocComments(r.comments))
      .catch(() => {});
  }, [docId]);
  useEffect(() => {
    loadComments();
  }, [loadComments]);

  // #1040: 提交选区评论 — 选区文字作 anchorText,节引用反查与「选中即引用」
  // 同口径(投影缺失降级 'doc');本地乐观插入(located=true,刚创建必可定位)。
  // #1051: deck slide 评论 — anchorText=页标题,锚点判别字段 target/slide_index
  // (1-based)随创建请求上行,走同一套侧边栏线程(不建两套评论 UI)。
  const submitComment = async (text: string) => {
    if (!docId || !commentDraft) return;
    setCommentSubmitting(true);
    try {
      let created: DocCommentWire;
      if ('target' in commentDraft) {
        created = await api.createDocComment(docId, {
          target: 'deck_slide',
          slide_index: commentDraft.slideIndex0 + 1,
          anchor_text: commentDraft.anchorText,
          text,
        });
      } else {
        const anchorText = commentDraft.text;
        const proj = getProjectionRef.current();
        const offset = bodyRef.current.indexOf(anchorText.slice(0, 80));
        const sec = proj && offset >= 0 ? findSectionAtOffset(proj, offset) : null;
        created = await api.createDocComment(docId, { section_id: sec?.id ?? 'doc', anchor_text: anchorText, text });
      }
      setDocComments((prev) => [...prev, { ...created, anchor: { located: true } }]);
      setActiveCommentId(created.id);
      setCommentsPanelOpen(true);
      setCommentDraft(null);
    } catch {
      onNotice(t('writing.commentCreateFailed', '评论提交失败，请重试'), 4000);
    } finally {
      setCommentSubmitting(false);
    }
  };

  /** #1112: deck 评论创建 — 卡片流退役后从画布头部提供（页码输入 → 侧边栏线程）。
   *  #review-9: 页码上限按画布真实页数校验 — 超页会产生永远定位不到的悬挂评论。 */
  const addDeckComment = useCallback(() => {
    const raw = window.prompt(t('writing.deckCommentSlidePrompt', '为第几页添加评论？（1 开始的页码）'));
    if (raw === null) return;
    const n = parseInt(raw, 10);
    const maxSlides = input.deckSlideCount ?? input.deckAssetSlidesLength ?? getDeckFallbackRef.current();
    if (!Number.isFinite(n) || n < 1) {
      onNotice(t('writing.deckCommentSlideInvalid', '页码无效'), 4000);
      return;
    }
    if (n > maxSlides) {
      onNotice(t('writing.deckCommentSlideOutOfRange', '页码超出范围：当前共 {{n}} 页', { n: maxSlides }), 4000);
      return;
    }
    setCommentDraft({ target: 'deck_slide', slideIndex0: n - 1, anchorText: t('writing.deckSlideLabel', '第 {{n}} 页', { n }) });
  }, [onNotice, t, input.deckSlideCount, input.deckAssetSlidesLength]);

  // #1040: 追加回复 — 本地按时间序插入线程。
  const replyToComment = async (commentId: string, text: string) => {
    if (!docId) return;
    try {
      const reply = await api.createDocCommentReply(docId, commentId, { role: 'user', text });
      setDocComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, replies: [...c.replies, reply] } : c)));
    } catch {
      onNotice(t('writing.commentReplyFailed', '回复发送失败，请重试'), 4000);
    }
  };

  // #1040: resolved/reopen — PATCH 后重拉列表(锚点诊断以服务端为准)。
  const toggleCommentResolved = async (c: DocCommentWire) => {
    if (!docId) return;
    const next = c.status === 'resolved' ? 'open' : 'resolved';
    try {
      await api.updateDocComment(docId, c.id, next);
      const r = await api.listDocComments(docId, { with_anchor: true });
      setDocComments(r.comments);
    } catch {
      onNotice(t('writing.commentUpdateFailed', '评论状态更新失败，请重试'), 4000);
    }
  };

  const resetForDocSwitch = useCallback(() => {
    setDocComments([]);
    setActiveCommentId(null);
    setCommentDraft(null);
    setAnchorAdoptions({});
  }, []);

  return {
    docComments,
    setDocComments,
    commentsPanelOpen,
    setCommentsPanelOpen,
    activeCommentId,
    setActiveCommentId,
    commentDraft,
    setCommentDraft,
    commentSubmitting,
    submitComment,
    addDeckComment,
    replyToComment,
    toggleCommentResolved,
    anchorAdoptions,
    setAnchorAdoptions,
    anchorConfirms,
    handleAdoptAnchorCandidate,
    resetForDocSwitch,
  };
}
