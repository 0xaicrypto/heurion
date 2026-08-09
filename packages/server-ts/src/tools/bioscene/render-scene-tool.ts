/**
 * #408: render_scene — LLM-visible tool for molecular/mechanism diagrams.
 * The icon catalog is the quality gate: unknown icon ids are rejected
 * (never invented shapes). Output is a deterministic SVG saved as an
 * attachment, ready to embed in chat/documents.
 */
import { BaseTool, ToolResult } from '../base-tool.js'
import { biosceneContentSchema } from '@heurion/contracts'
import { iconCatalog, resolveIcon, renderBioScene } from './bioscene.js'
import { resolvePathway, searchPathways, fetchPathwayDiagram, reactomeCatalog } from './reactome-service.js'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export class RenderSceneTool extends BaseTool {
  constructor(private ctx: { userId: string }) { super() }

  get name(): string { return 'render_scene' }
  get description(): string {
    return `Render a molecular biology / mechanism schematic.
MODE 1 — standard pathway (template_source=reactome): authoritative Reactome pathway diagrams (EGFR signaling, PI3K cascade, PD-1 co-inhibition, apoptosis, etc.). Use for STANDARD well-known signaling pathways: pass template_source:"reactome" + pathway (name or ID, e.g. "EGFR signaling"). Returns the official Reactome diagram.
MODE 2 — custom schematic (default, bioscene): build a custom mechanism diagram with icons from the restricted catalog (membrane, receptor, EGFR, PD-L1, kinase, ion channels, organelles, cells, antibody, ligand, TKI, drug, apoptosis, proliferation) using {icon, x, y, scale?, rotate?, label?, colorize?}; connections {from, to, kind: arrow|dashed|phosphorylation|inhibition, bend?, label?}; annotations {type: text|bracket, x, y, text}. Use for custom mechanism illustrations, highlighting specific sites, combined therapies. Unknown icons are rejected.
Returns an SVG file.`
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        template_source: { type: 'string', enum: ['bioscene', 'reactome'], description: 'bioscene = custom schematic (default); reactome = official Reactome pathway diagram' },
        pathway: { type: 'string', description: 'For template_source=reactome: pathway name or R-HSA id, e.g. "EGFR signaling", "PD-1 co-inhibition", "凋亡通路"' },
        title: { type: 'string', description: 'Diagram title (used for the file name)' },
        palette: { type: 'string', enum: ['default', 'clinical', 'journal'], description: '#468: color scheme — clinical (vivid categorical colors), journal (low-saturation academic), default (legacy gray)' },
        canvas: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } } },
        objects: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              icon: { type: 'string', description: 'Catalog icon id or alias' },
              x: { type: 'number', description: '0-100 (percent) or 0-1000 (pixels)' }, y: { type: 'number', description: '0-100 (percent) or 0-1000 (pixels)' },
              scale: { type: 'number' }, rotate: { type: 'number' },
              label: { type: 'string' }, colorize: { type: 'string' },
            },
            required: ['icon', 'x', 'y'],
          },
        },
        connections: { type: 'array', items: { type: 'object', properties: { from: { type: 'number' }, to: { type: 'number' }, kind: { type: 'string' }, bend: { type: 'number' }, label: { type: 'string' } } } },
        annotations: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' } } } },
      },
      required: [],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    // #466: MODE 1 — Reactome official pathway diagram.
    if (args.template_source === 'reactome') {
      return this.renderReactome(String(args.pathway || ''), String(args.title || 'pathway'))
    }

    const scene = { canvas: args.canvas, objects: args.objects, connections: args.connections, annotations: args.annotations, schemaVersion: 1 }
    const check = biosceneContentSchema.safeParse(scene)
    if (!check.success) {
      return { success: false, error: `Invalid scene: ${check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 5).join('; ')}` }
    }

    // Quality gate: every icon must resolve in the restricted catalog.
    const unknown = (scene.objects as Array<{ icon: string }>)
      .map((o) => o.icon)
      .filter((id) => !resolveIcon(id))
    if (unknown.length > 0) {
      return {
        success: false,
        error: `Unknown icons (rejected — catalog only): ${unknown.join(', ')}. Available: ${iconCatalog().slice(0, 30).map((i) => i.id).join(', ')}`,
      }
    }

    try {
      // #468: palette — clinical/journal colored schemes, default = legacy.
      const palette = args.palette === 'clinical' || args.palette === 'journal' ? args.palette : 'default'
      const svg = renderBioScene(check.data as any, palette)
      const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', this.ctx.userId, 'uploads')
      fs.mkdirSync(dir, { recursive: true })
      const fileId = `scene_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.svg`
      fs.writeFileSync(path.join(dir, fileId), svg, 'utf-8')

      // <img> tags cannot send an Authorization header — issue a short-lived
      // query token so the scene renders inside chat/documents (same pattern
      // as render_chart).
      let url = `/api/v1/files/download/${fileId}`
      try {
        const { issueChartToken } = await import('../../modules/files/files.router.js')
        url = `${url}?token=${issueChartToken(fileId, this.ctx.userId)}`
      } catch {
        // token issuance unavailable — URL still works for API consumers
      }

      const title = (args.title as string) || 'scene'
      return {
        success: true,
        output: JSON.stringify({ file_id: fileId, url, markdown: `![${title}](${url})`, objects: (scene.objects as any[]).length }, null, 2),
      }
    } catch (err) {
      return { success: false, error: `render_scene failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }

  /** #466: MODE 1 — official Reactome pathway diagram (CC BY 4.0). */
  private async renderReactome(query: string, title: string): Promise<ToolResult> {
    const entry = resolvePathway(query)
    if (!entry) {
      const candidates = searchPathways(query)
      const hint = candidates.length > 0
        ? ` Available: ${candidates.map((c) => `${c.name} (${c.id})`).join('; ')}`
        : ` Catalog has ${reactomeCatalog().pathways.length} pathways; try "EGFR signaling", "PD-1 co-inhibition", "Intrinsic Pathway for Apoptosis".`
      return { success: false, error: `Unknown Reactome pathway: "${query}".${hint}` }
    }

    const svg = await fetchPathwayDiagram(entry.id)
    if (!svg) {
      return {
        success: false,
        error: `Pathway "${entry.name}" (${entry.id}) is not available: REACTOME_DIAGRAMS_BASE_URL is not configured or the diagram could not be fetched. Run scripts/upload-reactome-diagrams.js to publish the diagrams to object storage.`,
      }
    }

    try {
      const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', this.ctx.userId, 'uploads')
      fs.mkdirSync(dir, { recursive: true })
      const fileId = `scene_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.svg`
      fs.writeFileSync(path.join(dir, fileId), svg, 'utf-8')

      let url = `/api/v1/files/download/${fileId}`
      try {
        const { issueChartToken } = await import('../../modules/files/files.router.js')
        url = `${url}?token=${issueChartToken(fileId, this.ctx.userId)}`
      } catch {
        // token issuance unavailable — URL still works for API consumers
      }

      const finalTitle = title || entry.name
      const attribution = reactomeCatalog().attribution
      return {
        success: true,
        output: JSON.stringify({
          file_id: fileId,
          url,
          pathway_id: entry.id,
          pathway_name: entry.name,
          markdown: `![${finalTitle}](${url})\n\n*${attribution}*`,
        }, null, 2),
      }
    } catch (err) {
      return { success: false, error: `render_scene (reactome) failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}
