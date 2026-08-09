/**
 * #408/#467: BioScene — molecular/schematic scene rendering.
 * The restricted icon catalog is the quality gate: the LLM can only place
 * icons that exist, never invent shapes. The renderer validates every icon
 * id and draws a deterministic SVG scene.
 *
 * #467: icons come in two forms —
 *   - `path`: a single 24x24 SVG path (drawn with the scene stroke style)
 *   - `svgFile`: a full NIH BioArt-style SVG (public domain) embedded as-is
 *     (keeps gradients/defs; scaled to the object size). Loaded lazily from
 *     data/icons/.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

/** Minimal icon catalog (MVP subset — membrane/receptor/kinase/etc.). */
export interface BioIcon {
  id: string
  name: string
  category: 'membrane' | 'receptor' | 'enzyme' | 'ion-channel' | 'organelle' | 'cell' | 'molecule' | 'virus' | 'other'
  aliases: string[]
  /** Simple SVG path (24x24 viewBox), dark strokes — OR */
  path?: string
  /** Full external SVG file (public-domain NIH BioArt) embedded as-is. */
  svgFile?: string
}

const ICONS: BioIcon[] = [
  { id: 'membrane', name: 'Cell membrane', category: 'membrane', aliases: ['细胞膜', '膜', 'lipid bilayer', 'plasma membrane'], path: 'M2 12 Q12 4 22 12 Q12 20 2 12 Z' },
  { id: 'receptor', name: 'Transmembrane receptor', category: 'receptor', aliases: ['受体', 'receptor', 'RTK'], path: 'M8 6 L8 18 M16 6 L16 18 M6 8 Q12 4 18 8 M6 16 Q12 20 18 16' },
  { id: 'egfr', name: 'EGFR receptor', category: 'receptor', aliases: ['EGFR', '表皮生长因子受体'], path: 'M10 6 L10 18 M14 6 L14 18 M8 8 Q12 3 16 8 M8 16 Q12 21 16 16' },
  { id: 'pd-l1', name: 'PD-L1', category: 'receptor', aliases: ['PD-L1', '程序性死亡配体'], path: 'M7 10 Q12 6 17 10 M7 14 Q12 18 17 14' },
  { id: 'kinase', name: 'Kinase', category: 'enzyme', aliases: ['激酶', 'kinase'], path: 'M12 7 L12 17 M7 12 L17 12 M12 12 L17 17 M7 7 L12 12' },
  { id: 'p-kinase', name: 'Phosphorylated kinase', category: 'enzyme', aliases: ['磷酸化激酶', 'p-Kinase', 'phospho'], path: 'M12 7 L12 17 M7 12 L17 12 M12 12 L17 17 M7 7 L12 12 M14 4 L20 6' },
  { id: 'ion-channel', name: 'Ion channel', category: 'ion-channel', aliases: ['离子通道', 'channel'], path: 'M9 6 L9 18 M15 6 L15 18 M6 9 Q12 5 18 9 M6 15 Q12 19 18 15 M12 6 L12 9 M12 15 L12 18' },
  { id: 'k-channel', name: 'Potassium channel', category: 'ion-channel', aliases: ['钾通道', 'K channel'], path: 'M9 6 L9 18 M15 6 L15 18 M12 6 L12 9 M12 15 L12 18 M5 10 Q12 4 19 10 M5 14 Q12 20 19 14' },
  { id: 'nucleus', name: 'Nucleus', category: 'organelle', aliases: ['细胞核', 'nucleus'], path: 'M12 8 a4 4 0 1 0 0.001 0 Z M12 8 L12 6 M10 10 L9 12 M14 10 L15 12' },
  { id: 'mitochondria', name: 'Mitochondrion', category: 'organelle', aliases: ['线粒体', 'mitochondria'], path: 'M6 12 Q12 6 18 12 Q12 18 6 12 Z M9 12 Q12 9 15 12' },
  { id: 'golgi', name: 'Golgi apparatus', category: 'organelle', aliases: ['高尔基体', 'golgi'], path: 'M7 9 Q12 12 17 9 M7 11 Q12 14 17 11 M7 13 Q12 16 17 13 M7 15 Q12 18 17 15' },
  { id: 'er', name: 'Endoplasmic reticulum', category: 'organelle', aliases: ['内质网', 'ER'], path: 'M6 10 Q12 14 18 10 M6 13 Q12 17 18 13 M6 16 Q12 20 18 16' },
  { id: 'cell', name: 'Cell', category: 'cell', aliases: ['细胞', 'cell'], path: 'M12 4 a8 8 0 1 0 0.001 0 Z' },
  { id: 't-cell', name: 'T cell', category: 'cell', aliases: ['T细胞', 'T cell'], path: 'M12 4 a7 7 0 1 0 0.001 0 Z M12 6 L12 8 M10 7 L11 8.5 M14 7 L13 8.5' },
  { id: 'tumor-cell', name: 'Tumor cell', category: 'cell', aliases: ['肿瘤细胞', 'tumor'], path: 'M12 3 a9 9 0 1 0 0.001 0 Z M12 8 a4 4 0 1 0 0.001 0 Z' },
  { id: 'antibody', name: 'Antibody (Y)', category: 'molecule', aliases: ['抗体', 'antibody'], path: 'M8 4 L12 10 L16 4 M12 10 L12 20 M9 13 L12 10 M15 13 L12 10' },
  { id: 'ligand', name: 'Ligand', category: 'molecule', aliases: ['配体', 'ligand', 'cytokine'], path: 'M12 7 a5 5 0 1 0 0.001 0 Z M12 4 L12 2' },
  { id: 'tki', name: 'Small molecule inhibitor (TKI)', category: 'molecule', aliases: ['TKI', '抑制剂', 'small molecule'], path: 'M8 8 L16 16 M16 8 L8 16 M12 7 a5 5 0 1 0 0.001 0 Z' },
  { id: 'drug', name: 'Drug pill', category: 'molecule', aliases: ['药物', 'drug', '药丸'], path: 'M8 8 a4 4 0 1 0 8 0 a4 4 0 1 0 -8 0 M8 8 Q8 16 8 18 M16 8 Q16 16 16 18' },
  { id: 'apoptosis', name: 'Apoptosis (cell death)', category: 'other', aliases: ['凋亡', 'apoptosis', '死亡'], path: 'M7 7 L17 17 M17 7 L7 17' },
  { id: 'proliferation', name: 'Proliferation', category: 'other', aliases: ['增殖', 'proliferation', 'growth'], path: 'M8 14 L12 6 L16 14 M8 10 Q12 4 16 10 M12 6 L12 18' },
]

const CATEGORIES = new Set(ICONS.map((i) => i.category))

/* ── #467: external SVG icons (public-domain NIH BioArt) ───────────── */

const ICONS_DIR = fileURLToPath(new URL('../../../data/icons/', import.meta.url))

/** icon id → { file, category, aliases } loaded from data/icons/icons.json. */
let externalIcons: Array<BioIcon & { file: string }> = []

function loadExternalIcons(): Array<BioIcon & { file: string }> {
  if (externalIcons.length > 0) return externalIcons
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ICONS_DIR, 'icons.json'), 'utf-8'))
    externalIcons = raw.icons.map((i: any) => ({ ...i, category: i.category, svgFile: i.file }))
  } catch {
    externalIcons = []
  }
  return externalIcons
}

/** #467: include external icons in the catalog the LLM can pick from. */
function allIcons(): BioIcon[] {
  return [...ICONS, ...loadExternalIcons()]
}

/** Read + normalize an external SVG for embedding (strip outer <svg>). */
function readExternalSvg(id: string): { inner: string; vbWidth: number } | null {
  const entry = loadExternalIcons().find((i) => i.id === id)
  if (!entry) return null
  try {
    const raw = fs.readFileSync(path.join(ICONS_DIR, entry.file), 'utf-8')
    // NIH BioArt SVGs use a namespaced <ns0:svg ...> wrapper — match any
    // prefix. Keep the inner content (defs + groups), drop the wrapper
    // (the renderer positions/scales it via a <g transform>).
    const m = raw.match(/<(?:\w+:)?svg[^>]*>([\s\S]*)<\/(?:\w+:)?svg>/i)
    if (!m) return null
    // Parse the viewBox for exact scaling.
    const vb = raw.match(/viewBox="\s*[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/i)
    const vbWidth = vb ? parseFloat(vb[1]) || 500 : 500
    return { inner: m[1], vbWidth }
  } catch {
    return null
  }
}

export function iconCatalog(): Array<{ id: string; name: string; category: string }> {
  return allIcons().map(({ id, name, category }) => ({ id, name, category }))
}

export function resolveIcon(idOrAlias: string): BioIcon | null {
  const q = idOrAlias.trim().toLowerCase()
  return allIcons().find((i) => i.id.toLowerCase() === q || i.aliases.some((a) => a.toLowerCase() === q)) || null
}

/* ── #468: palette system ─────────────────────────────────────────── */

export type BioScenePalette = 'default' | 'clinical' | 'journal'

/** Category → color per palette. Keys: icon categories + connection kinds. */
const PALETTES: Record<BioScenePalette, Record<string, string>> = {
  // Legacy look: single gray stroke (backward compatible).
  default: {
    stroke: '#334155', text: '#334155', connection: '#475569',
    membrane: '#334155', receptor: '#334155', enzyme: '#334155', 'ion-channel': '#334155',
    organelle: '#334155', cell: '#334155', molecule: '#334155', virus: '#334155', other: '#334155',
  },
  // High-saturation categorical colors — clinical communication.
  clinical: {
    stroke: '#1e293b', text: '#1e293b', connection: '#64748b',
    membrane: '#475569', receptor: '#2563eb', enzyme: '#16a34a', 'ion-channel': '#7c3aed',
    organelle: '#b45309', cell: '#0891b2', molecule: '#db2777', virus: '#dc2626', other: '#64748b',
  },
  // Low-saturation academic colors — publication-style figures.
  journal: {
    stroke: '#334155', text: '#334155', connection: '#94a3b8',
    membrane: '#64748b', receptor: '#60a5fa', enzyme: '#86efac', 'ion-channel': '#c4b5fd',
    organelle: '#fcd34d', cell: '#67e8f9', molecule: '#f9a8d4', virus: '#fca5a5', other: '#94a3b8',
  },
}

export function resolvePalette(name?: string): BioScenePalette {
  return name === 'clinical' || name === 'journal' ? name : 'default'
}

/**
 * #layout-guard: detect severely overlapping icons (LLM layout failures —
 * everything stacked on one line / giant icons covering neighbours).
 * Returns a short human-readable warning, or null when the layout is OK.
 * Works in percent space (scene coordinates as given).
 */
export function detectLayoutProblems(scene: {
  canvas?: { width?: number; height?: number }
  objects: Array<{ icon: string; x: number; y: number; scale?: number; label?: string }>
}): string | null {
  const objs = scene.objects || []
  const icons: Array<{ id: string; x: number; y: number; r: number }> = []
  for (const o of objs) {
    const icon = resolveIcon(o.icon)
    if (!icon) continue
    const s = Math.min(Math.max(o.scale || 1, 0.2), 3)
    icons.push({ id: icon.id, x: o.x, y: o.y, r: (48 * s) / 2 })
  }
  const overlaps: Array<{ a: string; b: string; d: number }> = []
  for (let i = 0; i < icons.length; i++) {
    for (let j = i + 1; j < icons.length; j++) {
      const a = icons[i]
      const b = icons[j]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (d < (a.r + b.r) * 0.6) {
        overlaps.push({ a: a.id, b: b.id, d: Math.round(d * 10) / 10 })
      }
    }
  }
  if (overlaps.length === 0) return null
  return `layout problem: overlapping icons ${overlaps.slice(0, 3).map((o) => `${o.a}+${o.b}`).join(', ')} — spread the icons apart (keep ≥15 units between centers) and retry`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Render a validated scene to an SVG string. Deterministic.
 *  Coordinates adapt: values ≤ 100 are treated as percentages; larger values
 *  are treated as pixels (0-1000) and scaled to the canvas.
 *  #468: `palette` selects the color scheme (default keeps the legacy
 *  single-gray look). */
export function renderBioScene(scene: {
  canvas?: { width?: number; height?: number }
  objects: Array<{ icon: string; x: number; y: number; scale?: number; rotate?: number; label?: string; colorize?: string }>
  connections?: Array<{ from: number; to: number; kind?: string; bend?: number; label?: string }>
  annotations?: Array<{ type: string; x: number; y: number; text: string }>
}, palette: BioScenePalette = 'default'): string {
  const w = scene.canvas?.width || 800
  const h = scene.canvas?.height || 600
  const colors = PALETTES[palette]
  // Coordinate system: percent (≤100) or pixel (0-1000) — auto-detect.
  const anyPixel = [...scene.objects, ...(scene.annotations || [])].some((o) => o.x > 100 || o.y > 100)
  const px = (v: number, max: number) => (anyPixel ? (Math.min(v, 1000) / 1000) * max : (Math.min(v, 100) / 100) * max)
  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`)
  parts.push(`<rect width="${w}" height="${h}" fill="#ffffff"/>`)

  // Connections first (under objects).
  for (const conn of scene.connections || []) {
    const a = scene.objects[conn.from]
    const b = scene.objects[conn.to]
    if (!a || !b) continue
    const x1 = px(a.x, w)
    const y1 = px(a.y, h)
    const x2 = px(b.x, w)
    const y2 = px(b.y, h)
    const bend = conn.bend || 0
    const mx = (x1 + x2) / 2 + bend * 8
    const my = (y1 + y2) / 2 + bend * 8
    const dash = conn.kind === 'dashed' ? ' stroke-dasharray="6 4"' : ''
    const color = conn.kind === 'inhibition' ? '#dc2626' : conn.kind === 'phosphorylation' ? '#16a34a' : colors.connection
    parts.push(`<path d="M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="2"${dash}/>`)
    // Arrowhead (default arrows).
    if (!conn.kind || conn.kind === 'arrow') {
      const angle = Math.atan2(y2 - my, x2 - mx)
      parts.push(`<polygon points="${x2},${y2} ${x2 - 8 * Math.cos(angle - 0.4)},${y2 - 8 * Math.sin(angle - 0.4)} ${x2 - 8 * Math.cos(angle + 0.4)},${y2 - 8 * Math.sin(angle + 0.4)}" fill="${color}"/>`)
    }
    if (conn.label) {
      parts.push(`<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 4}" fill="${colors.text}" font-size="11" text-anchor="middle">${esc(conn.label)}</text>`)
    }
  }

  // Objects.
  // #layout-guard: track rendered icon boxes (percent space) so we can
  // warn when the LLM stacked objects on top of each other.
  const boxes: Array<{ cx: number; cy: number; r: number; id: string }> = []
  for (const obj of scene.objects) {
    const icon = resolveIcon(obj.icon)
    if (!icon) continue // validation already rejected unknown ids at the tool layer
    const cx = px(obj.x, w)
    const cy = px(obj.y, h)
    // #layout-guard: clamp the scale — a 4x icon can crush the layout.
    const s = Math.min(Math.max(obj.scale || 1, 0.2), 3)
    const size = 48 * s
    const rot = obj.rotate ? ` rotate(${obj.rotate} ${cx} ${cy})` : ''
    boxes.push({ cx, cy, r: size / 2, id: icon.id })

    // #467: external SVG icons (NIH BioArt, public domain) are embedded
    // as-is, scaled to the object size.
    if (icon.svgFile) {
      const ext = readExternalSvg(icon.id)
      if (ext) {
        parts.push(`<g transform="translate(${cx - size / 2}, ${cy - size / 2}) scale(${size / ext.vbWidth})${rot}">`)
        parts.push(ext.inner)
        parts.push(`</g>`)
        if (obj.label) {
          parts.push(`<text x="${cx}" y="${cy + size / 2 + 14}" fill="${colors.text}" font-size="12" text-anchor="middle">${esc(obj.label)}</text>`)
        }
        continue
      }
    }

    // #468: category-colored stroke when a palette is active; explicit
    // colorize always wins.
    const stroke = obj.colorize || colors[icon.category] || colors.stroke
    parts.push(`<g transform="translate(${cx - size / 2}, ${cy - size / 2})${rot}">`)
    parts.push(`<path d="${icon.path}" transform="scale(${size / 24})" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`)
    parts.push(`</g>`)
    if (obj.label) {
      parts.push(`<text x="${cx}" y="${cy + size / 2 + 14}" fill="${colors.text}" font-size="12" text-anchor="middle">${esc(obj.label)}</text>`)
    }
  }

  // Annotations.
  for (const ann of scene.annotations || []) {
    const x = px(ann.x, w)
    const y = px(ann.y, h)
    if (ann.type === 'bracket') {
      parts.push(`<path d="M ${x - 20} ${y} L ${x - 20} ${y + 30} L ${x + 20} ${y + 30}" fill="none" stroke="#94a3b8" stroke-width="1.5"/>`)
      parts.push(`<text x="${x}" y="${y + 44}" fill="${colors.text}" font-size="11" text-anchor="middle">${esc(ann.text)}</text>`)
    } else {
      parts.push(`<text x="${x}" y="${y}" fill="${colors.text}" font-size="12" text-anchor="middle">${esc(ann.text)}</text>`)
    }
  }

  parts.push(`</svg>`)
  return parts.join('\n')
}

export { CATEGORIES }
