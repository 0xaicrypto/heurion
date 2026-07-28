import type { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import { searchCatalog, getCatalogById, seedOfficialCatalog } from './plugin-catalog.service.js'
import {
  installPlugin,
  uninstallPlugin,
  setPluginEnabled,
  listInstalledPlugins,
  getInstalledPlugin,
  getPluginConfig,
  setPluginConfig,
} from './plugin-installation.service.js'

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
}
