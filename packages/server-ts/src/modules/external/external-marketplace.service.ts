import prisma from '../../common/prisma'
import { getCatalogById, searchCatalog } from '../plugins/plugin-catalog.service'
import {
  decryptSettingValue,
  encryptSettingValue,
  transformSecretValues,
} from '../plugins/plugin-settings-encryption.service'
import { createExecutionPlaneService } from '../execution/execution-plane.service'
import { buildInputSummary, recordPluginInvocation } from '../plugins/plugin-audit-log.service'

const executionService = createExecutionPlaneService()

export interface ExternalCatalogSearchOptions {
  query?: string
  category?: string
  runtime?: string
  source?: string
}

export async function listExternalCatalog(options: ExternalCatalogSearchOptions) {
  const manifests = await searchCatalog({ query: options.query, source: options.source })
  return manifests
    .filter((m) => {
      if (options.category && m.plugin.category !== options.category) return false
      if (options.runtime && m.runtime.type !== options.runtime) return false
      return true
    })
    .map((m) => ({
      id: m.plugin.id,
      name: m.plugin.name,
      version: m.plugin.version,
      description: m.plugin.description,
      category: m.plugin.category,
      author: m.plugin.author,
      tags: m.plugin.tags || [],
      runtime: m.runtime.type,
      source: m.source,
    }))
}

export async function getExternalCatalogPlugin(id: string) {
  const manifest = await getCatalogById(id)
  if (!manifest) return null
  return {
    id: manifest.plugin.id,
    manifest,
  }
}

export async function ensureHeurionUser(externalAppId: string, externalUserId: string): Promise<string> {
  const existing = await prisma.externalUserMapping.findUnique({
    where: { externalAppId_externalUserId: { externalAppId, externalUserId } },
  })
  if (existing) return existing.heurionUserId

  const id = `ext_${externalAppId.slice(0, 16)}_${externalUserId.slice(0, 32)}_${Date.now()}`
  const displayName = `ext:${externalAppId}:${externalUserId}`
  const now = new Date().toISOString()

  await prisma.user.create({
    data: {
      id,
      displayName,
      role: 'user',
      createdAt: now,
      updatedAt: now,
    },
  })

  await prisma.externalUserMapping.create({
    data: {
      externalAppId,
      externalUserId,
      heurionUserId: id,
      createdAt: now,
    },
  })

  return id
}

function buildDefaultConfig(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const properties = (schema?.properties || {}) as Record<string, { default?: unknown }>
  const config: Record<string, unknown> = {}
  for (const [key, prop] of Object.entries(properties)) {
    if (prop.default !== undefined) config[key] = prop.default
  }
  return config
}

export async function installExternalPlugin(
  externalAppId: string,
  externalUserId: string,
  pluginId: string,
  requestedConfig?: Record<string, unknown>,
) {
  const manifest = await getCatalogById(pluginId)
  if (!manifest) throw new Error('plugin not found')

  await ensureHeurionUser(externalAppId, externalUserId)

  const defaultConfig = buildDefaultConfig(manifest.settings?.schema)
  const config = requestedConfig
    ? transformSecretValues(requestedConfig, manifest.settings?.schema, encryptSettingValue)
    : defaultConfig

  const now = new Date().toISOString()
  const row = await prisma.externalPluginInstallation.upsert({
    where: {
      externalAppId_externalUserId_pluginId: { externalAppId, externalUserId, pluginId },
    },
    update: {
      version: manifest.plugin.version,
      enabled: 1,
      config: JSON.stringify(config),
      updatedAt: now,
    },
    create: {
      externalAppId,
      externalUserId,
      pluginId,
      version: manifest.plugin.version,
      enabled: 1,
      config: JSON.stringify(config),
      createdAt: now,
      updatedAt: now,
    },
  })

  return {
    id: row.id,
    pluginId: row.pluginId,
    version: row.version,
    enabled: row.enabled === 1,
    externalUserId: row.externalUserId,
  }
}

export async function uninstallExternalPlugin(
  externalAppId: string,
  externalUserId: string,
  pluginId: string,
) {
  await prisma.externalPluginInstallation.deleteMany({
    where: { externalAppId, externalUserId, pluginId },
  })
}

export async function setExternalPluginEnabled(
  externalAppId: string,
  externalUserId: string,
  pluginId: string,
  enabled: boolean,
) {
  await prisma.externalPluginInstallation.updateMany({
    where: { externalAppId, externalUserId, pluginId },
    data: { enabled: enabled ? 1 : 0, updatedAt: new Date().toISOString() },
  })
}

export async function listExternalPluginInstallations(externalAppId: string, externalUserId?: string) {
  const rows = await prisma.externalPluginInstallation.findMany({
    where: externalUserId ? { externalAppId, externalUserId } : { externalAppId },
    orderBy: { createdAt: 'desc' },
  })
  return Promise.all(
    rows.map(async (row) => {
      const manifest = await getCatalogById(row.pluginId)
      const config = manifest
        ? transformSecretValues(
            JSON.parse(row.config || '{}') as Record<string, unknown>,
            manifest.settings?.schema,
            decryptSettingValue,
          )
        : (JSON.parse(row.config || '{}') as Record<string, unknown>)
      return {
        id: row.id,
        pluginId: row.pluginId,
        name: manifest?.plugin.name || row.pluginId,
        version: row.version,
        enabled: row.enabled === 1,
        externalUserId: row.externalUserId,
        config,
      }
    }),
  )
}

export async function checkInvocationQuota(externalAppId: string): Promise<void> {
  const app = await prisma.externalApplication.findUnique({ where: { id: externalAppId } })
  if (!app) return
  let quotas: Record<string, number> = {}
  try {
    quotas = JSON.parse(app.quotas) as Record<string, number>
  } catch {
    quotas = {}
  }
  const maxDaily = quotas.maxInvocationsPerDay
  if (!maxDaily || maxDaily <= 0) return

  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const count = await prisma.externalJobMapping.count({
    where: {
      externalAppId,
      createdAt: { gte: startOfDay.toISOString() },
    },
  })
  if (count >= maxDaily) {
    throw new Error('daily invocation quota exceeded')
  }
}

export interface ExternalInvokeInput {
  externalAppId: string
  externalUserId: string
  pluginId: string
  tool: string
  arguments: Record<string, unknown>
  callbackUrl?: string
}

export async function invokeExternalPlugin(input: ExternalInvokeInput) {
  await checkInvocationQuota(input.externalAppId)

  const installation = await prisma.externalPluginInstallation.findUnique({
    where: {
      externalAppId_externalUserId_pluginId: {
        externalAppId: input.externalAppId,
        externalUserId: input.externalUserId,
        pluginId: input.pluginId,
      },
    },
  })
  if (!installation) throw new Error('plugin not installed for user')
  if (!installation.enabled) throw new Error('plugin is disabled')

  const manifest = await getCatalogById(input.pluginId)
  if (!manifest) throw new Error('plugin manifest not found')
  const tool = manifest.tools.find((t) => t.name === input.tool)
  if (!tool) throw new Error('tool not found')

  const heurionUserId = await ensureHeurionUser(input.externalAppId, input.externalUserId)
  const tenantPrefix = `external_apps/${input.externalAppId}/users/${input.externalUserId}`

  const jobType = `sidecar.${input.pluginId}.${input.tool}`
  const startedAt = Date.now()
  const job = await executionService.enqueue({
    type: jobType,
    payload: input.arguments,
    tenant: {
      userId: heurionUserId,
      workspaceId: tenantPrefix,
    },
    callbackUrl: input.callbackUrl,
  })

  await prisma.externalJobMapping.create({
    data: {
      externalAppId: input.externalAppId,
      externalUserId: input.externalUserId,
      pluginId: input.pluginId,
      jobId: job.job_id,
      toolName: input.tool,
      createdAt: new Date().toISOString(),
    },
  })

  // Best-effort audit log; do not await.
  recordPluginInvocation({
    userId: heurionUserId,
    pluginId: input.pluginId,
    toolName: input.tool,
    jobId: job.job_id,
    status: job.status,
    durationMs: Date.now() - startedAt,
    inputSummary: buildInputSummary(input.arguments),
  }).catch(() => {})

  return {
    job_id: job.job_id,
    status: job.status,
    poll_url: `/api/external/v1/marketplace/jobs/${job.job_id}`,
  }
}

export async function getExternalJobStatus(externalAppId: string, jobId: string) {
  const mapping = await prisma.externalJobMapping.findUnique({
    where: { externalAppId_jobId: { externalAppId, jobId } },
  })
  if (!mapping) return null
  return executionService.getStatus(jobId)
}

export async function getExternalJobDownloadUrl(externalAppId: string, jobId: string) {
  const mapping = await prisma.externalJobMapping.findUnique({
    where: { externalAppId_jobId: { externalAppId, jobId } },
  })
  if (!mapping) return null

  // Discover the file_id from the completed job result.
  const status = await executionService.getStatus(jobId)
  const fileId = status?.result?.file_id as string | undefined
  if (!fileId) return null
  return executionService.getDownloadUrl(fileId)
}
