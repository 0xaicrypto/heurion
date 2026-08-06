import { describe, test, expect } from 'vitest'
import prisma from '../../src/common/prisma.js'
import { getApp } from '../setup.js'

async function adminHeaders(app: any) {
  const username = `extadmin_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const registerRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: { username, password: 'test123456', display_name: username },
  })
  expect(registerRes.statusCode).toBe(200)
  const { user_id } = JSON.parse(registerRes.payload)
  await prisma.user.update({ where: { id: user_id }, data: { role: 'admin' } })

  const loginRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: { username, password: 'test123456' },
  })
  expect(loginRes.statusCode).toBe(200)
  const token = JSON.parse(loginRes.payload).jwt_token
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

async function createExternalApp(app: any) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/external-apps',
    headers: await adminHeaders(app),
    payload: {
      name: 'Test Hospital System',
      scopes: ['marketplace:read', 'plugins:install', 'plugins:invoke', 'jobs:read'],
      quotas: { maxInvocationsPerDay: 2 },
    },
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.payload)
}

async function getAccessToken(app: any, clientId: string, clientSecret: string, scope?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/external/v1/oauth/token',
    headers: { 'content-type': 'application/json' },
    payload: {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope,
    },
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.payload).access_token as string
}

function externalHeaders(token: string) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

describe('External Marketplace API', () => {
  test('full external app lifecycle', async () => {
    const app = await getApp()
    const created = await createExternalApp(app)
    expect(created.clientId).toMatch(/^heurion_ext_/)
    expect(created.clientSecret).toBeDefined()

    const token = await getAccessToken(app, created.clientId, created.clientSecret)

    // Catalog
    const catalogRes = await app.inject({
      method: 'GET',
      url: '/api/external/v1/marketplace/catalog',
      headers: externalHeaders(token),
    })
    expect(catalogRes.statusCode).toBe(200)
    const catalog = JSON.parse(catalogRes.payload)
    expect(catalog.plugins.some((p: any) => p.id === 'heurion/docx')).toBe(true)

    // Catalog detail
    const detailRes = await app.inject({
      method: 'GET',
      url: '/api/external/v1/marketplace/catalog/heurion/docx',
      headers: externalHeaders(token),
    })
    expect(detailRes.statusCode).toBe(200)

    // Install
    const installRes = await app.inject({
      method: 'POST',
      url: '/api/external/v1/marketplace/installations',
      headers: externalHeaders(token),
      payload: {
        plugin_id: 'heurion/docx',
        external_user_id: 'hos_user_42',
      },
    })
    expect(installRes.statusCode).toBe(200)
    const install = JSON.parse(installRes.payload)
    expect(install.pluginId).toBe('heurion/docx')
    expect(install.enabled).toBe(true)

    // List installations
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/external/v1/marketplace/installations?external_user_id=hos_user_42',
      headers: externalHeaders(token),
    })
    expect(listRes.statusCode).toBe(200)
    const list = JSON.parse(listRes.payload)
    expect(list.installations.some((i: any) => i.pluginId === 'heurion/docx')).toBe(true)

    // Invoke
    const invokeRes = await app.inject({
      method: 'POST',
      url: '/api/external/v1/marketplace/invoke',
      headers: externalHeaders(token),
      payload: {
        plugin_id: 'heurion/docx',
        tool: 'generate_docx',
        external_user_id: 'hos_user_42',
        arguments: { template_id: 'case_summary', data: { patient_initials: 'ZQ' } },
      },
    })
    expect(invokeRes.statusCode).toBe(200)
    const invoke = JSON.parse(invokeRes.payload)
    expect(invoke.job_id).toBeDefined()
    expect(invoke.poll_url).toMatch(/\/api\/external\/v1\/marketplace\/jobs\//)

    // Job status
    const jobRes = await app.inject({
      method: 'GET',
      url: `/api/external/v1/marketplace/jobs/${invoke.job_id}`,
      headers: externalHeaders(token),
    })
    expect(jobRes.statusCode).toBe(200)
    const job = JSON.parse(jobRes.payload)
    expect(job.job_id).toBe(invoke.job_id)

    // Disable / uninstall
    const disableRes = await app.inject({
      method: 'POST',
      url: '/api/external/v1/marketplace/installations/heurion/docx/disable?external_user_id=hos_user_42',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(disableRes.statusCode).toBe(200)

    const uninstallRes = await app.inject({
      method: 'DELETE',
      url: '/api/external/v1/marketplace/installations/heurion/docx?external_user_id=hos_user_42',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(uninstallRes.statusCode).toBe(200)
  })

  test('invalid client credentials are rejected', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/external/v1/oauth/token',
      headers: { 'content-type': 'application/json' },
      payload: {
        grant_type: 'client_credentials',
        client_id: 'heurion_ext_invalid',
        client_secret: 'bad',
      },
    })
    expect(res.statusCode).toBe(401)
  })

  test('scope restrictions are enforced', async () => {
    const app = await getApp()
    const created = await createExternalApp(app)
    // Request only marketplace:read
    const token = await getAccessToken(app, created.clientId, created.clientSecret, 'marketplace:read')

    const res = await app.inject({
      method: 'POST',
      url: '/api/external/v1/marketplace/installations',
      headers: externalHeaders(token),
      payload: {
        plugin_id: 'heurion/docx',
        external_user_id: 'hos_user_43',
      },
    })
    expect(res.statusCode).toBe(403)
  })

  test('daily invocation quota is enforced', async () => {
    const app = await getApp()
    const created = await createExternalApp(app)
    const token = await getAccessToken(app, created.clientId, created.clientSecret, 'plugins:install plugins:invoke jobs:read')

    await app.inject({
      method: 'POST',
      url: '/api/external/v1/marketplace/installations',
      headers: externalHeaders(token),
      payload: {
        plugin_id: 'heurion/docx',
        external_user_id: 'hos_user_44',
      },
    })

    // Quota is 2 per day; first invoke succeeds.
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/external/v1/marketplace/invoke',
      headers: externalHeaders(token),
      payload: {
        plugin_id: 'heurion/docx',
        tool: 'generate_docx',
        external_user_id: 'hos_user_44',
        arguments: { template_id: 'case_summary', data: {} },
      },
    })
    expect(r1.statusCode).toBe(200)

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/external/v1/marketplace/invoke',
      headers: externalHeaders(token),
      payload: {
        plugin_id: 'heurion/docx',
        tool: 'generate_docx',
        external_user_id: 'hos_user_44',
        arguments: { template_id: 'case_summary', data: {} },
      },
    })
    expect(r2.statusCode).toBe(200)

    // Third invoke exceeds quota of 2.
    const r3 = await app.inject({
      method: 'POST',
      url: '/api/external/v1/marketplace/invoke',
      headers: externalHeaders(token),
      payload: {
        plugin_id: 'heurion/docx',
        tool: 'generate_docx',
        external_user_id: 'hos_user_44',
        arguments: { template_id: 'case_summary', data: {} },
      },
    })
    expect(r3.statusCode).toBe(400)
    expect(JSON.parse(r3.payload).error).toContain('quota')
  })
})
