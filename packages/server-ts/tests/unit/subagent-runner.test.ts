import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { runSubAgent } from '../../src/tools/subagent-runner.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'

const mockCtx = (): any => ({
  userId: 'user_1',
  sessionId: 'sess_1',
  eventLog: { append: vi.fn() },
  memory: { graph: { getAllNodes: () => [] } },
  facts: { all: () => [] },
  episodes: { all: () => [] },
  skills: { all: () => [] },
  knowledge: { all: () => [] },
})

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

/**
 * #288: sub-agent runner — white-list tools, scope enforcement, turn cap,
 * structured summary, failure isolation.
 */
describe('SubAgentRunner (#288)', () => {
  test('runs a plain task and returns a structured summary', async () => {
    vi.mocked(deepseekChat).mockResolvedValue('Findings: EGFR trials show mixed results.\nSUBAGENT_SUMMARY: 3 RCTs reviewed; mixed benefit in EGFR-mutant NSCLC.')
    const res = await runSubAgent({ task: 'Review EGFR immunotherapy literature' }, mockCtx())
    expect(res.summary).toContain('3 RCTs reviewed')
    expect(res.turns).toBe(1)
    expect(res.costTokens).toBeGreaterThan(0)
    expect(res.toolCalls).toBe(0)
  })

  test('executes white-listed tools in the loop and folds results in', async () => {
    vi.mocked(deepseekChat)
      .mockResolvedValueOnce('<tool_call>{"name":"stat_ttest","arguments":{"group_a":[1,2,3],"group_b":[5,6,7]}}</tool_call>')
      .mockResolvedValueOnce('The t-test shows a significant difference.\nSUBAGENT_SUMMARY: t-test significant (p<0.05)')
    const res = await runSubAgent({ task: 'Compare groups' }, mockCtx())
    expect(res.toolCalls).toBe(1)
    expect(res.turns).toBe(2)
    expect(res.summary).toContain('significant')
    // The tool result was fed back.
    const lastUser = vi.mocked(deepseekChat).mock.calls[1][0].filter((m: any) => m.role === 'user').at(-1)
    expect(String(lastUser?.content || '')).toContain('stat_ttest')
  })

  test('scope enforcement forces patient_hash on patient tools', async () => {
    // search_node requires patient_hash — without scope enforcement the call
    // would fail with "patient_hash and query required". With enforcement the
    // forced hash makes it succeed and return only that patient's nodes.
    const ctx = mockCtx()
    ctx.memory.graph.getAllNodes = () => [
      { id: 'n_abc', type: 'fact', stableId: 'f1', patientHash: 'patient_abc', content: 'outcome data for abc', status: 'current', category: 'fact' },
      { id: 'n_other', type: 'fact', stableId: 'f2', patientHash: 'patient_other', content: 'outcome data for other', status: 'current', category: 'fact' },
    ]
    vi.mocked(deepseekChat)
      .mockResolvedValueOnce('<tool_call>{"name":"search_node","arguments":{"query":"outcome","top_k":5}}</tool_call>')
      .mockResolvedValueOnce('SUBAGENT_SUMMARY: done')
    const res = await runSubAgent({ task: 'Analyze patient', scope: 'patient:patient_abc' }, mockCtx().constructor ? ctx : ctx)
    expect(res.toolCalls).toBe(1)
    const lastUser = vi.mocked(deepseekChat).mock.calls[1][0].filter((m: any) => m.role === 'user').at(-1)
    const content = String(lastUser?.content || '')
    expect(content).toContain('f1')
    expect(content).not.toContain('f2')
    expect(content).not.toContain('required')
  })

  test('disallowed tools are rejected and do not stop the loop', async () => {
    vi.mocked(deepseekChat)
      .mockResolvedValueOnce('<tool_call>{"name":"edit_document","arguments":{}}</tool_call>')
      .mockResolvedValueOnce('SUBAGENT_SUMMARY: blocked write attempt handled')
    const res = await runSubAgent({ task: 'x', tools: ['search_node'] }, mockCtx())
    expect(res.summary).toContain('blocked')
    const lastUser = vi.mocked(deepseekChat).mock.calls[1][0].filter((m: any) => m.role === 'user').at(-1)
    expect(String(lastUser?.content || '')).toContain('not allowed')
  })

  test('turn cap forces a wrap-up', async () => {
    vi.mocked(deepseekChat).mockResolvedValue('<tool_call>{"name":"stat_describe","arguments":{"values":[1,2,3]}}</tool_call>')
    const res = await runSubAgent({ task: 'loop', maxTurns: 2 }, mockCtx())
    expect(res.turns).toBe(2)
    expect(res.summary).toContain('cap')
  })

  test('a failing tool is isolated (other calls still run)', async () => {
    vi.mocked(deepseekChat)
      .mockResolvedValueOnce('<tool_call>{"name":"stat_chisq","arguments":{"table":[[1,2]]}}</tool_call><tool_call>{"name":"stat_describe","arguments":{"values":[1,2,3,4]}}</tool_call>')
      .mockResolvedValueOnce('SUBAGENT_SUMMARY: isolated failure survived')
    const res = await runSubAgent({ task: 'x' }, mockCtx())
    expect(res.toolCalls).toBe(2)
    const lastUser = vi.mocked(deepseekChat).mock.calls[1][0].filter((m: any) => m.role === 'user').at(-1)
    const content = String(lastUser?.content || '')
    expect(content).toContain('ERROR')
    expect(content).toContain('stat_describe') // second call still executed
  })
})
