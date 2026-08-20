/**
 * #579 — matchIntent 收敛为「generate 时插件可用性确认」。
 *
 * 上游 decodeTurnIntent 已裁定 action；本函数只回答「generate 时是否有可用插件」，
 * 并保留规则锚点做第二道防线（编辑/讨论语义永不掉进生成插件）。
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { matchIntent, type IntentMatch } from '../../src/modules/plugins/plugin-capability.service.js'
import type { TurnIntent } from '../../src/modules/chat/turn-intent.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

const mockListInstalled = vi.fn()
const mockCatalog = vi.fn()
vi.mock('../../src/modules/plugins/plugin-installation.service.js', () => ({
  listInstalledPlugins: (...args) => mockListInstalled(...args),
}))
vi.mock('../../src/modules/plugins/plugin-catalog.service.js', () => ({
  getCatalogById: (...args) => mockCatalog(...args),
  SCHEMA_VERSION: 1,
}))

const intent = (over: Partial<TurnIntent>): TurnIntent => ({
  action: 'generate', target: 'none', source: 'llm', confidence: 0.8,
  needsClarify: false, clarifyOptions: [], payload: { rawText: '帮我生成一份出院小结' },
  ...over,
})

const docxManifest = {
  plugin: { id: 'heurion/docx', name: 'Docx' },
  triggers: [{ intent: 'generate_docx', patterns: ['docx', '出院小结'] }],
  tools: [{ name: 'generate_docx', parameters: { type: 'object' } }],
}

beforeEach(() => {
  mockListInstalled.mockReset()
  mockCatalog.mockReset()
})

describe('#579 matchIntent — 非 generate 动作不咨询插件', () => {
  test('edit → edit-or-discuss（生成插件本就不该上场）', async () => {
    const r = await matchIntent('u1', intent({ action: 'edit' }))
    expect(r).toBe('edit-or-discuss')
    expect(mockListInstalled).not.toHaveBeenCalled()
  })

  test('answer → null（普通对话，非插件请求）', async () => {
    const r = await matchIntent('u1', intent({ action: 'answer' }))
    expect(r).toBeNull()
    expect(mockListInstalled).not.toHaveBeenCalled()
  })

  test('retrieve/command → null', async () => {
    expect(await matchIntent('u1', intent({ action: 'retrieve' }))).toBeNull()
    expect(await matchIntent('u1', intent({ action: 'command' }))).toBeNull()
    expect(mockListInstalled).not.toHaveBeenCalled()
  })
})

describe('#579 matchIntent — generate 时确认插件可用性', () => {
  test('插件已安装且触发词命中 → PluginMatch', async () => {
    mockListInstalled.mockResolvedValue([{ pluginId: 'heurion/docx', enabled: true }])
    mockCatalog.mockResolvedValue(docxManifest)
    const r = await matchIntent('u1', intent({ payload: { rawText: '帮我生成一份出院小结 docx' } }))
    expect(r).toMatchObject({ pluginId: 'heurion/docx', toolName: 'generate_docx', intent: 'generate_docx' })
    expect(mockListInstalled).toHaveBeenCalledWith('u1')
  })

  test('插件未安装 → null（提示去市场安装），并附带确认插件已查询', async () => {
    mockListInstalled.mockResolvedValue([])
    const r = await matchIntent('u1', intent({ payload: { rawText: '帮我生成一份出院小结 docx' } }))
    expect(r).toBeNull()
  })

  test('第二道防线：LLM 判 generate 但规则锚点证明是编辑 → edit-or-discuss（即使触发词命中也不进插件扫描）', async () => {
    mockListInstalled.mockResolvedValue([{ pluginId: 'heurion/docx', enabled: true }])
    mockCatalog.mockResolvedValue(docxManifest)
    const r = await matchIntent('u1', intent({ payload: { rawText: '帮我润色一份出院小结' } }))
    expect(r).toBe('edit-or-discuss')
  })

  test('第二道防线：讨论句即使匹配插件触发词也不进插件', async () => {
    mockListInstalled.mockResolvedValue([{ pluginId: 'heurion/docx', enabled: true }])
    mockCatalog.mockResolvedValue(docxManifest)
    const r = await matchIntent('u1', intent({ payload: { rawText: '上次那份出院小结讲了什么' } }))
    expect(r).toBe('edit-or-discuss')
  })
})