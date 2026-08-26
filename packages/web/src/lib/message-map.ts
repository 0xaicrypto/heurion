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
  };
}

export function mapWireMessages(msgs: ChatWireMessage[]): ChatMessage[] {
  return msgs.map((m) => mapWireMessage(m));
}
