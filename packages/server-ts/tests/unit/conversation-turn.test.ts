import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import type { ChatStreamChunk } from '@heurion/contracts'

/**
 * #1106 — conversation-turn 特性测试锚（characterization tests）。
 *
 * conversation-turn 此前无专属测试文件（仅靠 6 个测试间接覆盖）。
 * 本文件在重构前钉死既有可观测行为，重构后作为行为零漂移的闸门：
 *   - 正常回合：装配进度 SSE → 工具循环收尾文本 → final_answer_chunk
 *     → turn_complete + pipeline 落库
 *   - 患者上下文回合：Current Patient Context 块前置进 user message
 *   - 「list my patients」确定性问答：零 LLM 调用
 *   - 写回回合（doc 会话）：edit_deck_bytes 真实执行（pptx-viewer-core
 *     字节管线，deck-bytes 边界 mock）→ doc_updated（deck 过 schema）
 *   - 预算耗尽退出：runToolCallLoop 返回 exhaustedReason → 熔断警示
 *     并入 finalContent
 *   - 救援循环（rescue）：零写回 + 编辑意图 → runDocExecutorFallback
 *     被触发，成功后采纳 rescue 汇报文本
 *
 * 接线方式（与 doc-executor.test.ts / edit-claim-guard.test.ts 同款）：
 * - prisma 全量 mock，不触真实 DB
 * - llm 走共享 ai-mock：deepseekChatWithToolsStream 未 mock → 抛 TypeError
 *   → tool-loop 回退 deepseekChatWithMeta → 命中 mock 的 deepseekChat
 * - 编排边界（history-budget / post-turn-pipeline / knowledge 注入 /
 *   session 引用 / plan-store / 执行面 / 技能激活 / persona 蒸馏）mock 为
 *   可观察的稳定实现 — runConversationTurn 本体的装配/预算/流式/兜底
 *   接线全部是真实代码路径。
 */

const mocks = vi.hoisted(() => ({
  patientFindFirst: vi.fn(async () => null),
  patientFindMany: vi.fn(async () => []),
  docFindFirst: vi.fn(async () => null),
  docUpdateMany: vi.fn(async () => ({ count: 1 })),
  docSnapshotCreate: vi.fn(async () => ({})),
  sectionMetaFindMany: vi.fn(async () => []),
  sectionMetaUpsert: vi.fn(async () => ({})),
  sectionMetaDeleteMany: vi.fn(async () => ({ count: 0 })),
  getDeckArtifact: vi.fn(async () => null),
  putDeckArtifact: vi.fn(async () => ({
    artifactId: 'deckA1', version: 'deckA1', changed: true, projection: null, conflict: false, error: undefined,
  })),
  loadHistoryBudget: vi.fn(async () => ({
    history: [], historyMessages: [], omittedTurns: 0,
    historyTokens: 0, maxHistoryTokens: 12000, historyTurns: 12,
  })),
  runPostTurnPipeline: vi.fn(async () => {}),
  loadActivePlan: vi.fn(async () => null),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    patientRecord: { findFirst: mocks.patientFindFirst, findMany: mocks.patientFindMany },
    fileIndex: { findMany: vi.fn(async () => []) },
    researchStudy: { findMany: vi.fn(async () => []) },
    doc: { findFirst: mocks.docFindFirst, updateMany: mocks.docUpdateMany },
    docSnapshot: { create: mocks.docSnapshotCreate },
    docSectionMeta: {
      findMany: mocks.sectionMetaFindMany,
      upsert: mocks.sectionMetaUpsert,
      deleteMany: mocks.sectionMetaDeleteMany,
    },
  },
}))

vi.mock('../../src/lib/deck-bytes.js', () => ({
  getDeckArtifact: mocks.getDeckArtifact,
  putDeckArtifact: mocks.putDeckArtifact,
  serializeDeckWireToPptx: vi.fn(async () => { throw new Error('serializeDeckWireToPptx not expected in this test') }),
}))

vi.mock('../../src/common/llm.js', () => mockAiProvider())

vi.mock('../../src/modules/chat/history-budget.js', () => ({
  loadHistoryBudget: mocks.loadHistoryBudget,
  maybeTriggerCompaction: vi.fn(async () => {}),
  triggerCompactionAfterTrim: vi.fn(),
  upsertSessionRow: vi.fn(async () => {}),
}))

vi.mock('../../src/modules/chat/post-turn-pipeline.js', () => ({
  runPostTurnPipeline: mocks.runPostTurnPipeline,
}))

vi.mock('../../src/common/plan-store.js', () => ({
  loadActivePlan: mocks.loadActivePlan,
  renderPlanBlock: vi.fn(() => ''),
  planBacklog: vi.fn(() => 0),
  renderPendingSteps: vi.fn(() => ''),
  autoAdvanceWriteStep: vi.fn(async () => null),
  markWriteStepFailed: vi.fn(async () => null),
  backlogExceedsRounds: vi.fn(() => false),
}))

vi.mock('../../src/modules/chat/doc-context-builder.js', () => ({
  buildDocumentContext: vi.fn(async () => ''),
}))

vi.mock('../../src/modules/chat/session-refs-builder.js', () => ({
  buildSessionReferencesBlock: vi.fn(async () => ''),
}))

vi.mock('../../src/modules/knowledge/knowledge-inject.js', () => ({
  buildKnowledgeInjection: vi.fn(async () => ''),
}))

vi.mock('../../src/modules/knowledge/jit-synthesis.service.js', () => ({
  maybeJitSynthesize: vi.fn(async () => ({})),
}))

vi.mock('../../src/memory/embedding/embedding.service.js', () => ({
  EmbeddingService: class EmbeddingServiceStub {
    constructor(_userId?: string, _memory?: unknown) { void _userId; void _memory }
  },
}))

vi.mock('../../src/modules/execution/execution-plane.service.js', () => ({
  createExecutionPlaneService: vi.fn(() => ({})),
}))

vi.mock('../../src/modules/skills/activation.js', () => ({
  matchSkillsForTurn: vi.fn(() => []),
}))

vi.mock('../../src/modules/shared/user-context.js', () => ({
  buildCachedPersona: vi.fn(() => 'You are a helpful medical writing assistant.'),
  buildFileContext: vi.fn(() => '## Recent Files'),
}))

import { deepseekChat } from '../../src/common/llm.js'
import { runConversationTurn, findPatient } from '../../src/modules/chat/conversation-turn.js'
import type { TurnIO } from '../../src/modules/chat/tool-loop.js'

// 运行时构造 tool-call 文本协议标记(避免测试源码出现可执行协议明文)。
const LT = String.fromCharCode(60)
const OPEN = LT + 'tool_call' + '>'
const CLOSE = LT + '/' + 'tool_call' + '>'
const callBlock = (json: string) => OPEN + json + CLOSE

const VALID_DOC_ID = 'doc_00aa11bb22cc33dd'
const VALID_SESSION = `doc-${VALID_DOC_ID}`
const DOC_BODY = '# 汇报\n\n正文内容。'

beforeEach(() => {
  vi.mocked(deepseekChat).mockReset()
  mocks.runPostTurnPipeline.mockClear()
  mocks.docFindFirst.mockResolvedValue(null)
  mocks.getDeckArtifact.mockResolvedValue(null)
  mocks.putDeckArtifact.mockClear()
  mocks.patientFindFirst.mockResolvedValue(null)
  mocks.patientFindMany.mockResolvedValue([])
})

/** 统一的 send/io 双通道捕获 — conversation-turn SSE 与 tool-loop SSE 同流。 */
function captureSSE() {
  const chunks: ChatStreamChunk[] = []
  const send = (c: ChatStreamChunk) => chunks.push(c)
  const io: TurnIO = { send: send as unknown as TurnIO['send'], signal: new AbortController().signal }
  return { chunks, send, io }
}

function makeCtx(): any {
  return {
    userId: 'user_1',
    sessionId: 'sess_anchor',
    eventLog: { append: vi.fn(), query: () => [], count: () => 0 },
    memory: { graph: { getAllNodes: () => [], getCurrentNodesByType: () => [] } },
    facts: { all: () => [] },
    episodes: { all: () => [] },
    skills: { all: () => [] },
    knowledge: { all: () => [] },
    orchestrator: { projection: { project: vi.fn(async () => ({ systemPrompt: 'SYS', segments: [], budget: [] })) } },
  }
}

/** runConversationTurn 的最小入参 — 覆盖点按用例覆写。 */
function makeParams(overrides: Record<string, unknown> = {}) {
  const { io, send } = captureSSE()
  const p = {
    userId: 'user_1',
    ctx: makeCtx(),
    sid: 'sess_anchor',
    patientHash: null,
    scene: 'general',
    body: { text: '你好' },
    apiKey: 'k',
    send,
    signal: io.signal,
    chatAbort: new AbortController(),
    io,
    routeResult: { intent: 'file' },
    turnIntent: { action: 'generate', needsClarify: false },
    ...overrides,
  }
  return p as unknown as Parameters<typeof runConversationTurn>[0]
}

const answerText = (chunks: ChatStreamChunk[]) =>
  chunks.filter((c) => c.type === 'final_answer_chunk').map((c) => (c as any).text).join('')

describe('#1106 conversation-turn — 正常回合（文本直答）', () => {
  test('装配进度 → 工具循环收尾 → final_answer_chunk 分块 → turn_complete + pipeline', async () => {
    const { chunks } = captureSSE()
    const p = makeParams()
    p.send = chunks.push.bind(chunks) as unknown as typeof p.send

    vi.mocked(deepseekChat).mockResolvedValueOnce('这是 AI 的回答。')

    await runConversationTurn(p)

    // 单次 LLM 调用（无工具轮次）
    expect(deepseekChat).toHaveBeenCalledTimes(1)

    // 装配阶段进度事件真实发出（file_context 形态）
    const infos = chunks.filter((c) => c.type === 'context_info')
    expect(infos.some((c) => (c as any).text === '正在整理上下文…')).toBe(true)
    expect(infos.some((c) => String((c as any).text).includes('上下文就绪'))).toBe(true)

    // 上下文用量事件：历史预算 + 系统预算回填两次
    expect(chunks.filter((c) => c.type === 'context_usage')).toHaveLength(2)

    // 收尾文本经 final_answer_chunk 到达（80 字符分块，无损拼回）
    expect(answerText(chunks)).toBe('这是 AI 的回答。')

    // pipeline 落库 + turn_complete 收尾
    expect(mocks.runPostTurnPipeline).toHaveBeenCalledTimes(1)
    expect(mocks.runPostTurnPipeline.mock.calls[0][0].fullResponse).toBe('这是 AI 的回答。')
    expect(chunks.at(-1)!.type).toBe('turn_complete')
  })

  test('patientHash 存在 → Current Patient Context 块前置进 user message', async () => {
    const p = makeParams({ patientHash: 'ph_1' })
    mocks.patientFindFirst.mockResolvedValueOnce({
      initials: 'ZP', age: 45, sex: 'M', chiefComplaint: '咳嗽',
    })

    vi.mocked(deepseekChat).mockResolvedValueOnce('好的。')
    await runConversationTurn(p)

    const firstCall = vi.mocked(deepseekChat).mock.calls[0]
    const userMsg = (firstCall?.[0] as any[]).at(-1)
    const text = String(userMsg?.content)
    expect(text).toContain('## Current Patient Context')
    expect(text).toContain('- Name: ZP')
    expect(text).toContain('- Age: 45')
    expect(text).toContain('咳嗽')
    expect(text).toContain('你好')
  })

  test('list-my-patients 确定性问答 → 不调 LLM,直接 roster 回答', async () => {
    const p = makeParams({ body: { text: 'list all my patients' } })
    const { chunks } = captureSSE()
    p.send = chunks.push.bind(chunks) as unknown as typeof p.send
    mocks.patientFindMany.mockResolvedValueOnce([
      { initials: 'ZP', chiefComplaint: '咳嗽' },
    ])

    await runConversationTurn(p)

    expect(deepseekChat).not.toHaveBeenCalled()
    expect(answerText(chunks)).toContain('ZP: 咳嗽')
    expect(chunks.some((c) => c.type === 'citations')).toBe(true)
    expect(chunks.at(-1)!.type).toBe('turn_complete')
  })
})

describe('#1106 conversation-turn — 写回回合（doc 会话 edit_deck_bytes 字节管线）', () => {
  test('edit_deck_bytes 执行 → doc_updated(deck 过 schema) → 收尾文本采纳', async () => {
    const p = makeParams({ sid: VALID_SESSION, scene: 'document', body: { text: '改一下 deck 标题' } })
    const { chunks, send } = captureSSE()
    p.send = send as unknown as typeof p.send
    p.io = { send: send as unknown as TurnIO['send'], signal: new AbortController().signal }

    // 真实字节工件：pptx-viewer-core 构建单页 pptx（标题文本可被 set_text 命中）
    const { Presentation } = await import('pptx-viewer-core')
    const pres = await Presentation.create({ title: '研究汇报' })
    const sb = pres.addSlide()
    sb.addText('研究汇报', { x: 60, y: 40, width: 1160, height: 90, fontSize: 30, bold: true })
    const bytes = Buffer.from(await pres.save())

    mocks.docFindFirst.mockResolvedValue({
      id: VALID_DOC_ID, userId: 'user_1', title: '研究汇报',
      body: DOC_BODY, deck: null, deckArtifactId: 'deckA1', blockProjection: null,
    })
    mocks.getDeckArtifact.mockResolvedValue({ artifactId: 'deckA1', bytes, version: 'deckA1', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', updatedAt: new Date() })
    mocks.putDeckArtifact.mockResolvedValue({
      artifactId: 'deckA1', version: 'deckA2', changed: true,
      projection: JSON.stringify({
        title: '新标题',
        slides: [{ title: '新标题', content: [{ type: 'paragraph', text: '正文内容。', style: 'bullet' }] }],
      }),
      conflict: false, error: undefined,
    })

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"edit_deck_bytes","arguments":{"actions":[{"op":"set_text","find":"研究汇报","replace":"新标题"}],"summary":"标题已改"}}'))
      .mockResolvedValueOnce('标题已改好。')

    await runConversationTurn(p)

    expect(mocks.putDeckArtifact).toHaveBeenCalledTimes(1)
    const docUpdated = chunks.find((c) => c.type === 'doc_updated') as any
    expect(docUpdated).toBeTruthy()
    // deck 形状经 tool-loop 产出端 deckWireSchema 校验后透传
    expect(docUpdated.deck?.title).toBe('新标题')
    expect(docUpdated.rev).toBeGreaterThan(0)
    expect(answerText(chunks)).toBe('标题已改好。')
    expect(mocks.runPostTurnPipeline.mock.calls[0][0].fullResponse).toBe('标题已改好。')
    expect(chunks.at(-1)!.type).toBe('turn_complete')
  })
})

describe('#1106 conversation-turn — 预算耗尽退出', () => {
  test('回合预算轮次用尽 → 熔断警示并入 finalContent + context_info', async () => {
    vi.stubEnv('TURN_MAX_ROUNDS', '2')
    try {
      const p = makeParams({ body: { text: '继续干活' } })
      const { chunks, send } = captureSSE()
      p.send = send as unknown as typeof p.send

      vi.mocked(deepseekChat).mockResolvedValue(callBlock('{"name":"search_node","arguments":{"patient_hash":"p1","query":"q"}}'))

      await runConversationTurn(p)

      // 预算 2 轮封顶 → 不烧第 3 轮 LLM
      expect(deepseekChat).toHaveBeenCalledTimes(2)
      const infos = chunks.filter((c) => c.type === 'context_info')
      expect(infos.some((c) => String((c as any).text).includes('已达上限'))).toBe(true)
      // 提示并入 finalContent（刷新后仍可回溯）
      expect(answerText(chunks)).toContain('已停止本轮自动重试')
      expect(chunks.at(-1)!.type).toBe('turn_complete')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('#1106 conversation-turn — 救援循环（rescue）', () => {
  test('主回路零写回+编辑意图 → runDocExecutorFallback 触发,成功后采纳 rescue 汇报', async () => {
    const p = makeParams({
      sid: VALID_SESSION, scene: 'document',
      body: { text: '把 deck 里的「研究汇报」修改为「疗效结果」' },
    })
    const { chunks, send } = captureSSE()
    p.send = send as unknown as typeof p.send
    p.io = { send: send as unknown as TurnIO['send'], signal: new AbortController().signal }

    const { Presentation } = await import('pptx-viewer-core')
    const pres = await Presentation.create({ title: '研究汇报' })
    const sb = pres.addSlide()
    sb.addText('研究汇报', { x: 60, y: 40, width: 1160, height: 90, fontSize: 30, bold: true })
    const bytes = Buffer.from(await pres.save())

    mocks.docFindFirst.mockResolvedValue({
      id: VALID_DOC_ID, userId: 'user_1', title: '研究汇报',
      body: DOC_BODY, deck: null, deckArtifactId: 'deckA1', blockProjection: null,
    })
    mocks.getDeckArtifact.mockResolvedValue({ artifactId: 'deckA1', bytes, version: 'deckA1', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', updatedAt: new Date() })
    mocks.putDeckArtifact.mockResolvedValue({
      artifactId: 'deckA1', version: 'deckA2', changed: true,
      projection: JSON.stringify({
        title: '疗效结果',
        slides: [{ title: '疗效结果', content: [{ type: 'paragraph', text: '正文内容。', style: 'bullet' }] }],
      }),
      conflict: false, error: undefined,
    })

    // 1) 主回路声明零写回 → 触发 rescue
    // 2) rescue 第 1 轮：edit_deck_bytes 调用
    // 3) rescue 第 2 轮：收尾汇报
    vi.mocked(deepseekChat)
      .mockResolvedValueOnce('我将修改 deck 标题，请稍候。')
      .mockResolvedValueOnce(callBlock('{"name":"edit_deck_bytes","arguments":{"actions":[{"op":"set_text","find":"研究汇报","replace":"疗效结果"}],"summary":"标题已更新"}}'))
      .mockResolvedValueOnce('已完成修改：deck 标题 → 疗效结果。')

    await runConversationTurn(p)

    // rescue 真实写回成功 → 采纳 rescue 的汇报文本
    expect(answerText(chunks)).toBe('已完成修改：deck 标题 → 疗效结果。')
    // rescue 写回也走同一 TurnIO → doc_updated 到达
    const docUpdated = chunks.find((c) => c.type === 'doc_updated') as any
    expect(docUpdated?.deck?.title).toBe('疗效结果')
    // pipeline 收到 rescue 后的最终回复
    expect(mocks.runPostTurnPipeline.mock.calls[0][0].fullResponse).toBe('已完成修改：deck 标题 → 疗效结果。')
  })

  test('非 doc 会话零写回 → 不触发 rescue（主回路结果原样收尾）', async () => {
    const p = makeParams({ body: { text: '谢谢，帮我总结一下' } })
    vi.mocked(deepseekChat).mockResolvedValueOnce('文档主旨是…')

    await runConversationTurn(p)

    expect(deepseekChat).toHaveBeenCalledTimes(1)
    expect(mocks.runPostTurnPipeline.mock.calls[0][0].fullResponse).toBe('文档主旨是…')
  })
})

describe('#1106 findPatient（conversation-turn 患者查询）', () => {
  test('无 patientHash → null；有 → 按 hash+userId 查', async () => {
    expect(await findPatient('user_1', null)).toBeNull()
    mocks.patientFindFirst.mockResolvedValueOnce({ initials: 'A' })
    const patient = await findPatient('user_1', 'hash_x')
    expect(patient).toEqual({ initials: 'A' })
    expect(mocks.patientFindFirst).toHaveBeenCalledWith({ where: { hash: 'hash_x', userId: 'user_1' } })
  })
})
