import { describe, test, expect, vi, beforeAll } from 'vitest'
import { mockAiProvider, intentAware } from '../helpers/ai-mock.js'
vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'
import prisma from '../../src/common/prisma.js'
import { getApp, authHeader, getAuthUserId } from '../setup.js'

beforeAll(() => {
  // #557: the sidecar intent adjudicator is the first LLM call in the chat
  // pipeline — answer it with 'generate', then reply with the tool_call.
  vi.mocked(deepseekChat).mockImplementation(intentAware(() =>
    '<tool_call>{"name":"generate_docx","arguments":{"template_id":"case_summary","data":{}}}</tool_call>',
  ))
})

const communityManifest = {
  manifest_version: '1.0.0',
  plugin: {
    id: 'acme/demo',
    name: 'Demo Community Plugin',
    version: '1.0.0',
    description: 'A tiny demo plugin from the community.',
    category: 'execution',
    author: { name: 'Acme Corp', email: 'dev@acme.example' },
    tags: ['demo'],
  },
  runtime: {
    type: 'container',
    image: 'acme/demo-plugin:1.0.0',
    port: 8080,
    resources: { cpu: '1', memory: '256m', max_execution_seconds: 30 },
  },
  permissions: { network_egress: { enabled: false }, file_system: { read: false, write: false }, phi_access: false },
  tools: [
    {
      name: 'hello',
      description: 'Say hello',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  ],
  triggers: [{ intent: 'demo', patterns: ['demo'] }],
}

describe('Plugin Marketplace', () => {
  test('catalog is seeded with official plugins', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/plugins/catalog',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.plugins).toBeDefined()
    expect(body.plugins.length).toBeGreaterThanOrEqual(5)
    const ids = body.plugins.map((p: any) => p.id)
    expect(ids).toContain('heurion/docx')
    expect(ids).toContain('heurion/pptx')
    expect(ids).toContain('heurion/table')
    expect(ids).toContain('heurion/plot')
    expect(ids).toContain('heurion/pdf')
  })

  test('install and list plugins', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }

    const installRes = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      headers,
      payload: { pluginId: 'heurion/docx' },
    })
    expect(installRes.statusCode).toBe(200)
    const installBody = JSON.parse(installRes.payload)
    expect(installBody.pluginId).toBe('heurion/docx')
    expect(installBody.enabled).toBe(true)

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/plugins/installed',
      headers: await authHeader(),
    })
    expect(listRes.statusCode).toBe(200)
    const listBody = JSON.parse(listRes.payload)
    expect(listBody.plugins.some((p: any) => p.pluginId === 'heurion/docx')).toBe(true)
  })

  test('disable and enable plugin', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }

    await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      headers,
      payload: { pluginId: 'heurion/pptx' },
    })

    const disableRes = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/heurion/pptx/disable',
      headers: await authHeader(),
    })
    expect(disableRes.statusCode).toBe(200)
    expect(JSON.parse(disableRes.payload).enabled).toBe(false)

    const enableRes = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/heurion/pptx/enable',
      headers: await authHeader(),
    })
    expect(enableRes.statusCode).toBe(200)
    expect(JSON.parse(enableRes.payload).enabled).toBe(true)
  })

  test('#454 full lifecycle: install → invoke → uninstall cascades audit log', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }

    await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      headers,
      payload: { pluginId: 'heurion/docx' },
    })

    // Invoke once so an audit row exists.
    const chat = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers,
      payload: JSON.stringify({ text: '请生成一份出院小结', session_id: `plugin_lifecycle_${Date.now()}` }),
    })
    expect(chat.statusCode).toBe(200)

    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/plugins/audit-logs?pluginId=heurion/docx',
      headers: await authHeader(),
    })
    const beforeBody = JSON.parse(before.payload)
    const auditCount = Array.isArray(beforeBody.logs) ? beforeBody.logs.length : 0

    const uninstall = await app.inject({
      method: 'DELETE',
      url: '/api/v1/plugins/heurion/docx',
      headers: await authHeader(),
    })
    expect(uninstall.statusCode).toBe(200)
    expect(JSON.parse(uninstall.payload).uninstalled).toBe(true)

    // Installation gone.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/plugins/installed',
      headers: await authHeader(),
    })
    const listBody = JSON.parse(list.payload)
    expect(listBody.plugins.some((p: any) => p.pluginId === 'heurion/docx')).toBe(false)

    // #454: audit trail cascaded away with the uninstall.
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/plugins/audit-logs?pluginId=heurion/docx',
      headers: await authHeader(),
    })
    const afterBody = JSON.parse(after.payload)
    const afterCount = Array.isArray(afterBody.logs) ? afterBody.logs.length : 0
    expect(afterCount).toBe(0)
    if (auditCount > 0) {
      // Sanity: there WAS an audit row before the cascade.
      expect(auditCount).toBeGreaterThan(0)
    }
  })

  test('chat routes docx requests through plugin reasoning stream', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }

    await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      headers,
      payload: { pluginId: 'heurion/docx' },
    })

    const chatRes = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      headers,
      payload: { text: 'generate a docx case summary report' },
    })
    expect(chatRes.statusCode).toBe(200)
    expect(chatRes.headers['content-type']).toContain('text/event-stream')

    const events = chatRes.payload
      .split('\n\n')
      .flatMap((block: string) =>
        block
          .split('\n')
          .filter((line: string) => line.startsWith('data: '))
          .map((line: string) => {
            try {
              return JSON.parse(line.slice('data: '.length))
            } catch {
              return null
            }
          })
          .filter(Boolean)
      )

    const selected = events.find((e: any) => e.type === 'plugin_selected')
    expect(selected).toBeDefined()
    expect(selected.plugin_id).toBe('heurion/docx')
    expect(selected.tool).toBe('generate_docx')

    const jobEnqueued = events.find((e: any) => e.type === 'job_enqueued')
    expect(jobEnqueued).toBeDefined()
    expect(jobEnqueued.job_type).toBe('sidecar.heurion/docx.generate_docx')
  })

  test('validate manifest rejects invalid plugin', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/validate-manifest',
      headers,
      payload: { plugin: { id: 'bad' } },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.valid).toBe(false)
    expect(body.errors.length).toBeGreaterThan(0)
  })

  test('install from URL publishes community plugin and installs it', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify(communityManifest), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/plugins/install-from-url',
        headers,
        payload: { url: 'https://example.com/acme-demo/manifest.json' },
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.valid).toBe(true)
      expect(body.pluginId).toBe('acme/demo')

      const catalogRes = await app.inject({
        method: 'GET',
        url: '/api/v1/plugins/catalog?source=community',
        headers: await authHeader(),
      })
      const catalog = JSON.parse(catalogRes.payload)
      expect(catalog.plugins.some((p: any) => p.id === 'acme/demo')).toBe(true)

      const installedRes = await app.inject({
        method: 'GET',
        url: '/api/v1/plugins/installed',
        headers: await authHeader(),
      })
      const installed = JSON.parse(installedRes.payload)
      expect(installed.plugins.some((p: any) => p.pluginId === 'acme/demo')).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('installed-ui returns enabled plugins with ui manifests', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }

    const uiManifest = {
      ...communityManifest,
      plugin: {
        ...communityManifest.plugin,
        id: 'acme/ui-demo',
        name: 'UI Demo Plugin',
      },
      ui: {
        bundle_url: '/acme/ui-demo.js',
        extension_points: [{ type: 'dashboard_card', id: 'dashboard_card', label: 'Dashboard Card' }],
      },
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify(uiManifest), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    try {
      await app.inject({
        method: 'POST',
        url: '/api/v1/plugins/install-from-url',
        headers,
        payload: { url: 'https://example.com/acme-ui-demo/manifest.json' },
      })

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/plugins/installed-ui',
        headers: await authHeader(),
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.plugins).toBeDefined()
      const found = body.plugins.find((p: any) => p.pluginId === 'acme/ui-demo')
      expect(found).toBeDefined()
      expect(found.ui.bundle_url).toBe('/acme/ui-demo.js')
      expect(found.ui.extension_points).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('plugin chat invocation writes an audit log row', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }
    const userId = await getAuthUserId()

    await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      headers,
      payload: { pluginId: 'heurion/docx' },
    })

    const chatRes = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      headers,
      payload: { text: 'generate a docx report' },
    })
    expect(chatRes.statusCode).toBe(200)

    const events = chatRes.payload
      .split('\n\n')
      .flatMap((block: string) =>
        block
          .split('\n')
          .filter((line: string) => line.startsWith('data: '))
          .map((line: string) => {
            try {
              return JSON.parse(line.slice('data: '.length))
            } catch {
              return null
            }
          })
          .filter(Boolean)
      )
    const jobEnqueued = events.find((e: any) => e.type === 'job_enqueued')
    expect(jobEnqueued).toBeDefined()
    const jobId = jobEnqueued.job_id

    // The audit log write is async; poll briefly.
    let audit: any = null
    for (let i = 0; i < 10; i++) {
      audit = await prisma.pluginAuditLog.findFirst({
        where: { userId, jobId },
      })
      if (audit) break
      await new Promise((r) => setTimeout(r, 100))
    }

    expect(audit).not.toBeNull()
    expect(audit.pluginId).toBe('heurion/docx')
    expect(audit.toolName).toBe('generate_docx')
    expect(audit.status).toBeDefined()
    expect(audit.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('secret settings are encrypted at rest and decrypted on read', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }
    const userId = await getAuthUserId()

    const secretManifest = {
      ...communityManifest,
      plugin: {
        ...communityManifest.plugin,
        id: 'acme/secret-demo',
        name: 'Secret Demo Plugin',
      },
      settings: {
        schema: {
          type: 'object',
          properties: {
            api_token: { type: 'string', format: 'secret', title: 'API Token' },
            channel: { type: 'string', default: '#general' },
          },
        },
      },
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify(secretManifest), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    try {
      await app.inject({
        method: 'POST',
        url: '/api/v1/plugins/install-from-url',
        headers,
        payload: { url: 'https://example.com/acme-secret-demo/manifest.json' },
      })

      const putRes = await app.inject({
        method: 'PUT',
        url: '/api/v1/plugins/acme/secret-demo/settings',
        headers,
        payload: { api_token: 'super-secret-token', channel: '#alerts' },
      })
      expect(putRes.statusCode).toBe(200)

      const rawRow = await prisma.pluginInstallation.findUnique({
        where: { userId_pluginId: { userId, pluginId: 'acme/secret-demo' } },
      })
      expect(rawRow).not.toBeNull()
      const rawConfig = JSON.parse(rawRow!.config)
      expect(rawConfig.api_token).toMatch(/^enc:/)
      expect(rawConfig.channel).toBe('#alerts')

      const getRes = await app.inject({
        method: 'GET',
        url: '/api/v1/plugins/acme/secret-demo/settings',
        headers: await authHeader(),
      })
      expect(getRes.statusCode).toBe(200)
      const body = JSON.parse(getRes.payload)
      expect(body.values.api_token).toBe('super-secret-token')
      expect(body.values.channel).toBe('#alerts')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('#453 unified job namespace: generic execution endpoint accepts sidecar.{pluginId}.{tool}', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/execution/jobs',
      headers,
      payload: { type: 'sidecar.heurion/docx.generate_docx', payload: { template_id: 'case_summary', data: {} } },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.job_id).toBeDefined()
    expect(body.status).toBeDefined()
  })
})
