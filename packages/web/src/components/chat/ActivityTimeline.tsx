import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, CheckCircle2, ChevronDown, ChevronRight, Loader2, Search, Wrench, XCircle } from 'lucide-react';
import { RETRIEVAL_TOOLS } from '@heurion/contracts';
import type { ChatMessage } from '@/lib/chat-reducer';
import { cn } from '@/lib/utils';

/**
 * #832 — 任务活动时间线：把 streamNote / reasoning / 工具芯片 / 子代理
 * 从"碎片"收敛成一条分层的活动流。
 *
 * 三层信息架构（沿用 #662 摘要/详情两层模式，外加常驻状态行）：
 *  - 一眼层：常驻状态行 — 当前活动 + 已耗时 + 停滞提示(#828) + 轮次
 *  - 扫一眼层：折叠行 — 推理(完成/生成中)、连续只读工具 ×N(含失败数)、
 *    子代理进度(阶段/轮次/耗时)，完成后变结果卡预览(#831)
 *  - 深究层：展开 — reasoning 全文(30K 上限)、工具入参+结果摘要
 *
 * #832-缺2: 服务端 tool_call/tool_result 携带 round（模型轮次）— 换轮时
 * 渲染轮次分隔行，与后端 MAX_TOOL_ROUNDS 状态机同源。
 * 文案全部走 i18n（#798 裸键治理）。
 */

export interface ActivityTimelineProps {
  message: ChatMessage;
  /** #828: 会话停滞起点（距最近一条 SSE data 事件 >90s），null=无停滞。 */
  stallSince?: number | null;
  /** #832: 前置阶段提示（路由/上下文组装）— 从列表顶部移进气泡状态行。 */
  streamNote?: string;
  /** 消息是否在流式接收中（决定状态行/计时器是否激活）。 */
  isStreaming?: boolean;
}

type ToolEntry = NonNullable<ChatMessage['toolCalls']>[number];

/** 与服务端 READ_ONLY_TOOLS 同口径的 UI 折叠集 — 连续只读工具并成一行。 */
const FOLD_TOOLS = new Set<string>([
  ...RETRIEVAL_TOOLS,
  'search_medical_web',
  'fetch_article_summary',
  'visit_medical_site',
  'extract_fulltext',
  'search_citation',
  'load_data_table',
]);

function fmtDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/** 1s 心跳 — 仅激活时跑，驱动状态行/活动行的 elapsed 实时刷新。 */
function useTick(active: boolean): void {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}

interface ToolRowData {
  kind: 'tool';
  item: ToolEntry;
}
interface FoldGroupData {
  kind: 'fold';
  items: ToolEntry[];
}
interface RoundDividerData {
  kind: 'round';
  round: number;
}
type Row = ToolRowData | FoldGroupData | RoundDividerData;

function StatusIcon({ status }: { status: 'running' | 'done' | 'error' }) {
  if (status === 'running') return <Loader2 size={11} className="animate-spin text-accent" />;
  if (status === 'error') return <XCircle size={11} className="text-error" />;
  return <CheckCircle2 size={11} className="text-text-tertiary" />;
}

function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const tail = useMemo(() => {
    const lines = text.trimEnd().split('\n');
    return lines.slice(-2).join('\n').slice(-160);
  }, [text]);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-text-secondary transition-colors hover:bg-surface-elevated"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {streaming ? t('chat.activityReasoningStreaming') : t('chat.activityReasoningDone')}
        <span className="text-text-tertiary">· {text.length} {t('chat.activityChars')}</span>
      </button>
      {!open && streaming && tail && (
        <div className="mt-1 truncate border-l-2 border-border pl-2 text-[11px] text-text-tertiary">{tail}</div>
      )}
      {open && (
        <div className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-xs leading-relaxed text-text-secondary">
          {text.slice(0, 30000)}
          {text.length > 30000 ? '…' : ''}
        </div>
      )}
    </div>
  );
}

function ToolRow({ item }: { item: ToolEntry }) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();
  const running = item.status === 'running';
  return (
    <div className="text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={!item.resultPreview && !item.argsPreview}
        className={cn(
          'inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-text-secondary transition-colors',
          !running && 'hover:bg-surface-elevated',
        )}
        aria-expanded={open}
      >
        <Wrench size={11} className="shrink-0 text-text-tertiary" />
        <span className="truncate">
          {t(`chat.tool.${item.tool}`, { defaultValue: item.tool })}
        </span>
        {running ? (
          <>
            <span className="text-text-tertiary">{item.startedAt ? fmtDuration(Date.now() - item.startedAt) : ''}</span>
            <Loader2 size={11} className="animate-spin text-accent" />
          </>
        ) : (
          <>
            {item.elapsedMs !== undefined && <span className="text-text-tertiary">{fmtDuration(item.elapsedMs)}</span>}
            <StatusIcon status={item.status} />
          </>
        )}
      </button>
      {open && (
        <div className="mt-1 space-y-0.5 rounded-lg border border-border bg-surface p-2 text-[11px] text-text-tertiary">
          {item.argsPreview && <div className="truncate font-mono">{item.tool}({item.argsPreview})</div>}
          {item.resultPreview && <div className="break-words">{item.status === 'error' ? '✗ ' : '→ '}{item.resultPreview}</div>}
        </div>
      )}
    </div>
  );
}

function FoldedRow({ group }: { group: FoldGroupData }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const failed = group.items.filter((i) => i.status === 'error').length;
  const running = group.items.some((i) => i.status === 'running');
  const doneCount = group.items.filter((i) => i.status === 'done').length;
  const elapsed = group.items.reduce((acc, i) => acc + (i.elapsedMs ?? 0), 0);
  return (
    <div className="text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-text-secondary transition-colors hover:bg-surface-elevated"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Search size={11} className="text-text-tertiary" />
        <span>
          {t('chat.activityRetrievalFold')} · {group.items.length}
          {failed > 0
            ? ` · ${failed} ${t('chat.activityFailed')}`
            : doneCount > 0
              ? ` · ${doneCount} ${t('chat.activityDone')}`
              : ''}
        </span>
        {elapsed > 0 && <span className="text-text-tertiary">{fmtDuration(elapsed)}</span>}
        <StatusIcon status={running ? 'running' : failed > 0 ? 'error' : 'done'} />
      </button>
      {open && (
        <div className="mt-1 space-y-1 rounded-lg border border-border bg-surface p-2">
          {group.items.map((item, j) => (
            <div key={j} className="flex items-start gap-1.5 text-[11px]">
              <StatusIcon status={item.status} />
              <div className="min-w-0">
                <div className="truncate font-mono text-text-tertiary">
                  {item.tool}({item.argsPreview})
                </div>
                {item.resultPreview && (
                  <div className={cn('break-words', item.status === 'error' ? 'text-error' : 'text-text-secondary')}>
                    {item.resultPreview}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const PHASE_KEY: Record<'thinking' | 'tool' | 'summarizing', string> = {
  thinking: 'chat.subagentPhaseThinking',
  tool: 'chat.subagentPhaseTool',
  summarizing: 'chat.subagentPhaseSummarizing',
};

function SubagentRow({ sa }: { sa: NonNullable<ChatMessage['subagents']>[number] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const running = sa.status === 'running';
  return (
    <div className="text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-text-secondary transition-colors hover:bg-surface-elevated"
        aria-expanded={open}
      >
        <Bot size={11} className="shrink-0 text-text-tertiary" />
        <span className="truncate">{sa.task}</span>
        {running ? (
          <>
            <span className="text-text-tertiary">
              {sa.phase ? t(PHASE_KEY[sa.phase]) : ''}
              {sa.phase === 'tool' && sa.currentTool
                ? ` · ${t(`chat.tool.${sa.currentTool}`, { defaultValue: sa.currentTool })}`
                : ''}
              {sa.turn !== undefined ? ` · ${sa.turn}/${sa.maxTurns ?? '?'}` : ''}
            </span>
            <span className="text-text-tertiary">
              {(sa.startedAt || sa.elapsedMs !== undefined) ? fmtDuration(sa.elapsedMs ?? (sa.startedAt ? Date.now() - sa.startedAt : 0)) : ''}
            </span>
            <Loader2 size={11} className="animate-spin text-accent" />
          </>
        ) : (
          <>
            {sa.turns !== undefined && <span className="text-text-tertiary">{t('chat.subagentTurns', { turns: sa.turns })}</span>}
            <StatusIcon status={sa.status === 'failed' ? 'error' : 'done'} />
          </>
        )}
      </button>
      {open && (
        <div className="mt-1 space-y-0.5 rounded-lg border border-border bg-surface p-2 text-[11px] text-text-tertiary">
          {sa.currentTool && <div className="font-mono">{sa.currentTool}{sa.toolArgsPreview ? `(${sa.toolArgsPreview})` : ''}</div>}
          {(sa.summaryPreview || sa.status === 'done') && (
            <div className={cn('break-words', sa.status === 'failed' && 'text-error')}>
              {sa.status === 'done' ? (sa.summaryPreview || t('chat.activityDone')) : t('chat.subagentFailed')}
            </div>
          )}
          {sa.costTokens !== undefined && sa.costTokens > 0 && <div>≈{sa.costTokens} tokens</div>}
        </div>
      )}
    </div>
  );
}

/** #832: 常驻状态行 — 当前活动 + 轮次 + 已耗时 + 停滞提示。 */
function StatusLine({ message, stallSince, streamNote }: Pick<ActivityTimelineProps, 'message' | 'stallSince' | 'streamNote'>) {
  const { t } = useTranslation();
  const streaming = Boolean(message.isStreaming);
  useTick(streaming || Boolean(stallSince));
  const runningTool = (message.toolCalls ?? []).find((tc) => tc.status === 'running');
  const runningSub = (message.subagents ?? []).find((sa) => sa.status === 'running');
  const stalledMs = stallSince ? Date.now() - stallSince : 0;
  let activity = streamNote || t('chat.activityWorking');
  if (runningTool) {
    activity = t('chat.activityRunningTool', { tool: t(`chat.tool.${runningTool.tool}`, { defaultValue: runningTool.tool }) });
  } else if (runningSub) {
    activity = t('chat.activitySubagent', { task: runningSub.task });
  } else if (message.reasoning && !message.text) {
    activity = streamNote || t('chat.thinking', '思考中…');
  }
  const startedAt = message.createdAt ?? Date.now();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-[11px] text-text-tertiary">
      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
      <span className="truncate">{activity}</span>
      {streaming && runningTool?.round !== undefined && (
        <span>· {t('chat.activityRound', { round: runningTool.round })}</span>
      )}
      {streaming && <span>· ⏱ {fmtDuration(Date.now() - startedAt)}</span>}
      {stallSince && (
        <span className="rounded border border-warning/30 bg-warning/5 px-1.5 py-0.5 text-warning">
          {t('chat.activityStalled', { duration: fmtDuration(stalledMs) })}
        </span>
      )}
    </div>
  );
}

/** #832: 行构造 — 连续只读工具折叠 + 换轮分隔行（缺2）。 */
function buildRows(tools: ToolEntry[]): Row[] {
  const rows: Row[] = [];
  let lastRound: number | undefined;
  for (const item of tools) {
    if (item.round !== undefined && item.round !== lastRound) {
      if (rows.length > 0) rows.push({ kind: 'round', round: item.round });
      lastRound = item.round;
    }
    const foldable = FOLD_TOOLS.has(item.tool) && item.status !== 'running';
    const prev = rows[rows.length - 1];
    if (foldable && prev && prev.kind === 'fold') {
      prev.items.push(item);
    } else if (foldable) {
      rows.push({ kind: 'fold', items: [item] });
    } else {
      rows.push({ kind: 'tool', item });
    }
  }
  return rows;
}

/**
 * #832 — 时间线主体。无内容（纯文本回答）时渲染 null，行为与旧芯片一致。
 */
export function ActivityTimeline({ message, stallSince, streamNote, isStreaming }: ActivityTimelineProps) {
  const { t } = useTranslation();
  const streaming = isStreaming ?? Boolean(message.isStreaming);
  const hasContent = Boolean(
    message.reasoning || (message.toolCalls && message.toolCalls.length > 0) || (message.subagents && message.subagents.length > 0),
  );
  if (!hasContent && !streamNote) return null;

  const rows = buildRows(message.toolCalls ?? []);

  return (
    <div className="mb-2 space-y-1.5" data-testid="activity-timeline">
      {(streaming || stallSince) && <StatusLine message={message} stallSince={stallSince} streamNote={streamNote} />}
      {message.reasoning && <ReasoningBlock text={message.reasoning} streaming={streaming && !message.text} />}
      {rows.map((row, i) => {
        if (row.kind === 'fold') return <FoldedRow key={`g${i}`} group={row} />;
        if (row.kind === 'round') {
          return (
            <div key={`r${i}`} className="flex items-center gap-2 pt-0.5 text-[10px] text-text-tertiary/80">
              <span className="h-px w-4 bg-border" />
              {t('chat.activityRound', { round: row.round })}
            </div>
          );
        }
        return <ToolRow key={`t${i}`} item={row.item} />;
      })}
      {(message.subagents ?? []).map((sa) => <SubagentRow key={sa.id} sa={sa} />)}
    </div>
  );
}
