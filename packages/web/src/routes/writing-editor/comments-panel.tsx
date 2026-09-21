import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import { Modal } from '@/components/ui/Modal';
import { cn } from '@/lib/utils';
import type { DocCommentWire } from '@/lib/api';

/**
 * #1040 — 侧边栏评论面板 + 评论创建弹窗。
 *
 * 面板:线程列表(anchorText 摘要 + 回复列表 + 回复输入框);open 线程默认
 * 展开、resolved 置灰收起(可点开);anchorText 漂移(located=false)的线程
 * 展示「待重新定位」徽标,不静默。
 * #1089-6: 歧义/漂移态线程渲染「待确认位置」徽标 + 候选列表(text/heading
 * 摘要)+ 每候选「用此位置」按钮 — 采纳即以该候选重定位(路由调
 * comment-anchor 的显式注入入口),确认路径用户可操作,不只提示。
 * #1088: deck 评论 AI 写回待确认态 — 线程级「确认修改/撤销修改」动作按钮
 * (确认 = PATCH resolved;撤销 = 恢复写回前画布快照),与正文 diff
 * accept/reject 审阅对等。
 * 弹窗:选区评论创建入口(气泡「添加评论」→ 路由持 draft → 本弹窗),提交
 * 由路由调创建 API。
 */

/** #1089-6: 「用此位置」候选 — 漂移态为服务端候选(text/start/heading),
 *  歧义态为编辑器扫描命中(text + 所属标题 + 命中序 hit)。 */
export interface AnchorConfirmCandidate { text: string; heading?: string; start?: number; hit?: number }

/** #1089-6: 线程级锚点确认态 — 歧义(编辑器扫描多命中无法消歧)或漂移(服务端候选)。 */
export interface AnchorConfirmState { kind: 'ambiguous' | 'drift'; candidates: AnchorConfirmCandidate[] }

export function AddCommentModal(input: {
  anchorText: string;
  submitting?: boolean;
  onClose: () => void;
  onSubmit: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const submit = () => {
    const v = text.trim();
    if (!v || input.submitting) return;
    input.onSubmit(v);
  };
  return (
    <Modal open onClose={input.onClose} backdropClose escClose backdropClassName="bg-black/50">
      <div className="m-4 w-full max-w-md rounded-xl border border-border bg-surface-elevated p-6 shadow-xl">
        <h2 className="mb-3 text-lg font-semibold text-text-primary">{t('writing.commentAddTitle', '添加评论')}</h2>
        {/* 锚点预览 — 用户确认评论对象是哪段选区文字。 */}
        <blockquote
          data-testid="comment-anchor-preview"
          className="mb-3 line-clamp-3 border-l-2 border-accent/40 bg-surface px-3 py-2 text-xs italic text-text-secondary"
        >
          {input.anchorText}
        </blockquote>
        <textarea
          autoFocus
          data-testid="comment-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder={t('writing.commentPlaceholder', '写下你的评论…')}
          className="w-full resize-none rounded-md border border-border bg-surface px-2.5 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={input.onClose}>{t('writing.commentCancel', '取消')}</Button>
          <Button size="sm" data-testid="comment-submit" onClick={submit} isLoading={input.submitting} disabled={input.submitting || !text.trim()}>
            {t('writing.commentSubmit', '提交')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function CommentsPanel(input: {
  comments: DocCommentWire[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onReply: (id: string, text: string) => void | Promise<void>;
  onToggleResolve: (c: DocCommentWire) => void | Promise<void>;
  /** #1041: 「请AI处理」— 评论正文作编辑指令走现有 chat 编辑链路（不传则不显示按钮）。 */
  onAiProcess?: (c: DocCommentWire) => void;
  /** #1041: 处理中的评论 id 集合 — 按钮 loading/禁用，防并发二次触发。 */
  processingCommentIds?: Record<string, boolean>;
  /** #1095: 排队位次（commentId → 队列位次）— 处理中按钮的「排队第 n 位」提示。 */
  queuePositions?: Record<string, number>;
  /** #1088: deck 写回待确认态（commentId → { undoable }）— 线程级确认/撤销按钮。 */
  deckConfirming?: Record<string, { undoable: boolean }>;
  /** #1088: 「确认修改」— #1096: 采纳本轮修改（不关闭评论）。 */
  onDeckConfirm?: (id: string) => void;
  /** #1088: 「撤销修改」— 恢复写回前画布快照。 */
  onDeckUndo?: (id: string) => void;
  /** #1089-6: 待确认位置 — 歧义（编辑器扫描命中）或漂移（服务端候选）线程的候选列表。 */
  anchorConfirms?: Record<string, AnchorConfirmState>;
  /** #1089-6: 已采纳的候选（采纳后候选列表收起）。 */
  adoptedAnchors?: Record<string, unknown>;
  /** #1089-6: 「用此位置」采纳 — 路由调 comment-anchor 重定位注入。 */
  onAdoptAnchor?: (c: DocCommentWire, cand: AnchorConfirmCandidate) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const { comments, activeId, onSelect, onReply, onToggleResolve, onAiProcess, processingCommentIds, queuePositions, deckConfirming, onDeckConfirm, onDeckUndo, anchorConfirms, adoptedAnchors, onAdoptAnchor, className } = input;
  // #1095: 评论并行处理 — 各评论独立登记独立 turn，不再全局互斥禁用；
  // 每按钮只禁用自身（防同评论双击），排队中的按钮显示「排队第 n 位」。
  // 展开态覆盖:open 默认展开、resolved 默认收起;用户点开后记为展开。
  const [manualExpand, setManualExpand] = useState<Record<string, boolean>>({});
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replying, setReplying] = useState<string | null>(null);
  // #1040 用例 2:激活线程变化 → 滚动定位(jsdom 无真实滚动,可选链兜底);
  // 收起态(如 resolved)线程被正文高亮点中时自动展开 — 双向联动。
  const activeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!activeId) return;
    setManualExpand((prev) => (prev[activeId] ? prev : { ...prev, [activeId]: true }));
    activeRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [activeId]);

  const isExpanded = (c: DocCommentWire) => manualExpand[c.id] ?? c.status === 'open';
  // open 在前(创建序),resolved 沉底。
  const ordered = [
    ...comments.filter((c) => c.status !== 'resolved'),
    ...comments.filter((c) => c.status === 'resolved'),
  ];
  const openCount = comments.filter((c) => c.status !== 'resolved').length;

  const sendReply = async (id: string) => {
    const text = (replyDrafts[id] ?? '').trim();
    if (!text || replying === id) return;
    setReplying(id);
    try {
      await onReply(id, text);
      setReplyDrafts((prev) => ({ ...prev, [id]: '' }));
    } finally {
      setReplying(null);
    }
  };

  return (
    <aside
      data-testid="comments-panel"
      className={cn('w-72 shrink-0 flex-col border-l border-border bg-surface hidden md:flex', className)}
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium text-text-secondary">
          {t('writing.commentsPanelTitle', '评论')}
          {openCount > 0 ? ` · ${t('writing.commentsOpenCount', '{{n}} 条待处理', { n: openCount })}` : ''}
        </span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {ordered.length === 0 && (
          <p className="mt-6 text-center text-xs leading-relaxed text-text-tertiary">
            {t('writing.commentsEmpty', '暂无评论 — 选中文本后点「添加评论」即可标注')}
          </p>
        )}
        {ordered.map((c) => {
          const expanded = isExpanded(c);
          const active = activeId === c.id;
          // #1040 用例 4:漂移线程 — 「待重新定位」提示态(不静默消失)。
          const drifted = c.status !== 'resolved' && c.anchor?.located === false;
          // #1089-6: 待确认位置 — 歧义态徽标 + 候选列表(漂移态沿用原徽标,同样给候选列表)。
          const confirmState = c.status !== 'resolved' ? anchorConfirms?.[c.id] : undefined;
          const ambiguous = confirmState?.kind === 'ambiguous';
          const adopted = !!adoptedAnchors?.[c.id];
          return (
            <div
              key={c.id}
              data-testid={`comment-thread-${c.id}`}
              data-status={c.status}
              data-expanded={String(expanded)}
              data-active={active ? 'true' : undefined}
              ref={active ? activeRef : undefined}
              className={cn(
                'rounded-lg border border-border bg-surface-elevated transition-colors',
                active && 'border-accent ring-1 ring-accent/40',
                c.status === 'resolved' && 'opacity-60',
              )}
            >
              <button
                type="button"
                className="block w-full px-2.5 pt-2 text-left"
                onClick={() => {
                  onSelect(c.id);
                  setManualExpand((prev) => ({ ...prev, [c.id]: true }));
                }}
              >
                <span className="line-clamp-2 border-l-2 border-accent/40 pl-2 text-xs italic text-text-secondary">
                  {c.anchor_text}
                </span>
                <span className="mt-1 flex items-center gap-1.5 pb-0.5">
                  {/* #1051: 来源徽标 — 线程列表区分正文/幻灯片评论。 */}
                  {c.target === 'deck_slide' && (
                    <span
                      data-testid="comment-source-deck"
                      className="rounded bg-surface-muted px-1 py-0.5 text-[10px] text-text-secondary"
                    >
                      {c.slide_index
                        ? t('writing.commentSourceDeckN', '幻灯片 {{n}}', { n: c.slide_index })
                        : t('writing.commentSourceDeck', '幻灯片')}
                    </span>
                  )}
                  {drifted && (
                    <span
                      data-testid="comment-anchor-drifted"
                      title={t('writing.commentDriftHint', '原文已改动，未能精确定位该评论的锚点')}
                      className="rounded border border-warning/40 bg-warning/10 px-1 py-0.5 text-[10px] text-warning"
                    >
                      {t('writing.commentDrifted', '待重新定位')}
                    </span>
                  )}
                  {ambiguous && (
                    <span
                      data-testid="comment-anchor-pending-pos"
                      title={t('writing.commentAnchorAmbiguous', '锚点文本在文档中多处出现 — 请确认位置')}
                      className="rounded border border-warning/40 bg-warning/10 px-1 py-0.5 text-[10px] text-warning"
                    >
                      {t('writing.commentAnchorPendingPos', '待确认位置')}
                    </span>
                  )}
                  {c.status === 'resolved' && (
                    <span className="rounded bg-surface-muted px-1 py-0.5 text-[10px] text-text-secondary">
                      {t('writing.commentResolvedTag', '已解决')}
                    </span>
                  )}
                </span>
              </button>
              {expanded && (
                <div className="space-y-1.5 px-2.5 pb-2 pt-1">
                  {/* #1089-6: 歧义/漂移态 — 「待确认位置」候选列表(text/heading 摘要)
                      + 每候选「用此位置」按钮;采纳后列表收起(徽标随重定位消失)。 */}
                  {confirmState && !adopted && confirmState.candidates.length > 0 && (
                    <div
                      data-testid={`comment-anchor-candidates-${c.id}`}
                      className="rounded-md border border-warning/30 bg-warning/5 px-2 py-1.5"
                    >
                      <p className="text-[10px] text-text-secondary">
                        {t('writing.commentAnchorConfirmHint', '请确认该评论锚定的位置：')}
                      </p>
                      {confirmState.candidates.slice(0, 5).map((cand, i) => (
                        <div key={`${i}-${cand.text.slice(0, 16)}`} className="mt-1 flex items-center justify-between gap-2">
                          <span className="min-w-0 flex-1 truncate text-[11px] text-text-primary" title={cand.text}>
                            「{cand.text.slice(0, 40)}」
                            {cand.heading ? <span className="text-text-tertiary"> · {cand.heading}</span> : null}
                          </span>
                          <Button
                            size="sm"
                            variant="secondary"
                            data-testid={`comment-adopt-${c.id}-${i}`}
                            onClick={() => onAdoptAnchor?.(c, cand)}
                          >
                            {t('writing.commentAnchorAdopt', '用此位置')}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  {c.replies.map((r) => (
                    <div key={r.id} data-testid="comment-reply" className="rounded-md bg-surface px-2 py-1.5">
                      <span className={cn('text-[10px] font-medium', r.role === 'ai' ? 'text-accent' : 'text-text-tertiary')}>
                        {r.role === 'ai' ? 'AI' : t('writing.commentReplyYou', '我')}
                      </span>
                      <p className="whitespace-pre-wrap text-xs leading-relaxed text-text-primary">{r.text}</p>
                    </div>
                  ))}
                  {c.status !== 'resolved' && (
                    <div className="flex gap-1 pt-0.5">
                      <input
                        data-testid={`comment-reply-input-${c.id}`}
                        value={replyDrafts[c.id] ?? ''}
                        onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void sendReply(c.id);
                          }
                        }}
                        placeholder={t('writing.commentReplyPlaceholder', '回复…')}
                        className="h-7 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-xs text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={replying === c.id || !(replyDrafts[c.id] ?? '').trim()}
                        onClick={() => void sendReply(c.id)}
                      >
                        {t('writing.commentReplySend', '回复')}
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {/* #1088: deck 评论 AI 写回待确认态 — 线程级「采纳本轮修改/撤销修改」
                  (仅 target='deck_slide' 且待确认;撤销仅在快照可恢复时显示)。
                  #1091: 渲染条件从纯内存 map 扩为「内存态 || wire.deck_snapshot
                  在场」— 刷新后从服务端快照恢复 pending-confirm 按钮态。
                  #1096: 确认语义 = 采纳本轮修改（不关闭评论，关闭权在用户）。 */}
              {c.target === 'deck_slide' && c.status !== 'resolved' && (!!deckConfirming?.[c.id] || !!c.deck_snapshot) && (
                <div data-testid={`comment-deck-confirm-${c.id}`} className="flex gap-1 px-2.5 pb-1 pt-0.5">
                  <Button size="sm" data-testid={`comment-deck-confirm-btn-${c.id}`} onClick={() => onDeckConfirm?.(c.id)}>
                    {t('writing.commentDeckConfirm', '采纳本轮修改')}
                  </Button>
                  {(!!deckConfirming?.[c.id]?.undoable || !!c.deck_snapshot) && (
                    <Button size="sm" variant="ghost" data-testid={`comment-deck-undo-btn-${c.id}`} onClick={() => onDeckUndo?.(c.id)}>
                      {t('writing.commentDeckUndo', '撤销修改')}
                    </Button>
                  )}
                </div>
              )}
              <div className="flex justify-end gap-1 px-2.5 pb-2">
                {/* #1041: 「请AI处理」— 处理中 loading/禁用（issue 用例 6 防并发）。
                    #1095: 评论并行处理 — 各按钮独立禁用；排队中的显示位次提示。 */}
                {c.status !== 'resolved' && onAiProcess && (
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid={`comment-ai-process-${c.id}`}
                    isLoading={!!processingCommentIds?.[c.id]}
                    disabled={!!processingCommentIds?.[c.id]}
                    onClick={() => onAiProcess(c)}
                  >
                    {(!!processingCommentIds?.[c.id] && (queuePositions?.[c.id] ?? 0) > 0)
                      ? t('writing.commentQueuePosition', '排队第 {{n}} 位', { n: queuePositions?.[c.id] })
                      : t('writing.commentAiProcess', '请AI处理')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => void onToggleResolve(c)}>
                  {c.status === 'resolved'
                    ? t('writing.commentReopen', '重新打开')
                    : t('writing.commentResolve', '标记已解决')}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
