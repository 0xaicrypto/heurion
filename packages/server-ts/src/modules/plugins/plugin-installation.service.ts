import prisma from '../../common/prisma.js'
import { getCatalogById, type PluginManifest } from './plugin-catalog.service.js'

export interface InstalledPluginView {
  pluginId: string
  name: string
  version: string
  description: string
  author: string
  enabled: boolean
  installedAt: string
  updatedAt: string
  config: Record<string, unknown>
}

export async function installPlugin(userId: string, pluginId: string, requestedVersion?: string): Promise<InstalledPluginView> {
  const manifest = await getCatalogById(pluginId)
  if (!manifest) {
    throw new Error(`plugin not found: ${pluginId}`)
  }

  const version = requestedVersion || manifest.plugin.version
  const existing = await prisma.pluginInstallation.findUnique({
    where: { userId_pluginId: { userId, pluginId } },
  })

  const row = await prisma.pluginInstallation.upsert({
    where: { userId_pluginId: { userId, pluginId } },
    update: {
      version,
      enabled: 1,
      updatedAt: new Date().toISOString(),
    },
    create: {
      userId,
      pluginId,
      version,
      enabled: 1,
      config: JSON.stringify(buildDefaultConfig(manifest)),
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  })

  return toView(row, manifest)
}

export async function uninstallPlugin(userId: string, pluginId: string): Promise<void> {
  await prisma.pluginInstallation.deleteMany({
    where: { userId, pluginId },
  })
}

export async function setPluginEnabled(userId: string, pluginId: string, enabled: boolean): Promise<void> {
  await prisma.pluginInstallation.updateMany({
    where: { userId, pluginId },
    data: { enabled: enabled ? 1 : 0, updatedAt: new Date().toISOString() },
  })
}

export async function listInstalledPlugins(userId: string): Promise<InstalledPluginView[]> {
  const rows = await prisma.pluginInstallation.findMany({
    where: { userId },
    orderBy: { installedAt: 'desc' },
  })
  const views: InstalledPluginView[] = []
  for (const row of rows) {
    const manifest = await getCatalogById(row.pluginId)
    if (!manifest) continue
    views.push(toView(row, manifest))
  }
  return views
}

export async function getInstalledPlugin(userId: string, pluginId: string): Promise<InstalledPluginView | null> {
  const row = await prisma.pluginInstallation.findUnique({
    where: { userId_pluginId: { userId, pluginId } },
  })
  if (!row) return null
  const manifest = await getCatalogById(pluginId)
  if (!manifest) return null
  return toView(row, manifest)
}

export async function getPluginConfig(userId: string, pluginId: string): Promise<Record<string, unknown>> {
  const row = await prisma.pluginInstallation.findUnique({
    where: { userId_pluginId: { userId, pluginId } },
  })
  if (!row) return {}
  try {
    return JSON.parse(row.config) as Record<string, unknown>
  } catch {
    return {}
  }
}

export async function setPluginConfig(userId: string, pluginId: string, config: Record<string, unknown>): Promise<void> {
  await prisma.pluginInstallation.updateMany({
    where: { userId, pluginId },
    data: { config: JSON.stringify(config), updatedAt: new Date().toISOString() },
  })
}

function buildDefaultConfig(manifest: PluginManifest): Record<string, unknown> {
  const schema = manifest.settings?.schema as { properties?: Record<string, { default?: unknown }> } | undefined
  const config: Record<string, unknown> = {}
  if (schema?.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (prop.default !== undefined) config[key] = prop.default
    }
  }
  return config
}

function toView(row: { pluginId: string; enabled: number; version: string; config: string; installedAt: string; updatedAt: string }, manifest: PluginManifest): InstalledPluginView {
  return {
    pluginId: row.pluginId,
    name: manifest.plugin.name,
    version: row.version,
    description: manifest.plugin.description,
    author: manifest.plugin.author.name,
    enabled: row.enabled !== 0,
    installedAt: row.installedAt,
    updatedAt: row.updatedAt,
    config: JSON.parse(row.config || '{}') as Record<string, unknown>,
  }
}
