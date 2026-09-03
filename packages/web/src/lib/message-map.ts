import type { ChatWireMessage } from '@heurion/contracts';
import type { ChatMessage } from '@/stores/chat';

/**
 * #461 — the ONE wire→UI message mapper. chat.tsx / PatientChatPage /
 * writing-editor doc-chat each used to hand-map only text (+ download +
 * knowledgePayload) with `as any` casts. Rich media that the backend
 * persists in event-log metadata (sidecar/plugin file, knowledge payload)
 * is restored here; the same fields stream into ChatMessages live.
 */
export function mapWireMessage(m: ChatWireMessage): ChatMessage {
  const meta = m.metadata as
    | {
        sidecar?: boolean;
        plugin?: boolean;
        file?: { fileId: string; fileName: string; mimeType: string };
        knowledgePayload?: { title: string; content: string };
        compactionSummary?: boolean;
        /** #723: 该轮生成的图表(render_chart) — 刷新后恢复聊天里的图。 */
        chart?: Array<{ url: string; chartType?: string }>;
        /**
         * #832-缺3: 回合时间线快照(有界) — 刷新后重建工具芯片/子代理
         * 结果卡(server conversation-turn 落库)。
         */
        timeline?: {
          tools?: Array<{
            tool: string; seq: number; round?: number; argsPreview?: string
            status: 'running' | 'completed' | 'error'
            resultPreview?: string; elapsedMs?: number
          }>;
          subagents?: Array<{
            id: string; task: string; status: 'running' | 'done' | 'failed'
            summaryPreview?: string; turns?: number; costTokens?: number
          }>;
        };
      }
    | undefined;

  const download =
    meta?.file && (meta.sidecar || meta.plugin)
      ? {
          fileId: meta.file.fileId,
          fileName: meta.file.fileName,
          mimeType: meta.file.mimeType,
          url: '',
          expiresIn: 0,
        }
      : undefined;

  // #832-缺3: 恢复时间线 — 状态机词汇映射(completed→done);落库时刻回合
  // 已结束,残留 running 的条目一律收敛为 done(防御异常中断的脏数据)。
  const restoredTools = meta?.timeline?.tools?.length
    ? meta.timeline.tools.map((t) => ({
        tool: t.tool,
        argsPreview: t.argsPreview ?? '',
        status: (t.status === 'error' ? 'error' : 'done') as 'error' | 'done',
        seq: t.seq,
        ...(t.round !== undefined ? { round: t.round } : {}),
        ...(t.resultPreview ? { resultPreview: t.resultPreview } : {}),
        ...(t.elapsedMs !== undefined ? { elapsedMs: t.elapsedMs } : {}),
      }))
    : undefined;
  const restoredSubs = meta?.timeline?.subagents?.length
    ? meta.timeline.subagents.map((s) => ({
        id: s.id,
        task: s.task,
        status: (s.status === 'failed' ? 'failed' : 'done') as 'failed' | 'done',
        ...(s.summaryPreview ? { summaryPreview: s.summaryPreview } : {}),
        ...(s.turns !== undefined ? { turns: s.turns } : {}),
        ...(s.costTokens !== undefined ? { costTokens: s.costTokens } : {}),
      }))
    : undefined;

  return {
    id: crypto.randomUUID(),
    role: m.role,
    text: m.content,
    createdAt: m.timestamp ? new Date(m.timestamp).getTime() : undefined,
    download,
    knowledgePayload: meta?.knowledgePayload,
    compactionSummary: meta?.compactionSummary === true,
    // #723: 恢复该轮生成的图表(取最后一张)。
    chart: meta?.chart?.length ? meta.chart[meta.chart.length - 1] : undefined,
    ...(restoredTools ? { toolCalls: restoredTools } : {}),
    ...(restoredSubs ? { subagents: restoredSubs } : {}),
  };
}

export function mapWireMessages(msgs: ChatWireMessage[]): ChatMessage[] {
  return msgs.map((m) => mapWireMessage(m));
}
