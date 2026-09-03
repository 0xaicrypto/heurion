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
 *  - 一眼层：常驻状态行 — 当前活动 + 已耗时 + 停滞提示(#828)
 *  - 扫一眼层：折叠行 — 推理(完成/生成中)、连续检索 ×N(含失败数)、
 *    子代理进度(阶段/轮次/耗时)，完成后变结果卡预览(#831)
 *  - 深究层：展开 — reasoning 全文(30K 上限)、工具入参+结果摘要
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

/** 常用工具的可读标签 — 未命中的回退原始名。 */
const TOOL_LABELS: Record<string, string> = {
  search_node: '检索患者记忆',
  search_encounter: '检索就诊记录',
  search_past_chats: '检索历史对话',
  search_medical_web: '检索 PubMed',
  fetch_article_summary: '读取文献摘要',
  visit_medical_site: '读取网页',
  extract_fulltext: '提取全文',
  search_citation: '核验引用',
  load_data_table: '载入数据表',
  load_skill: '加载技能',
  query_logs: '查询日志',
  edit_document: '写回文档',
  insert_asset: '插入资产',
  edit_deck: '编辑幻灯片',
  fix_document_images: '修复图片链接',
  generate_image: '生成图片',
  render_chart: '渲染图表',
  render_scene: '渲染生物场景',
  delegate: '委派子任务',
  spawn_subagent: '子代理研究',
  ocr_image: '识别图片',
};

function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] || tool;
}

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

interface FoldGroup {
  kind: 'retrieval';
  items: NonNullable<ChatMessage['toolCalls']>;
  index: number;
}
interface SoloTool {
  kind: 'tool';
  item: NonNullable<ChatMessage['toolCalls']>[number];
  index: number;
}
type Row = FoldGroup | SoloTool;

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
        {streaming ? t('chat.reasoningStreaming', '推理中') : t('chat.reasoningDone', '推理完成')}
        <span className="text-text-tertiary">· {text.length > 1000 ? `${Math.round(text.length / 1000)}k 字` : `${text.length} 字`}</span>
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

function ToolRow({ item }: { item: NonNullable<ChatMessage['toolCalls']>[number] }) {
  const [open, setOpen] = useState(false);
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
        <span className="truncate">{toolLabel(item.tool)}</span>
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

function FoldedRetrievalRow({ group }: { group: FoldGroup }) {
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
          {t('chat.retrievalFold', '检索/读取')} · {group.items.length}
          {failed > 0 ? ` · ${failed} 失败` : doneCount > 0 ? ` · ${doneCount} 完成` : ''}
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

const PHASE_LABEL: Record<'thinking' | 'tool' | 'summarizing', string> = {
  thinking: '思考中',
  tool: '调用工具',
  summarizing: '汇总结果',
};

function SubagentRow({ sa }: { sa: NonNullable<ChatMessage['subagents']>[number] }) {
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
              {sa.phase ? PHASE_LABEL[sa.phase] : ''}
              {sa.phase === 'tool' && sa.currentTool ? ` · ${toolLabel(sa.currentTool)}` : ''}
              {sa.turn !== undefined ? ` · ${sa.turn}/${sa.maxTurns ?? '?'}` : ''}
            </span>
            <span className="text-text-tertiary">{(sa.startedAt || sa.elapsedMs !== undefined) ? fmtDuration(sa.elapsedMs ?? (sa.startedAt ? Date.now() - sa.startedAt : 0)) : ''}</span>
            <Loader2 size={11} className="animate-spin text-accent" />
          </>
        ) : (
          <>
            {sa.turns !== undefined && <span className="text-text-tertiary">{sa.turns} 轮</span>}
            <StatusIcon status={sa.status === 'failed' ? 'error' : 'done'} />
          </>
        )}
      </button>
      {open && (
        <div className="mt-1 space-y-0.5 rounded-lg border border-border bg-surface p-2 text-[11px] text-text-tertiary">
          {sa.currentTool && <div className="font-mono">{sa.currentTool}{sa.toolArgsPreview ? `(${sa.toolArgsPreview})` : ''}</div>}
          {(sa.summaryPreview || sa.status === 'done') && (
            <div className={cn('break-words', sa.status === 'failed' && 'text-error')}>
              {sa.status === 'done' ? (sa.summaryPreview || '完成') : '子任务失败（不影响其他子任务）'}
            </div>
          )}
          {sa.costTokens !== undefined && sa.costTokens > 0 && <div>≈{sa.costTokens} tokens</div>}
        </div>
      )}
    </div>
  );
}

/** #832: 常驻状态行 — 当前活动 + 已耗时 + 停滞提示。 */
function StatusLine({ message, stallSince, streamNote }: Pick<ActivityTimelineProps, 'message' | 'stallSince' | 'streamNote'>) {
  const streaming = Boolean(message.isStreaming);
  useTick(streaming || Boolean(stallSince));
  const runningTool = (message.toolCalls ?? []).find((tc) => tc.status === 'running');
  const runningSub = (message.subagents ?? []).find((sa) => sa.status === 'running');
  const stalledMs = stallSince ? Date.now() - stallSince : 0;
  let activity = streamNote || '正在处理';
  if (runningTool) {
    activity = `执行 ${toolLabel(runningTool.tool)}`;
  } else if (runningSub) {
    activity = `子代理 ${runningSub.task}`;
  } else if (message.reasoning && !message.text) {
    activity = streamNote || '思考中';
  }
  const startedAt = message.createdAt ?? Date.now();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-[11px] text-text-tertiary">
      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
      <span className="truncate">{activity}</span>
      {streaming && <span>· ⏱ {fmtDuration(Date.now() - startedAt)}</span>}
      {stallSince && (
        <span className="rounded border border-warning/30 bg-warning/5 px-1.5 py-0.5 text-warning">
          已 {fmtDuration(stalledMs)} 无新进展 — 仍在执行，复杂任务可能较慢
        </span>
      )}
    </div>
  );
}

/**
 * #832 — 时间线主体。无内容（纯文本回答）时渲染 null，行为与旧芯片一致。
 */
export function ActivityTimeline({ message, stallSince, streamNote, isStreaming }: ActivityTimelineProps) {
  const streaming = isStreaming ?? Boolean(message.isStreaming);
  const hasContent = Boolean(
    message.reasoning || (message.toolCalls && message.toolCalls.length > 0) || (message.subagents && message.subagents.length > 0),
  );
  if (!hasContent && !streamNote) return null;

  // 连续只读（检索/读取）工具折叠成一行；running 的逐个展示；其余独立成行。
  const rows: Row[] = [];
  const tools = message.toolCalls ?? [];
  tools.forEach((item, index) => {
    const foldable = FOLD_TOOLS.has(item.tool) && item.status !== 'running';
    const prev = rows[rows.length - 1];
    if (foldable && prev && prev.kind === 'retrieval') {
      prev.items.push(item);
    } else if (foldable) {
      rows.push({ kind: 'retrieval', items: [item], index });
    } else {
      rows.push({ kind: 'tool', item, index });
    }
  });

  return (
    <div className="mb-2 space-y-1.5" data-testid="activity-timeline">
      {(streaming || stallSince) && <StatusLine message={message} stallSince={stallSince} streamNote={streamNote} />}
      {message.reasoning && <ReasoningBlock text={message.reasoning} streaming={streaming && !message.text} />}
      {rows.map((row, i) =>
        row.kind === 'retrieval' ? <FoldedRetrievalRow key={`g${i}`} group={row} /> : <ToolRow key={`t${i}`} item={row.item} />,
      )}
      {(message.subagents ?? []).map((sa) => <SubagentRow key={sa.id} sa={sa} />)}
    </div>
  );
}
