import { describe, test, expect } from 'vitest'
import { getApp, authHeader } from './setup.js'

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
})
