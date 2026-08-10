import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader } from '../setup.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

import { deepseekChat } from '../../src/common/llm.js'
import { ToolRegistry, PLUGIN_GATED_TOOLS } from '../../src/tools/tool-registry.js'
import prisma from '../../src/common/prisma'
import { getUserContext } from '../../src/modules/chat/user-context.js'
import { EventLog } from '../../src/core/event-log.js'
import { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../../src/evolution/stores.js'

/**
 * #486: heurion/browser-agent plugin — browser_task tool gated by the
 * plugin lifecycle, calling the CF Agent Browser Worker endpoint (#485).
 * TDD: tests written before the implementation.
 */
/** Install with retry — parallel tests clear the shared catalog table. */
async function installBrowserAgent(userId: string, config?: { worker_url: string; worker_token: string }) {
  const { installPlugin, setPluginConfig } = await import('../../src/modules/plugins/plugin-installation.service.js')
  for (let i = 0; i < 5; i++) {
    try {
      // userId is a FK to User — tests use a synthetic id, so ensure the
      // user row exists too.
      const now = new Date().toISOString()
      await (prisma as any).user.upsert({
        where: { id: userId },
        update: {},
        create: { id: userId, displayName: `BA_${userId}_${Math.random().toString(36).slice(2, 6)}`, passwordHash: 'x', role: 'user', status: 'approved', createdAt: now, updatedAt: now },
      })
      await ensureCatalog()
      await installPlugin(userId, 'heurion/browser-agent')
      if (config) await setPluginConfig(userId, 'heurion/browser-agent', config)
      return
    } catch (err: any) {
      if (i === 4) throw err
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

/** Self-contained catalog row — parallel tests clear the shared table. */
async function ensureCatalog() {
  const { loadOfficialCatalog } = await import('../../src/modules/plugins/plugin-catalog.service.js')
  const manifest = loadOfficialCatalog().find((m: any) => m.plugin.id === 'heurion/browser-agent')
  expect(manifest).toBeDefined()
  const now = new Date().toISOString()
  await (prisma as any).pluginCatalog.upsert({
    where: { id: 'heurion/browser-agent' },
    update: { source: 'official', manifest: JSON.stringify(manifest), updatedAt: now },
    create: { id: 'heurion/browser-agent', source: 'official', manifest: JSON.stringify(manifest), createdAt: now, updatedAt: now },
  })
}


describe('browser-agent plugin (#486)', () => {
  beforeEach(() => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  function makeRegistry() {
    const ctx = getUserContext('u1')
    return new ToolRegistry({
      userId: 'u1',
      memory: ctx.memory,
      facts: ctx.facts,
      episodes: ctx.episodes,
      skills: ctx.skills,
      knowledge: ctx.knowledge,
      eventLog: ctx.eventLog,
      sessionId: 's1',
    })
  }

  test('1. plugin not installed → browser_task is NOT in the LLM tool list', async () => {
    const registry = makeRegistry()
    const defs = await registry.getDefinitionsForUser()
    expect(defs.some((d) => d.function.name === 'browser_task')).toBe(false)
  })

  test('2. installed + enabled → browser_task appears in definitions', async () => {
    // #486: self-contained catalog row (parallel tests clear the table).
    await installBrowserAgent('u1')

    const registry = makeRegistry()
    const defs = await registry.getDefinitionsForUser()
    expect(defs.some((d) => d.function.name === 'browser_task')).toBe(true)
  })

  test('3. execute calls the Worker with instruction/url + token header', async () => {
    await installBrowserAgent('u1', { worker_url: 'https://browser-agent.example.workers.dev', worker_token: 'wrb-secret' })

    const fetchMock = vi.fn(async (url: any, init?: any) => {
      expect(String(url)).toBe('https://browser-agent.example.workers.dev/browser-task')
      expect((init as any).headers['x-worker-token']).toBe('wrb-secret')
      const body = JSON.parse((init as any).body)
      expect(body.instruction).toBe('登录 heurion.org 并生成 EGFR 通路图')
      expect(body.url).toBe('https://heurion.org')
      return {
        ok: true,
        json: async () => ({
          success: true,
          conclusion: '已登录并确认图表生成成功',
          dom_summary: '图表区域可见',
          screenshot_url: 'data:image/png;base64,xxx',
          steps: ['打开页面', '登录', '生成图表'],
        }),
      } as any
    })
    vi.stubGlobal('fetch', fetchMock)

    const registry = makeRegistry()
    const res = await registry.execute('browser_task', {
      instruction: '登录 heurion.org 并生成 EGFR 通路图',
      url: 'https://heurion.org',
    })
    expect(res.success).toBe(true)
    const out = JSON.parse(res.output!)
    expect(out.conclusion).toContain('图表生成成功')
    expect(out.steps.length).toBe(3)
  })

  test('4. Worker failure → friendly error, no crash', async () => {
    await installBrowserAgent('u1', { worker_url: 'https://browser-agent.example.workers.dev', worker_token: 'wrb-secret' })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, text: async () => 'worker boom' })))

    const registry = makeRegistry()
    const res = await registry.execute('browser_task', { instruction: 'x' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('browser')
  })

  test('5. uninstall → browser_task refused again', async () => {
    await installBrowserAgent('u1')
    const { uninstallPlugin } = await import('../../src/modules/plugins/plugin-installation.service.js')
    await uninstallPlugin('u1', 'heurion/browser-agent')

    const registry = makeRegistry()
    const defs = await registry.getDefinitionsForUser()
    expect(defs.some((d) => d.function.name === 'browser_task')).toBe(false)
    const res = await registry.execute('browser_task', { instruction: 'x' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('插件')
  })

  test('6. manifest validates (in-process runtime)', async () => {
    const { loadOfficialCatalog } = await import('../../src/modules/plugins/plugin-catalog.service.js')
    const { validateManifest } = await import('../../src/modules/plugins/plugin-validation.service.js')
    const manifest = loadOfficialCatalog().find((m: any) => m.plugin.id === 'heurion/browser-agent')
    expect(manifest).toBeDefined()
    const v = validateManifest(manifest)
    expect(v.valid).toBe(true)
  })

  test('7. chat LLM loop: plugin-gated browser_task is usable after install (definitions reach the model)', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }
    // Register a fresh user for this test (shared token would already have the plugin).
    const username = `ba_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const reg = await app.inject({
      method: 'POST', url: '/api/v1/auth/register', headers,
      payload: JSON.stringify({ username, password: 'test123456', display_name: 'BA Test' }),
    })
    const regBody = JSON.parse(reg.payload)
    const userHeaders = { authorization: `Bearer ${regBody.jwt_token}`, 'content-type': 'application/json' }
    const userId = regBody.user_id

    // Self-contained catalog row for this user's install.
    await installBrowserAgent(userId)

    let sawBrowserTask = false
    vi.mocked(deepseekChat).mockImplementation((messages: any) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      return Promise.resolve('普通回答。')
    })

    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat', headers: userHeaders,
      payload: JSON.stringify({ text: '帮我查一下这个网页', session_id: `ba_${Date.now()}` }),
    })
    expect(res.statusCode).toBe(200)
    // The tool definition reached the LLM (4th arg of deepseekChat).
    const toolLoopCall = vi.mocked(deepseekChat).mock.calls.find((c) => !JSON.stringify(c[0]).includes('intent classifier'))
    const toolsArg = (toolLoopCall?.[3] as Array<{ function: { name: string } }> | undefined) || []
    expect(toolsArg.some((t) => t.function?.name === 'browser_task')).toBe(true)
  }, 30000)
})

describe('browser-agent approval mode (#486-followup)', () => {
  beforeEach(() => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  function makeRegistry() {
    const ctx = getUserContext('u1')
    return new ToolRegistry({
      userId: 'u1', memory: ctx.memory, facts: ctx.facts, episodes: ctx.episodes,
      skills: ctx.skills, knowledge: ctx.knowledge, eventLog: ctx.eventLog, sessionId: 's1',
    })
  }

  test('default (no approval config) = allow: execute calls the worker', async () => {
    await installBrowserAgent('u1', { worker_url: 'https://browser-agent.example.workers.dev', worker_token: 'wrb' })
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, conclusion: 'ok', steps: [] }) }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await makeRegistry().execute('browser_task', { instruction: 'open page' })
    expect(res.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('approval_mode=ask → tool asks the user first, worker NOT called', async () => {
    await installBrowserAgent('u1', {
      worker_url: 'https://browser-agent.example.workers.dev',
      worker_token: 'wrb',
    })
    const { setPluginConfig } = await import('../../src/modules/plugins/plugin-installation.service.js')
    await setPluginConfig('u1', 'heurion/browser-agent', {
      worker_url: 'https://browser-agent.example.workers.dev',
      worker_token: 'wrb',
      approval_mode: 'ask',
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await makeRegistry().execute('browser_task', { instruction: 'open page' })
    // Ask path: friendly message asking the user to approve; no fetch.
    expect(res.success).toBe(true)
    expect(JSON.parse(res.output!).approval_required).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('approval_mode=deny → refused without calling the worker', async () => {
    await installBrowserAgent('u1', { worker_url: 'https://browser-agent.example.workers.dev', worker_token: 'wrb' })
    const { setPluginConfig } = await import('../../src/modules/plugins/plugin-installation.service.js')
    await setPluginConfig('u1', 'heurion/browser-agent', {
      worker_url: 'https://browser-agent.example.workers.dev',
      worker_token: 'wrb',
      approval_mode: 'deny',
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await makeRegistry().execute('browser_task', { instruction: 'open page' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('禁用')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
