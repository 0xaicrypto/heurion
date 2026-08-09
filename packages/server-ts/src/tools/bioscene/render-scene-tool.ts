/**
 * #408: render_scene — LLM-visible tool for molecular/mechanism diagrams.
 * The icon catalog is the quality gate: unknown icon ids are rejected
 * (never invented shapes). Output is a deterministic SVG saved as an
 * attachment, ready to embed in chat/documents.
 */
import { BaseTool, ToolResult } from '../base-tool.js'
import { biosceneContentSchema } from '@heurion/contracts'
import { iconCatalog, resolveIcon, renderBioScene } from './bioscene.js'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export class RenderSceneTool extends BaseTool {
  constructor(private ctx: { userId: string }) { super() }

  get name(): string { return 'render_scene' }
  get description(): string {
    return `Render a molecular biology / mechanism schematic (BioScene). Place only icons from the catalog (membrane, receptor, EGFR, PD-L1, kinase, ion channels, organelles, cells, antibody, ligand, TKI, drug, apoptosis, proliferation) using {icon, x, y, scale?, rotate?, label?, colorize?}; connections {from, to, kind: arrow|dashed|phosphorylation|inhibition, bend?, label?}; annotations {type: text|bracket, x, y, text}. Unknown icons are rejected. Returns an SVG file.`
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Diagram title (used for the file name)' },
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
      required: ['objects'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
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
      const svg = renderBioScene(check.data as any)
      const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', this.ctx.userId, 'uploads')
      fs.mkdirSync(dir, { recursive: true })
      const fileId = `scene_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.svg`
      fs.writeFileSync(path.join(dir, fileId), svg, 'utf-8')
      return {
        success: true,
        output: JSON.stringify({ file_id: fileId, url: `/api/v1/files/${fileId}/download`, objects: (scene.objects as any[]).length }, null, 2),
      }
    } catch (err) {
      return { success: false, error: `render_scene failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}
