import type { Store } from '../db.ts'
import { wantsAi } from './office-comments.ts'
import { buildCommentPrompt, BusyError, type TurnService } from './turn.ts'

/**
 * @heurion 自动触发（评论即指令，进一步简化前端）：
 *
 * 用户在编辑器里给评论写 "@heurion + 要求"，保存落版时评论被同步进评论表，
 * 本模块扫描新同步的评论并自动触发 AI 回合 —— 用户全程不需要碰面板按钮。
 *
 * 纪律（防失控/防循环）：
 * - 只认 open 线程的**最新** user 回复，且该回复包含触发词；
 * - 用 last_auto_reply_id 记录触发水位，同一回复只触发一次；
 * - 仅在 user 主动落版（user/upload 源）后扫描 —— AI 自己的保存不触发（否则
 *   AI 复制评论会自我召唤，无限循环）；
 * - 每文档 FIFO 串行（单文档单 dsh 进程）；回合结束后自动接力下一队。
 * - 自动回合的实时过程步不推送 SSE（没有挂客户端）——用户直接看编辑器里
 *   文件变化 + 线程里的 AI 回复；面板靠 busy 状态显示「处理中」。
 */
export class CommentAutomation {
  private readonly queue = new Map<string, string[]>()
  private readonly running = new Set<string>()

  constructor(
    private readonly store: Store,
    private readonly turns: TurnService,
  ) {}

  /** TurnService 回合结束接力：尝试继续消化队列（drain 的 finally 也会回到这里）。 */
  handleTurnEnd(docId: string): void {
    void this.drain(docId)
  }

  /**
   * 落版同步后扫描。commentIds = 本次新导入的线程；缺省 = 全量 open 线程
   * （覆盖「评论先存在、触发词后配置」与旧回复补触发词的死角）。
   * 返回实际入队数（供 UI 提示）。
   */
  scan(docId: string, commentIds?: string[]): number {
    let enqueued = 0
    // 空数组同样走全量：user 保存没带来新评论时，仍要覆盖「旧线程补触发词」的死角。
    const targets = commentIds && commentIds.length > 0
      ? commentIds.map(id => this.store.getComment(docId, id)).filter(c => c !== undefined)
      : this.store.listComments(docId, 'open')
    for (const c of targets) {
      if (!c || c.status !== 'open') continue
      const last = c.replies[c.replies.length - 1]
      if (!last || last.role !== 'user' || !wantsAi(last.text)) continue
      if (c.last_auto_reply_id === last.id) continue
      this.store.markAutoTriggered(c.id, last.id)
      const q = this.queue.get(docId) ?? []
      if (q.length >= 5) continue // 队列深度上限
      q.push(c.id)
      this.queue.set(docId, q)
      enqueued++
    }
    void this.drain(docId)
    return enqueued
  }

  pendingCount(docId: string): number {
    return this.queue.get(docId)?.length ?? 0
  }

  private async drain(docId: string): Promise<void> {
    if (this.running.has(docId)) return
    const q = this.queue.get(docId)
    if (!q || q.length === 0) { this.queue.delete(docId); return }
    this.running.add(docId)
    const cid = q.shift()!
    try {
      await this.turns.run(docId, buildCommentPrompt(cid), () => {}, { commentId: cid })
    } catch (err) {
      if (!(err instanceof BusyError)) console.error('[automation] auto turn failed', err)
      // 忙/失败 → 放回队首，等回合结束接力
      const cur = this.queue.get(docId) ?? []
      cur.unshift(cid)
      this.queue.set(docId, cur)
    } finally {
      this.running.delete(docId)
      this.handleTurnEnd(docId)
    }
  }
}
