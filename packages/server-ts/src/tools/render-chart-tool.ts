import fs from 'fs'
import path from 'path'
import { BaseTool, ToolResult } from './base-tool.js'
import { renderSvgChart, type ChartInput } from './chart-renderer.js'
import prisma from '../common/prisma.js'

/**
 * #176 — render_chart: the AI generates deterministic SVG charts (Bragg
 * curves, dose distributions, bar/line) which are saved as attachments and
 * returned with a markdown-embeddable URL.
 */
export class RenderChartTool extends BaseTool {
  constructor(private ctx: { userId: string; sessionId?: string }) {
    super()
  }

  get name(): string { return 'render_chart' }

  get description(): string {
    return 'Generate a chart (SVG) from data — line, bar, dose_curve (Bragg peak depth-dose) or a simple schematic. Returns an image URL you can embed with markdown. Use when the user asks for a plot/chart/curve/figure.'
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['line', 'bar', 'dose_curve', 'schematic'], description: 'Chart type: dose_curve for proton depth-dose (Bragg peak) plots.' },
        data: {
          type: 'array',
          items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' } }, required: ['label', 'value'] },
          description: 'Data points (omit for dose_curve to use the standard Bragg model).',
        },
        errors: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, error: { type: 'number' } } }, description: '#407: per-bar error bar half-width (SD/SEM/CI) — bar charts.' },
        sig: { type: 'object', properties: { pair: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 }, stars: { type: 'string' }, p: { type: 'string' } }, description: '#407: significance bracket between two bars (Prism-style).' },
        title: { type: 'string', description: 'Chart title.' },
        x_label: { type: 'string' },
        y_label: { type: 'string' },
        description: { type: 'string', description: 'For schematic: what the diagram should convey.' },
        // #228: real programmatic schematics — no placeholder boxes.
        template: { type: 'string', enum: ['beam_scan'], description: 'Built-in diagram template (schematic only): beam_scan draws a pencil-beam scanning setup (nozzle → fan beams → GTV/CTV targets → Bragg depth-dose inset).' },
        elements: {
          type: 'array',
          description: 'Custom diagram elements (schematic only, when no template fits): rect/circle/line/arrow/text/beam primitives in a 500x300 canvas.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['rect', 'circle', 'line', 'arrow', 'text', 'beam'] },
              x: { type: 'number' }, y: { type: 'number' },
              w: { type: 'number' }, h: { type: 'number' }, r: { type: 'number' },
              x2: { type: 'number' }, y2: { type: 'number' },
              text: { type: 'string' },
              color: { type: 'string' }, fill: { type: 'string' },
              dashed: { type: 'boolean' },
              width: { type: 'number', description: 'beam: entry width' },
              exitWidth: { type: 'number', description: 'beam: exit width' },
              angle: { type: 'number', description: 'beam: angle in degrees (0 = straight down)' },
            },
            required: ['kind', 'x', 'y'],
          },
        },
      },
      required: ['type'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const type = String(args.type || '') as ChartInput['type']
    if (!['line', 'bar', 'dose_curve', 'schematic'].includes(type)) {
      return { success: false, error: `Unsupported chart type: ${type}` }
    }
    const input: ChartInput = {
      type,
      data: Array.isArray(args.data) ? (args.data as Array<{ label: string; value: number }>) : undefined,
      errors: Array.isArray(args.errors) ? (args.errors as Array<{ label: string; error: number }>) : undefined,
      sig: args.sig as { pair: [string, string]; stars: string; p?: string } | undefined,
      title: args.title ? String(args.title) : undefined,
      x_label: args.x_label ? String(args.x_label) : undefined,
      y_label: args.y_label ? String(args.y_label) : undefined,
      description: args.description ? String(args.description) : undefined,
      template: args.template === 'beam_scan' ? 'beam_scan' : undefined,
      elements: Array.isArray(args.elements) ? (args.elements as any[]) : undefined,
    }

    try {
      const svg = renderSvgChart(input)
      const userId = this.ctx.userId
      const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
      fs.mkdirSync(dir, { recursive: true })
      const fileId = `chart_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.svg`
      const filepath = path.join(dir, fileId)
      fs.writeFileSync(filepath, svg, 'utf-8')

      const now = new Date().toISOString()
      try {
        await (prisma as any).fileIndex.upsert({
          where: { id: fileId },
          create: {
            id: fileId, userId, fileName: `${input.title || 'chart'}.svg`, mimeType: 'image/svg+xml',
            sizeBytes: Buffer.byteLength(svg), sha256: '', createdAt: now, updatedAt: now,
          },
          update: {},
        })
      } catch {
        // fileIndex may not exist — the file is still saved
      }

      // <img> tags cannot send an Authorization header — issue a short-lived
      // query token so the chart renders inside documents and chat.
      let url = `/api/v1/files/download/${fileId}`
      try {
        const { issueChartToken } = await import('../modules/files/files.router.js')
        url = `${url}?token=${issueChartToken(fileId, userId)}`
      } catch {
        // token issuance unavailable — URL still works for API consumers
      }

      return {
        success: true,
        output: JSON.stringify({
          file_id: fileId,
          url,
          markdown: `![${esc(input.title || 'chart')}](${url})`,
          type,
        }),
      }
    } catch (err) {
      return { success: false, error: `render_chart failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}

function esc(s: string): string {
  return String(s).replace(/"/g, '&quot;')
}
