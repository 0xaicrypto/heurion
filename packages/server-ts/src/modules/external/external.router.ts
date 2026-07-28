import type { FastifyInstance } from 'fastify'
import { authGuard, adminGuard } from '../../common/auth.guard'
import {
  createExternalApplication,
  externalAuthGuard,
  parseScopeList,
  requireScope,
  verifyClientCredentials,
  issueAccessToken,
} from './external-auth.service'
import {
  getExternalCatalogPlugin,
  getExternalJobDownloadUrl,
  getExternalJobStatus,
  installExternalPlugin,
  invokeExternalPlugin,
  listExternalCatalog,
  listExternalPluginInstallations,
  setExternalPluginEnabled,
  uninstallExternalPlugin,
} from './external-marketplace.service'

export async function externalRouter(app: FastifyInstance) {
  // OAuth2 client-credentials token endpoint.
  app.post('/api/external/v1/oauth/token', async (request, reply) => {
    const body = request.body as {
      grant_type?: string
      client_id?: string
      client_secret?: string
      scope?: string
    }
    if (body.grant_type !== 'client_credentials') {
      return reply.status(400).send({ error: 'unsupported grant_type' })
    }
    if (!body.client_id || !body.client_secret) {
      return reply.status(400).send({ error: 'client_id and client_secret are required' })
    }

    const creds = await verifyClientCredentials(body.client_id, body.client_secret)
    if (!creds) {
      return reply.status(401).send({ error: 'invalid client credentials' })
    }

    const requestedScopes = parseScopeList(body.scope)
    const allowedScopes = new Set(creds.scopes)
    const scopes =
      requestedScopes.length > 0
        ? requestedScopes.filter((s) => allowedScopes.has(s))
        : creds.scopes

    if (scopes.length === 0) {
      return reply.status(400).send({ error: 'no valid scopes requested' })
    }

    const token = issueAccessToken(creds.appId, body.client_id, scopes)
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: scopes.join(' '),
    }
  })

  // Admin-only: register an external application.
  app.post(
    '/api/v1/admin/external-apps',
    { preHandler: [authGuard, adminGuard] },
    async (request) => {
      const body = request.body as {
        name: string
        scopes?: string[]
        quotas?: Record<string, number>
      }
      return createExternalApplication(body)
    },
  )

  // Marketplace routes (require external access token).
  app.register(async (marketplace) => {
    marketplace.addHook('preHandler', externalAuthGuard)

    marketplace.get(
      '/api/external/v1/marketplace/catalog',
      { preHandler: requireScope('marketplace:read') },
      async (request) => {
        const { query, category, runtime, source } = request.query as Record<string, string | undefined>
        return {
          plugins: await listExternalCatalog({ query, category, runtime, source }),
        }
      },
    )

    marketplace.get(
      '/api/external/v1/marketplace/catalog/:namespace/:name',
      { preHandler: requireScope('marketplace:read') },
      async (request, reply) => {
        const { namespace, name } = request.params as { namespace: string; name: string }
        const plugin = await getExternalCatalogPlugin(`${namespace}/${name}`)
        if (!plugin) return reply.status(404).send({ error: 'plugin not found' })
        return plugin
      },
    )

    marketplace.post(
      '/api/external/v1/marketplace/installations',
      { preHandler: requireScope('plugins:install') },
      async (request, reply) => {
        const body = request.body as {
          plugin_id?: string
          external_user_id?: string
          config?: Record<string, unknown>
        }
        if (!body.plugin_id || !body.external_user_id) {
          return reply.status(400).send({ error: 'plugin_id and external_user_id are required' })
        }
        try {
          const installed = await installExternalPlugin(
            request.externalApp!.appId,
            body.external_user_id,
            body.plugin_id,
            body.config,
          )
          return installed
        } catch (err: any) {
          return reply.status(400).send({ error: err.message || 'install failed' })
        }
      },
    )

    marketplace.get(
      '/api/external/v1/marketplace/installations',
      { preHandler: requireScope('plugins:install', 'plugins:invoke') },
      async (request) => {
        const { external_user_id } = request.query as { external_user_id?: string }
        const installations = await listExternalPluginInstallations(
          request.externalApp!.appId,
          external_user_id,
        )
        return { installations }
      },
    )

    marketplace.post(
      '/api/external/v1/marketplace/installations/:namespace/:name/enable',
      { preHandler: requireScope('plugins:install') },
      async (request, reply) => {
        const { namespace, name } = request.params as { namespace: string; name: string }
        const { external_user_id } = request.query as { external_user_id?: string }
        if (!external_user_id) {
          return reply.status(400).send({ error: 'external_user_id is required' })
        }
        await setExternalPluginEnabled(request.externalApp!.appId, external_user_id, `${namespace}/${name}`, true)
        return { enabled: true }
      },
    )

    marketplace.post(
      '/api/external/v1/marketplace/installations/:namespace/:name/disable',
      { preHandler: requireScope('plugins:install') },
      async (request, reply) => {
        const { namespace, name } = request.params as { namespace: string; name: string }
        const { external_user_id } = request.query as { external_user_id?: string }
        if (!external_user_id) {
          return reply.status(400).send({ error: 'external_user_id is required' })
        }
        await setExternalPluginEnabled(request.externalApp!.appId, external_user_id, `${namespace}/${name}`, false)
        return { enabled: false }
      },
    )

    marketplace.delete(
      '/api/external/v1/marketplace/installations/:namespace/:name',
      { preHandler: requireScope('plugins:install') },
      async (request, reply) => {
        const { namespace, name } = request.params as { namespace: string; name: string }
        const { external_user_id } = request.query as { external_user_id?: string }
        if (!external_user_id) {
          return reply.status(400).send({ error: 'external_user_id is required' })
        }
        await uninstallExternalPlugin(request.externalApp!.appId, external_user_id, `${namespace}/${name}`)
        return { uninstalled: true }
      },
    )

    marketplace.post(
      '/api/external/v1/marketplace/invoke',
      { preHandler: requireScope('plugins:invoke') },
      async (request, reply) => {
        const body = request.body as {
          plugin_id?: string
          tool?: string
          external_user_id?: string
          arguments?: Record<string, unknown>
          callback_url?: string
        }
        if (!body.plugin_id || !body.tool || !body.external_user_id) {
          return reply.status(400).send({ error: 'plugin_id, tool, and external_user_id are required' })
        }
        try {
          return await invokeExternalPlugin({
            externalAppId: request.externalApp!.appId,
            externalUserId: body.external_user_id,
            pluginId: body.plugin_id,
            tool: body.tool,
            arguments: body.arguments ?? {},
            callbackUrl: body.callback_url,
          })
        } catch (err: any) {
          return reply.status(400).send({ error: err.message || 'invoke failed' })
        }
      },
    )

    marketplace.get(
      '/api/external/v1/marketplace/jobs/:id',
      { preHandler: requireScope('jobs:read', 'plugins:invoke') },
      async (request, reply) => {
        const { id } = request.params as { id: string }
        const status = await getExternalJobStatus(request.externalApp!.appId, id)
        if (!status) return reply.status(404).send({ error: 'job not found' })
        return status
      },
    )

    marketplace.get(
      '/api/external/v1/marketplace/jobs/:id/download',
      { preHandler: requireScope('jobs:read', 'plugins:invoke') },
      async (request, reply) => {
        const { id } = request.params as { id: string }
        const urlInfo = await getExternalJobDownloadUrl(request.externalApp!.appId, id)
        if (!urlInfo) return reply.status(404).send({ error: 'download not available' })
        return urlInfo
      },
    )
  })
}
