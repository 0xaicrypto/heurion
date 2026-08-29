/**
 * 插件路由兜底分支 — 「generate 已被上游裁定，但触发词未命中本轮文本」。
 *
 * 裸确认（是的/开始）承接会话里的撰写邀约时，LLM 裁决会判 generate，
 * 但插件触发词（docx/ppt/表格…）不可能出现在两个字里。此时：
 *   - 已安装插件 → fallback 回常规对话（绝不能再提示"去装插件"——死循环）；
 *   - 确实未安装 → 保留安装提示（这是唯一诚实的回答）。
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { handlePluginChatRequest } from '../../src/modules/plugins/plugin-chat-handler.js'

const mockMatchIntent = vi.fn()
const mockHasActivePlugins = vi.fn()
const mockBuildPayload = vi.fn()

vi.mock('../../src/modules/plugins/plugin-capability.service.js', () => ({
  matchIntent: (...args: unknown[]) => mockMatchIntent(...args),
  hasActivePlugins: (...args: unknown[]) => mockHasActivePlugins(...args),
  buildPayload: (...args: unknown[]) => mockBuildPayload(...args),
}))

vi.mock('../../src/modules/plugins/plugin-audit-log.service.js', () => ({
  buildInputSummary: () => '',
  recordPluginInvocation: async () => {},
}))

const options = (text: string) => ({
  userId: 'u1',
  workspaceId: 'u1',
  text,
  send: () => {},
})

beforeEach(() => {
  mockMatchIntent.mockReset()
  mockHasActivePlugins.mockReset()
  mockBuildPayload.mockReset()
  mockMatchIntent.mockResolvedValue(null)
})

describe('插件路由兜底：触发词未命中时区分「未安装」与「已安装」', () => {
  test('已安装插件但裸确认无触发词 → fallback 回常规对话，不提示安装', async () => {
    mockHasActivePlugins.mockResolvedValue(true)
    const r = await handlePluginChatRequest(options('是的'))
    expect(r.fallback).toBe(true)
    expect(r.text).toBe('')
    expect(r.text).not.toContain('插件市场')
  })

  test('确认未安装任何插件 → 保留安装提示（不 fallback）', async () => {
    mockHasActivePlugins.mockResolvedValue(false)
    const r = await handlePluginChatRequest(options('开始'))
    expect(r.fallback).toBeUndefined()
    expect(r.text).toContain('插件市场')
  })
})
