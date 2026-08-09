/**
 * #466 — Reactome pathway diagrams: local cache + dynamic load from object
 * storage (S3-compatible, e.g. DigitalOcean Spaces).
 *
 * The catalog (pathway name/alias → R-HSA id) ships in the repo
 * (data/reactome-pathways.json). The SVG bodies live in object storage
 * (REACTOME_DIAGRAMS_BASE_URL, public read) and are cached on disk under
 * TWIN_BASE_DIR/reactome-diagrams/ — first use downloads, later uses are
 * instant. No large files in git.
 *
 * Content: Reactome pathway diagrams, CC BY 4.0 (https://reactome.org/license).
 */
import fs from 'fs'
import path from 'path'
import { readFileSync } from 'fs'

interface PathwayEntry {
  id: string
  name: string
  aliases: string[]
}

interface PathwayCatalog {
  source: string
  license: string
  license_url: string
  attribution: string
  download: string
  downloaded_at?: string
  pathways: PathwayEntry[]
}

let catalogCache: PathwayCatalog | null = null

function loadCatalog(): PathwayCatalog {
  if (catalogCache) return catalogCache
  const raw = readFileSync(new URL('../../../data/reactome-pathways.json', import.meta.url), 'utf-8')
  catalogCache = JSON.parse(raw) as PathwayCatalog
  return catalogCache
}

export function reactomeCatalog(): PathwayCatalog {
  return loadCatalog()
}

/** Normalize for fuzzy matching: lowercase, strip non-alphanumerics. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim()
}

/** Resolve a user-supplied pathway name/alias/ID to a catalog entry. */
export function resolvePathway(query: string): PathwayEntry | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const catalog = loadCatalog()

  // Exact: id / name / alias.
  for (const p of catalog.pathways) {
    if (p.id.toLowerCase() === q) return p
    if (p.name.toLowerCase() === q) return p
    if (p.aliases.some((a) => a.toLowerCase() === q)) return p
  }

  // Word-match: every token of the query appears in the name
  // ("EGFR signaling" hits "Signaling by EGFR"; 中文整词子串同规则).
  const qTokens = norm(q).split(' ').filter(Boolean)
  if (qTokens.length > 0) {
    for (const p of catalog.pathways) {
      const name = norm(p.name)
      if (qTokens.every((tk) => name.includes(tk))) return p
    }
  }

  // Substring on id + aliases.
  for (const p of catalog.pathways) {
    if (q.includes(p.id.toLowerCase())) return p
    if (p.aliases.some((a) => norm(a).includes(norm(q)))) return p
  }

  // Fuzzy: substring match on name ("EGFR" hits "Signaling by EGFR").
  for (const p of catalog.pathways) {
    if (p.name.toLowerCase().includes(q)) return p
  }
  return null
}

/** Candidate list for the "did you mean" path when nothing matches. */
export function searchPathways(query: string, limit = 8): PathwayEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const catalog = loadCatalog()
  return catalog.pathways
    .filter((p) => p.name.toLowerCase().includes(q) || p.aliases.some((a) => a.toLowerCase().includes(q)))
    .slice(0, limit)
}

function cacheDir(): string {
  return path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', 'reactome-diagrams')
}

function cachedPath(stId: string): string {
  return path.join(cacheDir(), `${stId}.svg`)
}

function baseUrl(): string | undefined {
  return process.env.REACTOME_DIAGRAMS_BASE_URL?.replace(/\/$/, '')
}

/**
 * Fetch a pathway diagram SVG. Order: local cache → object storage.
 * Returns null when neither the cache nor the base URL is available.
 */
export async function fetchPathwayDiagram(stId: string): Promise<string | null> {
  const local = cachedPath(stId)
  if (fs.existsSync(local)) {
    return readFileSync(local, 'utf-8')
  }

  const base = baseUrl()
  if (!base) return null

  try {
    const res = await fetch(`${base}/${stId}.svg`)
    if (!res.ok) return null
    const svg = await res.text()
    // Cache for later (best-effort).
    try {
      fs.mkdirSync(cacheDir(), { recursive: true })
      fs.writeFileSync(local, svg, 'utf-8')
    } catch { /* cache is best-effort */ }
    return svg
  } catch {
    return null
  }
}
