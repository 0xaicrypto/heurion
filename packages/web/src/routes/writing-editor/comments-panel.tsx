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
 * 弹窗:选区评论创建入口(气泡「添加评论」→ 路由持 draft → 本弹窗),提交
 * 由路由调创建 API。
 */

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
  className?: string;
}) {
  const { t } = useTranslation();
  const { comments, activeId, onSelect, onReply, onToggleResolve, onAiProcess, processingCommentIds, className } = input;
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
                  {c.status === 'resolved' && (
                    <span className="rounded bg-surface-muted px-1 py-0.5 text-[10px] text-text-secondary">
                      {t('writing.commentResolvedTag', '已解决')}
                    </span>
                  )}
                </span>
              </button>
              {expanded && (
                <div className="space-y-1.5 px-2.5 pb-2 pt-1">
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
              <div className="flex justify-end gap-1 px-2.5 pb-2">
                {/* #1041: 「请AI处理」— 处理中 loading/禁用（issue 用例 6 防并发）。 */}
                {c.status !== 'resolved' && onAiProcess && (
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid={`comment-ai-process-${c.id}`}
                    isLoading={!!processingCommentIds?.[c.id]}
                    disabled={!!processingCommentIds?.[c.id]}
                    onClick={() => onAiProcess(c)}
                  >
                    {t('writing.commentAiProcess', '请AI处理')}
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
