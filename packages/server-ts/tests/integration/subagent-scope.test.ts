import { describe, test, expect, afterEach, vi } from 'vitest'
import { runSubAgent } from '../../src/tools/subagent-runner.js'

/** #510-followup — 深度分析子代理工具白名单按场景裁剪。 */
vi.mock('../../src/common/llm.js', () => ({
  deepseekChat: vi.fn(async () => 'SUBAGENT_SUMMARY: done'),
  getApiKey: vi.fn(() => 'k'),
  DEEPSEEK_CHAT_MODEL: 'deepseek-chat',
}))

describe('#510-followup sub-agent scope tool whitelist', () => {
  afterEach(() => vi.clearAllMocks())

  function makeCtx() {
    return {
      userId: 'u1',
      memory: {} as any,
      facts: {} as any,
      episodes: {} as any,
      skills: {} as any,
      knowledge: {} as any,
      eventLog: {} as any,
    }
  }

  test('global 场景移除患者检索工具', async () => {
    const { deepseekChat } = await import('../../src/common/llm.js')
    await runSubAgent({ task: 't', scope: 'global' }, makeCtx() as any)
    const content = (deepseekChat as any).mock.calls[0][0][0].content as string
    expect(content).not.toContain('search_node')
    expect(content).not.toContain('search_encounter')
    expect(content).not.toContain('search_past_chats')
    expect(content).toContain('search_medical_web')
  })

  test('patient 场景保留患者检索工具', async () => {
    const { deepseekChat } = await import('../../src/common/llm.js')
    await runSubAgent({ task: 't', scope: 'patient:abc' }, makeCtx() as any)
    const content = (deepseekChat as any).mock.calls[0][0][0].content as string
    expect(content).toContain('search_node')
    expect(content).toContain('LIMITED to the patient abc')
  })
})
