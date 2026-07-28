import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import prisma from '../../common/prisma.js'

export interface PluginManifest {
  manifest_version: string
  plugin: {
    id: string
    name: string
    version: string
    description: string
    category: string
    author: { name: string; email?: string; url?: string }
    license?: string
    icon_url?: string
    homepage?: string
    tags?: string[]
  }
  runtime: {
    type: 'container' | 'wasm' | 'process'
    image?: string
    module?: string
    port?: number
    command?: string[]
    resources?: {
      cpu?: string
      memory?: string
      max_execution_seconds?: number
    }
    env?: Record<string, string>
    health_check?: { path?: string; interval_seconds?: number }
  }
  permissions: Record<string, unknown>
  tools: PluginTool[]
  triggers?: PluginTrigger[]
  settings?: { schema?: Record<string, unknown> }
  ui?: Record<string, unknown>
}

export interface PluginTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  returns?: Record<string, unknown>
}

export interface PluginTrigger {
  intent: string
  patterns: string[]
}

const OFFICIAL_CATALOG_PATH = resolve(process.cwd(), 'data', 'official-plugins.json')

let cachedCatalog: PluginManifest[] | null = null

export function loadOfficialCatalog(): PluginManifest[] {
  if (cachedCatalog) return cachedCatalog
  const raw = readFileSync(OFFICIAL_CATALOG_PATH, 'utf-8')
  cachedCatalog = JSON.parse(raw) as PluginManifest[]
  return cachedCatalog
}

export async function seedOfficialCatalog(): Promise<void> {
  const manifests = loadOfficialCatalog()
  for (const manifest of manifests) {
    const id = manifest.plugin.id
    await prisma.pluginCatalog.upsert({
      where: { id },
      update: {
        source: 'official',
        manifest: JSON.stringify(manifest),
        updatedAt: new Date().toISOString(),
      },
      create: {
        id,
        source: 'official',
        manifest: JSON.stringify(manifest),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    })
  }
}

export async function getCatalogById(id: string): Promise<PluginManifest | null> {
  const row = await prisma.pluginCatalog.findUnique({ where: { id } })
  return row ? (JSON.parse(row.manifest) as PluginManifest) : null
}

export async function searchCatalog(options?: { query?: string; source?: string }): Promise<PluginManifest[]> {
  const rows = await prisma.pluginCatalog.findMany({
    where: options?.source ? { source: options.source } : undefined,
    orderBy: { id: 'asc' },
  })
  const manifests = rows.map((r) => JSON.parse(r.manifest) as PluginManifest)
  const q = options?.query?.trim().toLowerCase()
  if (!q) return manifests
  return manifests.filter((m) => {
    const text = `${m.plugin.id} ${m.plugin.name} ${m.plugin.description} ${(m.plugin.tags || []).join(' ')}`.toLowerCase()
    return text.includes(q)
  })
}

export function getOfficialCatalog(): PluginManifest[] {
  return loadOfficialCatalog()
}
