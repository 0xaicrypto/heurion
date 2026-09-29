import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * #1149 — cf-browser-agent 只执行一步的假成功回归：
 * ai@6 generateText 默认 stopWhen = stepCountIs(1)（LLM 发一个工具调用即停，
 * 看不到工具结果）；text 为空时旧实现回退「任务完成」+ success。
 * 修复：显式多步 stopWhen + 超时；空 text 抛错（worker 映射 502）。
 */
const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  createBrowserTools: vi.fn(() => ({ browser_execute: {}, browser_search: {} })),
}))

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: mocks.generateText }
})
vi.mock('agents/browser/ai', () => ({ createBrowserTools: mocks.createBrowserTools }))
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () => ({ chat: () => ({ id: 'mock-model' }) }),
}))

import { runBrowserTask, BROWSER_TASK_MAX_STEPS } from '../src/agent.js'

beforeEach(() => {
  mocks.generateText.mockReset()
})

describe('#1149 browser task 多步执行', () => {
  test('generateText 显式携带多步 stopWhen + 超时（默认单步 = LLM 看不到工具结果）', async () => {
    mocks.generateText.mockResolvedValue({ text: '已打开页面并读取标题' })
    const out = await runBrowserTask(
      { instruction: '打开 heurion.org 并读取标题' },
      { browser: {}, llm: { id: 'm' } },
    )
    expect(out.conclusion).toBe('已打开页面并读取标题')
    const args = mocks.generateText.mock.calls[0][0] as { stopWhen?: unknown; abortSignal?: unknown }
    expect(args.stopWhen, '缺少 stopWhen → 默认只跑一步').toBeDefined()
    expect(args.abortSignal).toBeDefined()
    expect(BROWSER_TASK_MAX_STEPS).toBeGreaterThan(1)
  })

  test('空 text → 抛错（不再回退「任务完成」假成功）', async () => {
    mocks.generateText.mockResolvedValue({ text: '' })
    await expect(
      runBrowserTask({ instruction: 'x' }, { browser: {}, llm: { id: 'm' } }),
    ).rejects.toThrow(/no conclusion/)
    mocks.generateText.mockResolvedValue({ text: '   ' })
    await expect(
      runBrowserTask({ instruction: 'x' }, { browser: {}, llm: { id: 'm' } }),
    ).rejects.toThrow(/no conclusion/)
  })
})
