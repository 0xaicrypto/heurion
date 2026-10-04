import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Documents, CommitEvent } from '../model/runtime.ts'
import { mapNotification, type UiEvent } from '../harness/events.ts'
import type { MemoryService } from '../memory/service.ts'
import type { Alerts } from '../ops-alert/alerts.ts'
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

/** 就诊简报（知家，PATIENT.md §6）：服务端组装的生成指令。简报文档是回合的落点；红线守卫在操作层强制。 */
export function phrBriefPrompt(input: {
  patientId: string; name: string; code: string; sex: 'M' | 'F' | null; birth_year: number | null; tags: string[]
  archiveDocId?: string | null
}): string {
  const who = [input.sex === 'M' ? '男' : input.sex === 'F' ? '女' : '', input.birth_year ? `${input.birth_year} 年生` : '', ...input.tags].filter(Boolean).join('，')
  return (
    `请为家庭成员生成一份「就诊简报」，用 doc_edit 写进本文档（看病前给医生看的准备，不是病历）。\n` +
    `成员：${input.name}（${input.code}；${who || '基本信息待补'}）。patient_id=${input.patientId}。\n` +
    `步骤：\n` +
    `1. patient_read（patient_id）与 labs_query 看最近的化验与记录（重点近 3 个月与异常项）；` +
    (input.archiveDocId ? `doc_outline / doc_read 读健康档案文档 ${input.archiveDocId}，了解背景与医生交代；\n` : `\n`) +
    `2. 用 doc_edit 写三节：\n` +
    `「近况」——最近的数值与变化：照抄数值与单位、注明日期，用记录口径（「检查见…」），不写诊断结论；\n` +
    `「想请医生看的问题」——2–4 个具体、家人真正关心的问题；\n` +
    `「要带的材料」——原始报告、正在用的药物清单、既往小结。\n` +
    `3. 红线：不下诊断；不提用药、剂量或停换药建议；异常数值处写「建议当面咨询医生」；只记录与提问。\n` +
    `写完用一两句话总结。`
  )
}

export interface TurnBusEvent { userId: string; docId: string; event: UiEvent }

export interface TurnOptions {
  /** AI 的写入一律作为待采纳修订。 */
  suggest?: boolean
  /** 评论触发的回合：正在回答的评论线程。 */
  commentId?: string
  /** false = 本轮不用记忆（不注入、memory_* 工具不可用、不产生提议）。 */
  memory?: boolean
}

interface Job {
  id: string
  docId: string
  message: string
  opts: TurnOptions
  enqueuedAt: string
  emit: (e: UiEvent) => void
  done: () => void
}

interface Running {
  job: Job
  turnId: string | null
  startedAt: string
  /** 让正在等待的 dsh 调用立即失败（进程卡住、close 不返回时也能放行队列）。 */
  abort: (reason: Error) => void
}

/** 队列视图（页面的「任务队列」）。 */
export interface QueueItem {
  id: string
  doc_id: string
  doc_title: string
  label: string
  suggest: boolean
  /** running：开始时间；queued：入队时间。 */
  since: string
  turn_id?: string | null
}

export interface QueueView {
  running: QueueItem | null
  queued: QueueItem[]
}

/**
 * 一轮 AI 编辑（PLATFORM.md §6.5）：登记回合 → dsh 执行（经 MCP 读写文档，改动实时提交）
 * → 回合结束为本回合改过的每份文档打一个版本快照。守卫已在每次写入前执行，没有落版前审计 / 丢弃。
 *
 * 每个用户一个 FIFO 队列（一个用户一个 dsh 进程）：对话、评论「让 AI 处理」、@heurion 自动触发
 * 都排进同一队列。所有回合事件同时发到 events（文档的 SSE 流转发给页面）。
 * 排队中的任务持久化在 turn_queue：服务重启后继续执行；用户可以逐个取消排队任务或只停止当前任务。
 */
export class TurnService {
  readonly events = new EventEmitter<{ event: [TurnBusEvent] }>()
  private readonly cancelling = new Set<string>()
  private readonly timedOut = new Set<string>()
  private readonly idleTimeoutMs: number
  private readonly memory: MemoryService | null
  private readonly alerts: Alerts | null
  private readonly queues = new Map<string, Job[]>()
  private readonly running = new Map<string, Running>()

  constructor(
    private readonly docs: Documents,
    private readonly pool: HarnessPool,
    private readonly registry: TurnRegistry,
    opts: { idleTimeoutMs?: number; memory?: MemoryService; alerts?: Alerts } = {},
  ) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000
    this.memory = opts.memory ?? null
    this.alerts = opts.alerts ?? null
  }

  /** 服务启动时恢复：上次没跑完的回合标为中断，排队中的任务重新入队。 */
  restore(): { interrupted: number; requeued: number } {
    const store = this.docs.store
    const interrupted = store.interruptRunningTurns()
    const rows = store.listQueuedJobs()
    for (const row of rows) {
      let opts: TurnOptions = {}
      try { opts = JSON.parse(row.opts) as TurnOptions } catch { /* 用默认 */ }
      this.push(row.user_id, { id: row.id, docId: row.doc_id, message: row.message, opts, enqueuedAt: row.enqueued_at }, () => {}, () => {}, false)
    }
    for (const userId of new Set(rows.map(r => r.user_id))) void this.drain(userId)
    return { interrupted, requeued: rows.length }
  }

  isBusy(userId: string): boolean {
    return this.running.has(userId)
  }

  queued(userId: string): number {
    return this.queues.get(userId)?.length ?? 0
  }

  /** 当前用户的队列：正在执行的一个 + 排队中的（按执行顺序）。 */
  view(userId: string): QueueView {
    const item = (job: Job, since: string, turnId?: string | null): QueueItem => ({
      id: job.id,
      doc_id: job.docId,
      doc_title: this.docs.store.getDoc(job.docId)?.title ?? '（已删除的文档）',
      label: this.label(job),
      suggest: !!job.opts.suggest,
      since,
      ...(turnId !== undefined ? { turn_id: turnId } : {}),
    })
    const r = this.running.get(userId)
    return {
      running: r ? item(r.job, r.startedAt, r.turnId) : null,
      queued: (this.queues.get(userId) ?? []).map(j => item(j, j.enqueuedAt)),
    }
  }

  /** 排队执行一轮；返回的 Promise 在该回合结束时完成。emit 收到本回合的全部事件。 */
  submit(userId: string, docId: string, message: string, emit: (e: UiEvent) => void = () => {}, opts: TurnOptions = {}): Promise<void> {
    const target = this.docs.store.getDoc(docId)
    if (!target || target.deleted_at) return Promise.reject(new Error(`doc ${docId} not found`))
    return new Promise(resolve => {
      const job = { id: 'q' + randomUUID().replace(/-/g, '').slice(0, 11), docId, message, opts, enqueuedAt: new Date().toISOString() }
      this.push(userId, job, emit, resolve, true)
      void this.drain(userId)
    })
  }

  private push(userId: string, base: Omit<Job, 'emit' | 'done'>, emit: (e: UiEvent) => void, done: () => void, persist: boolean): void {
    const publish = (e: UiEvent) => {
      emit(e)
      this.events.emit('event', { userId, docId: base.docId, event: e })
    }
    const q = this.queues.get(userId) ?? []
    const job: Job = { ...base, emit: publish, done }
    q.push(job)
    this.queues.set(userId, q)
    if (persist) {
      this.docs.store.enqueueJob({ id: job.id, user_id: userId, doc_id: job.docId, message: job.message, opts: JSON.stringify(job.opts), enqueued_at: job.enqueuedAt })
    }
    if (this.running.has(userId)) publish({ type: 'queued', position: q.length, message: job.message })
  }

  private async drain(userId: string): Promise<void> {
    if (this.running.has(userId)) return
    const job = this.queues.get(userId)?.shift()
    if (!job) return
    this.docs.store.dequeueJob(job.id)
    // 排队期间文档被删了 / 进了回收站：跳过
    const target = this.docs.store.getDoc(job.docId)
    if (!target || target.deleted_at) { job.done(); void this.drain(userId); return }
    let abort: (reason: Error) => void = () => {}
    const aborted = new Promise<never>((_, reject) => { abort = reject })
    aborted.catch(() => {})
    const r: Running = { job, turnId: null, startedAt: new Date().toISOString(), abort }
    this.running.set(userId, r)
    try {
      await this.execute(userId, job, r, aborted)
    } catch (err) {
      job.emit({ type: 'error', message: String((err as Error).message ?? err) })
    } finally {
      this.running.delete(userId)
      job.emit({ type: 'done' })
      job.done()
      void this.drain(userId)
    }
  }

  private label(job: Job): string {
    const m = /^请处理文档 \S+ 中的评论 (\S+)：/.exec(job.message)
    if (m) {
      const c = this.docs.store.getComment(job.docId, m[1]!)
      const ask = c?.replies.filter(r => r.role === 'user').at(-1)?.text ?? ''
      return `处理评论：${ask.replace(/[@＠]heurion\b/gi, '').trim() || m[1]}`
    }
    if (/^请核对文档 \S+ 中带引用的论断/.test(job.message)) return '核对全部论断'
    return job.message
  }

  private async execute(userId: string, job: Job, r: Running, aborted: Promise<never>): Promise<void> {
    const { docId, message, emit, opts } = job
    const store = this.docs.store
    const doc = store.getDoc(docId)
    if (!doc) throw new Error(`doc ${docId} not found`)

    const turn = store.createTurn({ user_id: userId, doc_id: docId, message, opts: JSON.stringify(opts) })
    r.turnId = turn.id
    const touched = new Set<string>()
    const memoryOn = opts.memory !== false && !!this.memory?.active(userId)
    this.registry.begin(userId, { turnId: turn.id, docId, touched, notify: n => emit(n), mode: opts.suggest ? 'suggest' : 'apply', answering: opts.commentId ?? null, memory: memoryOn })
    // 无响应超时：dsh 的任何通知（模型输出、工具调用 / 结果）或本回合的提交都算动静
    let lastActivity = Date.now()
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity < this.idleTimeoutMs) return
      clearInterval(watchdog)
      this.timedOut.add(userId)
      void this.stopRunning(userId)
    }, Math.min(30_000, Math.max(5, this.idleTimeoutMs / 4)))
    const onCommit = (e: CommitEvent) => {
      if (e.turnId !== turn.id) return
      lastActivity = Date.now()
      touched.add(e.docId)
      emit({ type: 'doc_updated', doc_id: e.docId, rev: e.rev, changes: e.changes.length })
    }
    this.docs.on('commit', onCommit)
    emit({ type: 'turn', turn_id: turn.id, message })

    const history = this.pool.liveSession(userId) === null ? this.recentHistory(docId) : ''
    store.addMessage(docId, 'user', message, turn.id)
    const suggestNote = opts.suggest ? '本轮的修改会作为待用户采纳的修订提交。' : ''
    const memoryBlock = memoryOn ? await this.memory!.forPrompt(userId, docId, message) : ''
    const memoryNote = memoryOn ? '' : opts.memory === false ? '（用户本轮关闭了记忆：不要使用 memory_* 工具，也不要沿用之前回合提到的记忆。）' : ''
    // 记忆紧挨着本轮消息（放在最前面时模型容易照抄消息里的写法而忽略偏好）
    const prompt = `${history}（当前文档：doc_id=${docId}，《${doc.title}》，rev=${this.docs.rev(docId)}）${suggestNote}${memoryNote}\n\n${memoryBlock}${message}`

    let status: 'done' | 'error' | 'cancelled' | 'timeout' = 'done'
    let failure: string | null = null
    let modelError: string | null = null
    try {
      const result = await Promise.race([
        this.pool.run(userId, prompt, (n, sessionId) => {
          lastActivity = Date.now()
          for (const e of mapNotification(n, sessionId)) {
            // 模型调用失败（认证失败、限流、服务出错等）：dsh 正常结束回合但带错误，按失败记，不算「已完成」
            if (e.type === 'error') modelError = e.message
            emit(e)
          }
        }),
        aborted,
      ])
      if (result.finalResponse) store.addMessage(docId, 'assistant', result.finalResponse, turn.id)
      if (modelError) { status = 'error'; failure = modelError }
    } catch (err) {
      status = this.timedOut.has(userId) ? 'timeout' : this.cancelling.has(userId) ? 'cancelled' : 'error'
      const kept = '已提交的修改保留，可撤销本轮或按版本回滚。'
      failure = status === 'timeout'
        ? `模型服务 ${Math.round(this.idleTimeoutMs / 60_000) || '<1'} 分钟无响应，已自动停止`
        : status === 'cancelled' ? '已取消' : String((err as Error).message ?? err)
      emit({
        type: 'error',
        message: status === 'timeout'
          ? `模型服务 ${Math.round(this.idleTimeoutMs / 60_000) || '<1'} 分钟无响应，已自动停止；${kept}`
          : status === 'cancelled' ? `已取消；${kept}` : String((err as Error).message ?? err),
      })
    } finally {
      clearInterval(watchdog)
      this.docs.off('commit', onCommit)
      this.registry.end(userId, turn.id)
      for (const id of touched) {
        const v = this.docs.snapshot(id, 'turn', message.slice(0, 80), turn.id)
        if (v) emit({ type: 'version', doc_id: id, seq: v.seq })
      }
      store.endTurn(turn.id, status, failure)
      // 取消不算故障；出错、超时交给运维告警（模型认证 / 余额问题立即发，其余短时间内多次才发）
      if ((status === 'error' || status === 'timeout') && failure) this.alerts?.turnFailed(failure)
      emit({ type: 'turn_done', turn_id: turn.id, status, docs: [...touched] })
      this.cancelling.delete(userId)
      this.timedOut.delete(userId)
    }
  }

  /** 取消当前回合并清空排队。 */
  async cancel(userId: string): Promise<void> {
    for (const job of this.queues.get(userId) ?? []) this.drop(job)
    this.queues.delete(userId)
    await this.stopRunning(userId)
  }

  /**
   * 取消一个任务：排队中的直接移出；正在执行的只停止它（结束 dsh 进程，下一次任务重新拉起），
   * 排在后面的任务照常执行。返回 false 表示找不到（已经执行完）。
   */
  async cancelJob(userId: string, jobId: string): Promise<boolean> {
    const q = this.queues.get(userId) ?? []
    const i = q.findIndex(j => j.id === jobId)
    if (i >= 0) {
      const [job] = q.splice(i, 1)
      this.drop(job!)
      return true
    }
    if (this.running.get(userId)?.job.id === jobId) {
      await this.stopRunning(userId)
      return true
    }
    return false
  }

  private drop(job: Job): void {
    this.docs.store.dequeueJob(job.id)
    job.emit({ type: 'error', message: '已取消（排队中）' })
    job.emit({ type: 'done' })
    job.done()
  }

  private async stopRunning(userId: string): Promise<void> {
    const r = this.running.get(userId)
    if (!r) return
    this.cancelling.add(userId)
    // 先放行队列，再关闭进程：进程卡住时 close 可能很久不返回
    r.abort(new Error('cancelled'))
    await this.pool.cancel(userId).catch(() => {})
  }

  /** 新会话首轮带上最近 6 条对话。 */
  private recentHistory(docId: string): string {
    const msgs = this.docs.store.listMessages(docId).slice(-6)
    if (msgs.length === 0) return ''
    return `（此前的对话，供参考）\n${msgs.map(m => `${m.role === 'user' ? '用户' : '助手'}：${m.text.slice(0, 500)}`).join('\n')}\n\n`
  }
}
