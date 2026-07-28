import type { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import {
  searchCatalog,
  getCatalogById,
  seedOfficialCatalog,
  installPluginFromUrl,
  validateAndPublishCommunityManifest,
} from './plugin-catalog.service.js'
import { validateManifest } from './plugin-validation.service.js'
import {
  installPlugin,
  uninstallPlugin,
  setPluginEnabled,
  listInstalledPlugins,
  getInstalledPlugin,
  getPluginConfig,
  setPluginConfig,
  listInstalledUIPlugins,
} from './plugin-installation.service.js'
import { listPluginAuditLogs } from './plugin-audit-log.service.js'

export async function pluginsRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // Seed official catalog on first request (or move to app startup)
  app.addHook('onReady', async () => {
    await seedOfficialCatalog().catch(() => {
      // ignore seed errors in tests
    })
  })

  app.get('/api/v1/plugins/catalog', async (request) => {
    const { query, source } = request.query as { query?: string; source?: string }
    const manifests = await searchCatalog({ query, source })
    const userId = request.user!.userId
    const installed = await listInstalledPlugins(userId)
    const installedSet = new Set(installed.map((i) => i.pluginId))
    return {
      plugins: manifests.map((m) => ({
        id: m.plugin.id,
        name: m.plugin.name,
        version: m.plugin.version,
        description: m.plugin.description,
        category: m.plugin.category,
        author: m.plugin.author,
        tags: m.plugin.tags || [],
        runtime: m.runtime.type,
        source: m.source,
        installed: installedSet.has(m.plugin.id),
      })),
    }
  })

  app.get('/api/v1/plugins/catalog/:namespace/:name', async (request, reply) => {
    const { namespace, name } = request.params as { namespace: string; name: string }
    const id = `${namespace}/${name}`
    const manifest = await getCatalogById(id)
    if (!manifest) {
      return reply.status(404).send({ error: 'plugin not found' })
    }
    const userId = request.user!.userId
    const installed = await getInstalledPlugin(userId, id)
    return {
      id: manifest.plugin.id,
      manifest,
      installed: !!installed,
      enabled: installed?.enabled ?? false,
    }
  })

  app.post('/api/v1/plugins/install', async (request, reply) => {
    const { pluginId, version } = request.body as { pluginId?: string; version?: string }
    if (!pluginId) {
      return reply.status(400).send({ error: 'pluginId is required' })
    }
    try {
      const installed = await installPlugin(request.user!.userId, pluginId, version)
      return installed
    } catch (err: any) {
      return reply.status(400).send({ error: err.message || 'install failed' })
    }
  })

  app.post('/api/v1/plugins/validate-manifest', async (request) => {
    const result = validateManifest(request.body)
    return {
      valid: result.valid,
      errors: result.errors,
    }
  })

  app.post('/api/v1/plugins/install-from-url', async (request, reply) => {
    const { url } = request.body as { url?: string }
    if (!url) {
      return reply.status(400).send({ error: 'url is required' })
    }
    const { manifest, validation } = await installPluginFromUrl(url)
    if (!validation.valid) {
      return reply.status(400).send({ valid: false, errors: validation.errors })
    }
    try {
      const installed = await installPlugin(request.user!.userId, manifest.plugin.id)
      return { valid: true, pluginId: manifest.plugin.id, installed }
    } catch (err: any) {
      return reply.status(400).send({ valid: true, pluginId: manifest.plugin.id, error: err.message || 'install failed' })
    }
  })

  app.post('/api/v1/plugins/install-upload', async (request, reply) => {
    const data = await request.file()
    if (!data) {
      return reply.status(400).send({ error: 'manifest file is required' })
    }
    const buffer = await data.toBuffer()
    let parsed: unknown
    try {
      parsed = JSON.parse(buffer.toString('utf-8'))
    } catch {
      return reply.status(400).send({ error: 'manifest file is not valid JSON' })
    }
    const { manifest, validation } = await validateAndPublishCommunityManifest(parsed)
    if (!validation.valid) {
      return reply.status(400).send({ valid: false, errors: validation.errors })
    }
    try {
      const installed = await installPlugin(request.user!.userId, manifest.plugin.id)
      return { valid: true, pluginId: manifest.plugin.id, installed }
    } catch (err: any) {
      return reply.status(400).send({ valid: true, pluginId: manifest.plugin.id, error: err.message || 'install failed' })
    }
  })

  app.delete('/api/v1/plugins/:namespace/:name', async (request) => {
    const { namespace, name } = request.params as { namespace: string; name: string }
    await uninstallPlugin(request.user!.userId, `${namespace}/${name}`)
    return { uninstalled: true }
  })

  app.post('/api/v1/plugins/:namespace/:name/enable', async (request) => {
    const { namespace, name } = request.params as { namespace: string; name: string }
    await setPluginEnabled(request.user!.userId, `${namespace}/${name}`, true)
    return { enabled: true }
  })

  app.post('/api/v1/plugins/:namespace/:name/disable', async (request) => {
    const { namespace, name } = request.params as { namespace: string; name: string }
    await setPluginEnabled(request.user!.userId, `${namespace}/${name}`, false)
    return { enabled: false }
  })

  app.get('/api/v1/plugins/installed', async (request) => {
    const installed = await listInstalledPlugins(request.user!.userId)
    return { plugins: installed }
  })

  app.get('/api/v1/plugins/installed-ui', async (request) => {
    const plugins = await listInstalledUIPlugins(request.user!.userId)
    return { plugins }
  })

  app.get('/api/v1/plugins/:namespace/:name/settings', async (request, reply) => {
    const { namespace, name } = request.params as { namespace: string; name: string }
    const id = `${namespace}/${name}`
    const manifest = await getCatalogById(id)
    if (!manifest) return reply.status(404).send({ error: 'plugin not found' })
    const config = await getPluginConfig(request.user!.userId, id)
    return {
      schema: manifest.settings?.schema || {},
      values: config,
    }
  })

  app.put('/api/v1/plugins/:namespace/:name/settings', async (request, reply) => {
    const { namespace, name } = request.params as { namespace: string; name: string }
    const id = `${namespace}/${name}`
    const values = request.body as Record<string, unknown>
    await setPluginConfig(request.user!.userId, id, values)
    return { saved: true }
  })

  app.get('/api/v1/plugins/audit-logs', async (request) => {
    const { pluginId, status, limit, offset } = request.query as {
      pluginId?: string
      status?: string
      limit?: string
      offset?: string
    }
    return listPluginAuditLogs(request.user!.userId, {
      pluginId,
      status,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    })
  })
}
