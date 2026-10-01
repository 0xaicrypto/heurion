import { EventEmitter } from 'node:events'
import type { Documents, CommitEvent } from '../model/runtime.ts'
import { mapNotification, type UiEvent } from '../harness/events.ts'
import type { HarnessPool } from '../harness/pool.ts'
import type { TurnRegistry } from '../mcp/turns.ts'

/** 评论触发回合的提示（服务端组装，前端不拼自然语言）。幻灯片与文档用不同的读写工具。 */
export function commentPrompt(docId: string, commentId: string, kind: 'doc' | 'deck' = 'doc'): string {
  const edit = kind === 'deck'
    ? `2. 锚点 node_ids 是形状 id：用 doc_outline 找到它所在的页，slide_read 读这一页，用 deck_edit（replace_text 或 set_text，沿用原格式）完成修改，改完用 layout_check 检查是否溢出；\n`
    : `2. 按锚点所在块 id 用 doc_read 读取上下文，用 doc_edit 完成修改；\n`
  return (
    `请处理文档 ${docId} 中的评论 ${commentId}：\n` +
    `1. comments_list（doc_id="${docId}", comment_id="${commentId}"）读取锚点与要求；\n` +
    edit +
    `3. 用 comment_reply 说明改了什么、改在哪（线程留给用户确认后关闭）；确实无需改动时说明原因后 comment_resolve。\n` +
    `只处理这一条评论。`
  )
}

/** 评论 / 回复里召唤 AI 的触发词。 */
export const wantsAi = (text: string): boolean => /[@＠]heurion\b/i.test(text)

export interface TurnBusEvent { userId: string; docId: string; event: UiEvent }

export interface TurnOptions {
  /** AI 的写入一律作为待采纳修订。 */
  suggest?: boolean
}

interface Job {
  docId: string
  message: string
  opts: TurnOptions
  emit: (e: UiEvent) => void
  done: () => void
}

/**
 * 一轮 AI 编辑（PLATFORM.md §6.5）：登记回合 → dsh 执行（经 MCP 读写文档，改动实时提交）
 * → 回合结束为本回合改过的每份文档打一个版本快照。守卫已在每次写入前执行，没有落版前审计 / 丢弃。
 *
 * 每个用户一个 FIFO 队列（一个用户一个 dsh 进程）：对话、评论「让 AI 处理」、@heurion 自动触发
 * 都排进同一队列。所有回合事件同时发到 events（文档的 SSE 流转发给页面）。
 */
export class TurnService {
  readonly events = new EventEmitter<{ event: [TurnBusEvent] }>()
  private readonly cancelling = new Set<string>()
  private readonly queues = new Map<string, Job[]>()
  private readonly running = new Set<string>()

  constructor(
    private readonly docs: Documents,
    private readonly pool: HarnessPool,
    private readonly registry: TurnRegistry,
  ) {}

  isBusy(userId: string): boolean {
    return this.running.has(userId)
  }

  queued(userId: string): number {
    return this.queues.get(userId)?.length ?? 0
  }

  /** 排队执行一轮；返回的 Promise 在该回合结束时完成。emit 收到本回合的全部事件。 */
  submit(userId: string, docId: string, message: string, emit: (e: UiEvent) => void = () => {}, opts: TurnOptions = {}): Promise<void> {
    if (!this.docs.store.getDoc(docId)) return Promise.reject(new Error(`doc ${docId} not found`))
    return new Promise(resolve => {
      const publish = (e: UiEvent) => {
        emit(e)
        this.events.emit('event', { userId, docId, event: e })
      }
      const q = this.queues.get(userId) ?? []
      q.push({ docId, message, opts, emit: publish, done: resolve })
      this.queues.set(userId, q)
      if (this.running.has(userId)) publish({ type: 'queued', position: q.length, message })
      void this.drain(userId)
    })
  }

  private async drain(userId: string): Promise<void> {
    if (this.running.has(userId)) return
    const job = this.queues.get(userId)?.shift()
    if (!job) return
    this.running.add(userId)
    try {
      await this.execute(userId, job.docId, job.message, job.emit, job.opts)
    } catch (err) {
      job.emit({ type: 'error', message: String((err as Error).message ?? err) })
    } finally {
      this.running.delete(userId)
      job.emit({ type: 'done' })
      job.done()
      void this.drain(userId)
    }
  }

  private async execute(userId: string, docId: string, message: string, emit: (e: UiEvent) => void, opts: TurnOptions): Promise<void> {
    const store = this.docs.store
    const doc = store.getDoc(docId)
    if (!doc) throw new Error(`doc ${docId} not found`)

    const turn = store.createTurn({ user_id: userId, doc_id: docId, message })
    const touched = new Set<string>()
    this.registry.begin(userId, { turnId: turn.id, touched, notify: n => emit(n), mode: opts.suggest ? 'suggest' : 'apply' })
    const onCommit = (e: CommitEvent) => {
      if (e.turnId !== turn.id) return
      touched.add(e.docId)
      emit({ type: 'doc_updated', doc_id: e.docId, rev: e.rev, changes: e.changes.length })
    }
    this.docs.on('commit', onCommit)
    emit({ type: 'turn', turn_id: turn.id, message })

    const history = this.pool.liveSession(userId) === null ? this.recentHistory(docId) : ''
    store.addMessage(docId, 'user', message, turn.id)
    const suggestNote = opts.suggest ? '本轮的修改会作为待用户采纳的修订提交。' : ''
    const prompt = `${history}（当前文档：doc_id=${docId}，《${doc.title}》，rev=${this.docs.rev(docId)}）${suggestNote}\n\n${message}`

    let status: 'done' | 'error' | 'cancelled' = 'done'
    try {
      const result = await this.pool.run(userId, prompt, (n, sessionId) => {
        for (const e of mapNotification(n, sessionId)) emit(e)
      })
      if (result.finalResponse) store.addMessage(docId, 'assistant', result.finalResponse, turn.id)
    } catch (err) {
      status = this.cancelling.has(userId) ? 'cancelled' : 'error'
      emit({ type: 'error', message: status === 'cancelled' ? '已取消；已提交的修改保留，可撤销本轮或按版本回滚。' : String((err as Error).message ?? err) })
    } finally {
      this.docs.off('commit', onCommit)
      this.registry.end(userId, turn.id)
      for (const id of touched) {
        const v = this.docs.snapshot(id, 'turn', message.slice(0, 80), turn.id)
        if (v) emit({ type: 'version', doc_id: id, seq: v.seq })
      }
      store.endTurn(turn.id, status)
      emit({ type: 'turn_done', turn_id: turn.id, status, docs: [...touched] })
      this.cancelling.delete(userId)
    }
  }

  /** 取消当前回合并清空排队。 */
  async cancel(userId: string): Promise<void> {
    for (const job of this.queues.get(userId) ?? []) {
      job.emit({ type: 'error', message: '已取消（排队中）' })
      job.emit({ type: 'done' })
      job.done()
    }
    this.queues.delete(userId)
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
