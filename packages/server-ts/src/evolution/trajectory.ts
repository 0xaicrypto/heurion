/**
 * #843 环① — TaskTrajectory 任务轨迹采集(epic #841 Phase 1,设计 §3.1)。
 *
 * 决策 D1:**eventLog 投影,不进 graph** — 轨迹是喂给环②归纳的遥测而非知识,
 * 高频低值数据进 graph 会稀释图谱密度与向量索引质量;投影可随时从 eventLog
 * 重建(投影=可重建缓存,恰是 #840 想要的终态形态)。
 *
 * 架构性隐私保证:schema 零正文字段 — 不含患者正文、不含文档内容,只有
 * 操作元数据(action/scene/toolsUsed/docEdits/outcome)。
 */
import type { EventLog, Event } from '../core/event-log.js'

export type TrajectoryAction = 'edit' | 'generate' | 'retrieve' | 'command'

export interface TaskTrajectory {
  id: string
  userId: string
  sessionId: string
  /** 事件序号 — 即回合标识(eventLog 单调递增)。 */
  turnId: number
  action: TrajectoryAction
  scene: string
  /** 工具名序列(按调用序,截断保留前 20 个防异常膨胀)。 */
  toolsUsed: string[]
  /** 编辑类回合的写回次数(edit_document 调用数)。 */
  docEdits: number
  outcome: 'completed' | 'abandoned'
  /** AI 产出后用户同会话近期重做同动作(隐式修正信号,投影期派生)。 */
  userCorrection: boolean
  /** 回合耗时:本轮 trajectory 事件距同 session 上一条 user_message 的间隔(ms)。 */
  durationMs: number
  createdAt: number
}

export const TRAJECTORY_EVENT = 'task_trajectory'

const TASK_ACTIONS: readonly string[] = ['edit', 'generate', 'retrieve', 'command']

/** 环① 入口判据:仅任务型回合记录,纯对话(answer)不记 — 复用 intent-router 判定,零额外 LLM。 */
export function shouldRecordTurn(action: string): boolean {
  return TASK_ACTIONS.includes(action)
}

export interface TurnTrajectoryInput {
  userId: string
  sessionId: string
  action: string
  scene: string
  toolsUsed: string[]
  docEdits: number
  outcome?: 'completed' | 'abandoned'
}

/**
 * 回合终了聚合一条 eventLog 事件 — 零正文(content 仅动作标签),metadata
 * 只带操作元数据。零 LLM、零外呼,纯结构化记录。
 */
export function recordTaskTrajectory(eventLog: EventLog, input: TurnTrajectoryInput): void {
  if (!shouldRecordTurn(input.action)) return
  eventLog.append({
    timestamp: Date.now() / 1000,
    eventType: TRAJECTORY_EVENT,
    content: `task:${input.action}`,
    metadata: {
      trajectoryId: `trj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      action: input.action,
      scene: input.scene,
      toolsUsed: input.toolsUsed.slice(0, 20),
      docEdits: input.docEdits,
      outcome: input.outcome ?? 'completed',
    },
    agentId: input.userId,
    sessionId: input.sessionId,
  })
}

/** 修正判定窗口:同会话同动作 10 分钟内的下一回合视为对前一回合的重做。 */
const CORRECTION_WINDOW_S = 10 * 60

/**
 * eventLog → TaskTrajectory 只读投影。内存缓存 + 可全量重建(删缓存重读,
 * 源头唯一是 eventLog)。
 */
export class TaskTrajectoryProjection {
  private cache: TaskTrajectory[] | null = null

  constructor(private eventLog: EventLog) {}

  query(filter: { taskKind?: string; since?: number; until?: number; sessionId?: string } = {}): TaskTrajectory[] {
    if (!this.cache) this.cache = this.project()
    return this.cache.filter((t) =>
      (!filter.taskKind || t.action === filter.taskKind)
      && (filter.since === undefined || t.createdAt >= filter.since)
      && (filter.until === undefined || t.createdAt <= filter.until)
      && (!filter.sessionId || t.sessionId === filter.sessionId))
  }

  /** 可重建性验收:投影清空后从 eventLog 全量重投影,前后 diff 为空。 */
  rebuild(): TaskTrajectory[] {
    this.cache = null
    return this.query()
  }

  /**
   * #840-r5: 缓存失效钩子 — eventLog 追加新轨迹后,持有实例的调用方必须
   * 先 invalidate() 再 query,否则读到 stale(当前所有调用方均为一次性
   * new 实例,隐式安全;此方法固化该契约,防未来复用踩坑)。
   */
  invalidate(): void {
    this.cache = null
  }

  /** 采集量/任务型占比基线(taskKind 过滤后 / 全量)。 */
  stats(): { total: number; byTaskKind: Record<string, number> } {
    const all = this.query()
    const byTaskKind: Record<string, number> = {}
    for (const t of all) byTaskKind[t.action] = (byTaskKind[t.action] || 0) + 1
    return { total: all.length, byTaskKind }
  }

  private project(): TaskTrajectory[] {
    // query 返回按 idx 倒序 — 升序化后单趟扫描派生 durationMs/userCorrection。
    const events: Event[] = this.eventLog.query({ eventType: TRAJECTORY_EVENT }).slice().reverse()
    const allEvents: Event[] = this.eventLog.query({}).slice().reverse()
    const lastUserMsgAt = new Map<string, number>()
    let cursor = 0
    const out: TaskTrajectory[] = []
    for (const ev of events) {
      // durationMs:同 session 中,最后一条 timestamp ≤ 本事件的 user_message。
      while (cursor < allEvents.length && allEvents[cursor].idx < ev.idx) {
        const e = allEvents[cursor]
        if (e.eventType === 'user_message') lastUserMsgAt.set(e.sessionId, e.timestamp)
        cursor++
      }
      const userMsgAt = lastUserMsgAt.get(ev.sessionId)
      const m = ev.metadata as Record<string, any>
      const t: TaskTrajectory = {
        id: String(m?.trajectoryId || `trj_${ev.idx}`),
        userId: ev.agentId,
        sessionId: ev.sessionId,
        turnId: ev.idx,
        action: (TASK_ACTIONS as readonly string[]).includes(String(m?.action)) ? (m.action as TrajectoryAction) : 'command',
        scene: String(m?.scene || 'general'),
        toolsUsed: Array.isArray(m?.toolsUsed) ? m.toolsUsed.map(String) : [],
        docEdits: Number(m?.docEdits) || 0,
        outcome: m?.outcome === 'abandoned' ? 'abandoned' : 'completed',
        userCorrection: false,
        durationMs: userMsgAt !== undefined && ev.timestamp >= userMsgAt ? Math.round((ev.timestamp - userMsgAt) * 1000) : 0,
        createdAt: ev.timestamp * 1000,
      }
      out.push(t)
    }
    // userCorrection 派生:同会话同动作,10 分钟内的下一回合 = 对前者的重做。
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1]
      const cur = out[i]
      if (prev.sessionId === cur.sessionId && prev.action === cur.action
        && cur.createdAt - prev.createdAt <= CORRECTION_WINDOW_S * 1000) {
        prev.userCorrection = true
      }
    }
    return out
  }
}
