import type { Documents, CommitEvent } from '../model/runtime.ts'
import { mapNotification, type UiEvent } from '../harness/events.ts'
import type { HarnessPool } from '../harness/pool.ts'
import type { TurnRegistry } from '../mcp/turns.ts'

export class BusyError extends Error {}

/** 评论触发回合的提示（服务端组装，前端不拼自然语言）。 */
export function commentPrompt(docId: string, commentId: string): string {
  return (
    `请处理文档 ${docId} 中的评论 ${commentId}：\n` +
    `1. comments_list（doc_id="${docId}", comment_id="${commentId}"）读取锚点与要求；\n` +
    `2. 按锚点所在块 id 用 doc_read 读取上下文，用 doc_edit 完成修改；\n` +
    `3. 用 comment_reply 说明改了什么、改在哪（线程留给用户确认后关闭）；确实无需改动时说明原因后 comment_resolve。\n` +
    `只处理这一条评论。`
  )
}

/**
 * 一轮 AI 编辑（PLATFORM.md §6.5）：登记回合 → dsh 执行（经 MCP 读写文档，改动实时提交）
 * → 回合结束为本回合改过的每份文档打一个版本快照。没有「落版前审计 / 丢弃」：
 * 守卫已在每次写入前执行，违规的写入根本不会发生。
 */
export class TurnService {
  private readonly cancelling = new Set<string>()

  constructor(
    private readonly docs: Documents,
    private readonly pool: HarnessPool,
    private readonly registry: TurnRegistry,
  ) {}

  isBusy(userId: string): boolean {
    return this.pool.isBusy(userId)
  }

  async run(userId: string, docId: string, message: string, emit: (e: UiEvent) => void): Promise<void> {
    const store = this.docs.store
    const doc = store.getDoc(docId)
    if (!doc) throw new Error(`doc ${docId} not found`)
    if (this.pool.isBusy(userId) || this.registry.active(userId)) throw new BusyError('AI 正在处理上一条请求')

    const turn = store.createTurn({ user_id: userId, doc_id: docId, message })
    const touched = new Set<string>()
    this.registry.begin(userId, { turnId: turn.id, touched, notify: n => emit(n) })
    const onCommit = (e: CommitEvent) => {
      if (e.turnId !== turn.id) return
      touched.add(e.docId)
      emit({ type: 'doc_updated', doc_id: e.docId, rev: e.rev, changes: e.changes.length })
    }
    this.docs.on('commit', onCommit)
    emit({ type: 'turn', turn_id: turn.id })

    const history = this.pool.liveSession(userId) === null ? this.recentHistory(docId) : ''
    store.addMessage(docId, 'user', message, turn.id)
    const prompt = `${history}（当前文档：doc_id=${docId}，《${doc.title}》，rev=${this.docs.rev(docId)}）\n\n${message}`

    let status: 'done' | 'error' | 'cancelled' = 'done'
    try {
      const result = await this.pool.run(userId, prompt, (n, sessionId) => {
        for (const e of mapNotification(n, sessionId)) emit(e)
      })
      if (result.finalResponse) store.addMessage(docId, 'assistant', result.finalResponse, turn.id)
    } catch (err) {
      status = this.cancelling.has(userId) ? 'cancelled' : 'error'
      emit({ type: 'error', message: status === 'cancelled' ? '已取消；已提交的修改保留，可按版本回滚。' : String((err as Error).message ?? err) })
    } finally {
      this.docs.off('commit', onCommit)
      this.registry.end(userId, turn.id)
      for (const id of touched) {
        const v = this.docs.snapshot(id, 'turn', message.slice(0, 80), turn.id)
        if (v) emit({ type: 'version', doc_id: id, seq: v.seq })
      }
      store.endTurn(turn.id, status)
      this.cancelling.delete(userId)
    }
  }

  async cancel(userId: string): Promise<void> {
    if (this.registry.active(userId)) this.cancelling.add(userId)
    await this.pool.cancel(userId)
  }

  /** 新会话首轮带上最近 6 条对话。 */
  private recentHistory(docId: string): string {
    const msgs = this.docs.store.listMessages(docId).slice(-6)
    if (msgs.length === 0) return ''
    return `（此前的对话，供参考）\n${msgs.map(m => `${m.role === 'user' ? '用户' : '助手'}：${m.text.slice(0, 500)}`).join('\n')}\n\n`
  }
}
