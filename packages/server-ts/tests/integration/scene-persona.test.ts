import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores'
import { buildScenePersona, buildPersona, type ChatScene } from '../../src/common/persona.js'
import { buildCachedPersona } from '../../src/modules/chat/user-context.js'
import { ToolRegistry, SCENE_OMIT_TOOLS, PLUGIN_GATED_TOOLS } from '../../src/tools/tool-registry.js'
import { resolveScene } from '../../src/modules/chat/chat-context.js'
import { classifyQuery } from '../../src/retrieval/query-router.js'

/**
 * #510 — 场景化 system prompt: persona 变体 / 工具按场景裁剪 / 场景推断。
 * general/chart/document 场景不得继承患者导向人设与患者检索工具。
 */
describe('#510 scene personas', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-persona-'))
  })

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function makeStores() {
    const facts = new FactsStore(baseDir)
    const knowledge = new KnowledgeStore(baseDir)
    return { facts, knowledge }
  }

  test('patient 场景 persona 与现状一致(无额外指引)', () => {
    const { facts, knowledge } = makeStores()
    expect(buildScenePersona('patient', facts, knowledge)).toBe(buildPersona(facts, knowledge))
  })

  test('general 场景禁止患者检索导向', () => {
    const { facts, knowledge } = makeStores()
    const p = buildScenePersona('general', facts, knowledge)
    expect(p).toContain('Do NOT search patient records')
    expect(p).toContain('standalone task')
  })

  test('chart 场景禁止捏造数据', () => {
    const { facts, knowledge } = makeStores()
    const p = buildScenePersona('chart', facts, knowledge)
    expect(p).toContain('never fabricate data')
    expect(p).toContain('Do NOT search patient records')
  })

  test('document 场景聚焦文档编辑', () => {
    const { facts, knowledge } = makeStores()
    const p = buildScenePersona('document', facts, knowledge)
    expect(p).toContain('edit a document')
    expect(p).toContain('Do NOT search patient records')
  })

  test('persona 缓存按场景隔离', () => {
    const { facts, knowledge } = makeStores()
    const general = buildCachedPersona('u', facts, knowledge, 'general')
    const patient = buildCachedPersona('u', facts, knowledge, 'patient')
    expect(general).not.toBe(patient)
    expect(general).toContain('Do NOT search patient records')
    expect(patient).not.toContain('Do NOT search patient records')
  })
})

describe('#510 scene tool surface', () => {
  test('非 patient 场景裁剪患者检索工具', () => {
    for (const scene of ['general', 'document', 'chart'] as ChatScene[]) {
      const omit = SCENE_OMIT_TOOLS[scene]
      expect(omit).toBeDefined()
      expect(omit.has('search_node')).toBe(true)
      expect(omit.has('search_encounter')).toBe(true)
      expect(omit.has('search_past_chats')).toBe(true)
      expect(omit.has('render_chart')).toBe(false)
    }
  })

  test('patient 场景不裁剪(现状)', () => {
    expect(SCENE_OMIT_TOOLS.patient).toBeUndefined()
  })

  test('getDefinitionsForUser(scene) 排除患者检索工具但保留渲染工具', async () => {
    const ctx = {
      userId: 'u',
      memory: {} as any,
      facts: {} as any,
      episodes: {} as any,
      skills: {} as any,
      knowledge: {} as any,
      eventLog: {} as any,
    }
    const registry = new ToolRegistry(ctx as any)
    // 插件门控工具默认不可用，不影响本断言（它们不在 PATIENT_RETRIEVAL_TOOLS 中）
    const defs = await registry.getDefinitionsForUser('general')
    const names = defs.map((d) => d.function.name)
    expect(names).not.toContain('search_node')
    expect(names).not.toContain('search_encounter')
    expect(names).not.toContain('search_past_chats')
    expect(names).toContain('edit_document')
    expect(names).toContain('load_data_table')
  })

  test('getDefinitionsForUser() 默认 patient 全量(兼容旧调用)', async () => {
    const ctx = {
      userId: 'u',
      memory: {} as any,
      facts: {} as any,
      episodes: {} as any,
      skills: {} as any,
      knowledge: {} as any,
      eventLog: {} as any,
    }
    const registry = new ToolRegistry(ctx as any)
    const defs = await registry.getDefinitionsForUser()
    const names = defs.map((d) => d.function.name)
    expect(names).toContain('search_node')
    expect(names).toContain('search_encounter')
    expect(names).toContain('search_past_chats')
  })
})

describe('#546 resolveScene consistency', () => {
  test('显式优先: 显式 scene 覆盖推断', () => {
    expect(resolveScene({ explicit: 'chart', patientHash: 'h', sessionId: 'doc-x' })).toBe('chart')
  })

  test('推断: patient_hash→patient、doc- 会话→document、否则 general', () => {
    expect(resolveScene({ patientHash: 'h', sessionId: 's' })).toBe('patient')
    expect(resolveScene({ sessionId: 'doc-1' })).toBe('document')
    expect(resolveScene({ sessionId: 's' })).toBe('general')
  })

  test('错配修正: patient 场景无 patient_hash → general', () => {
    expect(resolveScene({ explicit: 'patient', patientHash: null, sessionId: 's' })).toBe('general')
    expect(resolveScene({ explicit: 'patient', patientHash: '', sessionId: 's' })).toBe('general')
  })

  test('错配修正: document 场景非 doc- 会话 → general', () => {
    expect(resolveScene({ explicit: 'document', sessionId: 's' })).toBe('general')
  })

  test('合法组合保持不变', () => {
    expect(resolveScene({ explicit: 'patient', patientHash: 'h', sessionId: 's' })).toBe('patient')
    expect(resolveScene({ explicit: 'document', sessionId: 'doc-7' })).toBe('document')
  })
})

describe('#510 query-router mixed fallback (routes unused by chat pipeline, intent stable)', () => {
  test('解释图片类请求不命中患者规则(不误入 sql)', () => {
    // 规则层：无患者/人口学关键词 → 不归 sql；#510 后工具面已按场景裁剪
    const intent = classifyQuery('帮我解释一下这张图')
    expect(intent).not.toBe('sql')
  })
})
