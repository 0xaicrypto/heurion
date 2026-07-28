import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import prisma from '../../common/prisma.js'
import { validateManifest, type ValidationResult } from './plugin-validation.service.js'

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
  ui?: PluginUIManifest
}

export interface PluginUIManifest {
  bundle_url: string
  integrity?: string
  extension_points: Array<{
    type: string
    target?: string
    id: string
    label?: string
  }>
  permissions?: string[]
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

export async function searchCatalog(options?: { query?: string; source?: string }): Promise<Array<PluginManifest & { source: string }>> {
  const rows = await prisma.pluginCatalog.findMany({
    where: options?.source ? { source: options.source } : undefined,
    orderBy: { id: 'asc' },
  })
  const manifests = rows.map((r) => ({ ...(JSON.parse(r.manifest) as PluginManifest), source: r.source }))
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

export async function validateAndPublishCommunityManifest(
  manifest: unknown,
  sourceUrl?: string,
): Promise<{ manifest: PluginManifest; validation: ValidationResult }> {
  const validation = validateManifest(manifest)
  if (!validation.valid) {
    return { manifest: manifest as PluginManifest, validation }
  }

  const parsed = manifest as PluginManifest
  const id = parsed.plugin.id

  await prisma.pluginCatalog.upsert({
    where: { id },
    update: {
      source: 'community',
      sourceUrl: sourceUrl ?? null,
      manifest: JSON.stringify(parsed),
      updatedAt: new Date().toISOString(),
    },
    create: {
      id,
      source: 'community',
      sourceUrl: sourceUrl ?? null,
      manifest: JSON.stringify(parsed),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  })

  return { manifest: parsed, validation }
}

export async function installPluginFromUrl(url: string): Promise<{ manifest: PluginManifest; validation: ValidationResult }> {
  let text: string
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    text = await res.text()
  } catch (err: any) {
    return {
      manifest: {} as PluginManifest,
      validation: { valid: false, errors: [`Failed to fetch manifest: ${err.message || err}`] },
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      manifest: {} as PluginManifest,
      validation: { valid: false, errors: ['Manifest is not valid JSON'] },
    }
  }

  return validateAndPublishCommunityManifest(parsed, url)
}
