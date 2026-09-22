import { describe, test, expect, vi } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'
import { extractClinicalEntities } from '../../src/modules/memorization/clinical-extractor.service.js'

/**
 * #高-6 — 临床实体抽取失败必须上抛。此前 catch 后返回形状正常的空结果
 * （entities:[]），把「LLM 超时/故障」伪装成「本轮没有临床内容」，上游
 * #928 的 .catch() 告警永不触发，也没有重试。空结果只允许来自真实的
 * 「LLM 成功但没抽到实体」。
 */
describe('clinical-extractor fail-loud (#高-6)', () => {
  test('LLM 故障 → reject，而不是空结果成功', async () => {
    vi.mocked(deepseekChat).mockRejectedValueOnce(new Error('llm timeout'))
    await expect(extractClinicalEntities('患者主诉头痛三天。')).rejects.toThrow('llm timeout')
  })

  test('LLM 成功但无实体 → 正常返回空数组（与故障可区分）', async () => {
    vi.mocked(deepseekChat).mockResolvedValueOnce(JSON.stringify({ entities: [] }))
    const result = await extractClinicalEntities('今天天气不错。')
    expect(result.entities).toEqual([])
    expect(result.rawCount).toBe(0)
  })
})
