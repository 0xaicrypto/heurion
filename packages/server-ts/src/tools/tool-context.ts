/** #1146 循环依赖:ToolContext/ToolExecutionPlane/EditHint 下沉叶子模块 —
 * tools 子文件不再为共享类型反向导入 tool-registry(曾构成 20+ 环)。 */
import type { SubagentEvent } from '@heurion/contracts'
import type { MemoryService } from '../memory/memory.service.js'
import type { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../evolution/stores.js'
import type { EventLog } from '../core/event-log.js'

/**
 * #766: execution-plane port (structural — tools stay decoupled from
 * modules/). conversation-turn provides createExecutionPlaneService().
 */
export interface ToolExecutionPlane {
  enqueue(job: { type: string; payload: Record<string, unknown>; tenant?: { userId?: string; workspaceId?: string } }): Promise<{ job_id: string; status: string }>
  getStatus(jobId: string): Promise<{ job_id: string; status: string; error?: unknown; result?: Record<string, unknown> } | null>
  fetchFile?(fileId: string): Promise<Buffer | null>
}

export interface ToolContext {
  userId: string
  memory: MemoryService
  facts: FactsStore
  episodes: EpisodesStore
  skills: SkillsStore
  knowledge: KnowledgeStore
  eventLog: EventLog
  /** Current session id — write tools (edit_document) derive doc-{docId}. */
  sessionId?: string
  /**
   * #666: plugin availability port — provided by the modules layer
   * (conversation-turn), keeps `tools/` free of `modules/*` imports.
   * Absent port ⇒ gated tools are treated as unavailable.
   */
  isPluginInstalled?: (pluginId: string) => Promise<boolean>
  /**
   * #766: execution-plane port for insert_asset plot rendering
   * (enqueue → poll → fetchFile → chart-token 落盘). Absent ⇒ plot branch
   * degrades to a readable error.
   */
  executionPlane?: ToolExecutionPlane
  /**
   * #666: plugin config port (browser-agent worker url/token/approval) —
   * same layering rationale; absent port ⇒ defaults are used.
   */
  getPluginConfig?: (pluginId: string) => Promise<Record<string, unknown>>
  /**
   * #939: figure 渲染管线 port（mermaid 围栏/公式行 → 托管图片行）—
   * 由 modules/figures 提供，tools 零 modules import（#672 分层）。
   * Absent ⇒ 导出跳过 figure 解析（原文本降级，不阻塞导出）。
   * #960: ensureFigure 面向 figure block（deck v2）——source→托管 image 块。
   */
  figurePipeline?: {
    resolveBody: (userId: string, body: string) => Promise<string>
    ensureFigure: (userId: string, source: string, kind: 'mermaid' | 'latex_math', caption?: string) => Promise<{ ref: string; caption?: string; data: string } | null>
  }
  /**
   * #828: turn abort signal (client disconnect / stop / watchdog) — tools
   * and sub-agents observe it so a dead client stops burning tokens.
   * Absent ⇒ tools run to completion as before.
   */
  signal?: AbortSignal
  /**
   * #831: sub-agent visibility port — spawn_subagent/deep-analysis report
   * started/progress/done through it (typed SubagentEvent from contracts).
   * Absent ⇒ sub-agents run silently (old behavior).
   */
  emitSubagentEvent?: (ev: SubagentEvent) => void
  /**
   * #866-868: 编辑定位提示 — rangeEdit 焦点优先匹配用。conversation-turn
   * 在上下文组装期间回填(组装期写、工具执行期读的 holder),工具层保持
   * 对 modules 层无依赖。Absent ⇒ 全文匹配(旧行为)。
   */
  editHint?: EditHint
}

/** #866-868: 焦点段/选中文本定位提示。 */
export interface EditHint {
  /** 当前焦点段原文(#866 分段内容,未截断版) — rangeEdit 先在段内匹配。 */
  focusSectionContent?: string | null
  focusIndex?: number | null
  focusTitle?: string | null
  /** 用户选中文本(#693) — 比焦点段更具体,匹配优先级最高。 */
  selectionText?: string | null
}
