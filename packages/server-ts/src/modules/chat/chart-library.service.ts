/**
 * #402-followup — Generated-chart library: lists every SVG the AI has
 * produced (render_chart / render_scene — Reactome originals and custom
 * bioscene diagrams), joining the uploads directory with the event log to
 * recover titles, tool and render mode.
 */
import fs from 'fs'
import path from 'path'
import { getUserContext } from '../chat/user-context.js'

export interface GeneratedChartEntry {
  file_id: string
  url: string
  title: string
  tool: 'render_scene' | 'render_chart' | 'unknown'
  mode: 'reactome' | 'bioscene' | 'chart' | 'unknown'
  size_bytes: number
  created_at: string
  pathway_id?: string
}

const SCENE_PREFIX = 'scene_'
const CHART_PREFIX = 'chart_'

/** Heuristic: Reactome SVGs are large-viewBox official diagrams. */
function detectMode(fileId: string, svgHead: string): 'reactome' | 'bioscene' | 'chart' | 'unknown' {
  if (fileId.startsWith(CHART_PREFIX)) return 'chart'
  // Reactome diagrams have huge viewBoxes and use stroke-dasharray="none".
  if (svgHead.includes('stroke-dasharray="none"') || /viewBox="[-\d. ]+ \d{4,}/.test(svgHead)) return 'reactome'
  return 'bioscene'
}

/** Recover { title, tool, pathway_id } for a file from the event log. */
function findEventMeta(
  events: Array<{ eventType: string; content: string; metadata: any }>,
  fileId: string,
): { title?: string; tool?: string; pathwayId?: string } {
  // tool_result events carry the tool output JSON (file_id + markdown).
  for (const evt of events) {
    if (evt.eventType !== 'tool_result') continue
    if (!evt.content || !evt.content.includes(fileId)) continue
    try {
      const parsed = JSON.parse(evt.content)
      if (parsed.file_id !== fileId) continue
      const title = String(parsed.title || parsed.pathway_name || parsed.markdown || '')
        .replace(/^!\[([^\]]*)\]\(.*\)$/, '$1')
        .replace(/^!\[/, '')
        .replace(/\]\(.*\)$/, '')
        .trim()
      return {
        title: title || undefined,
        tool: parsed.pathway_id ? 'render_scene' : parsed.chart_type ? 'render_chart' : undefined,
        pathwayId: parsed.pathway_id,
      }
    } catch { /* not JSON */ }
  }
  return {}
}

/** List every generated chart SVG for a user, newest first. */
export function listGeneratedCharts(userId: string): GeneratedChartEntry[] {
  const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
  if (!fs.existsSync(dir)) return []

  const files = fs.readdirSync(dir)
    .filter((f) => (f.startsWith(SCENE_PREFIX) || f.startsWith(CHART_PREFIX)) && f.endsWith('.svg'))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f))
      const head = fs.readFileSync(path.join(dir, f), 'utf-8').slice(0, 600)
      return { file_id: f, stat, head }
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)

  // Event log lookup for titles/tools (best-effort).
  let events: Array<{ eventType: string; content: string; metadata: any }> = []
  try {
    const ctx = getUserContext(userId)
    events = ctx.eventLog.query({ limit: 2000 })
  } catch { /* no context */ }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return files.map(({ file_id, stat, head }) => {
    const meta = findEventMeta(events, file_id)
    const mode = detectMode(file_id, head)
    return {
      file_id,
      url: '',
      title: meta.title || (mode === 'reactome' ? 'Reactome pathway diagram' : mode === 'chart' ? 'Chart' : 'Custom schematic'),
      tool: (meta.tool as GeneratedChartEntry['tool']) || (file_id.startsWith(CHART_PREFIX) ? 'render_chart' : 'render_scene'),
      mode,
      size_bytes: stat.size,
      created_at: new Date(stat.mtimeMs).toISOString(),
      pathway_id: meta.pathwayId,
    }
  })
}

/** Attach <img>-friendly signed URLs to library entries. */
export function withChartTokens(entries: GeneratedChartEntry[], issueToken: (fileId: string, userId: string) => string, userId: string): GeneratedChartEntry[] {
  return entries.map((e) => ({ ...e, url: `/api/v1/files/download/${e.file_id}?token=${issueToken(e.file_id, userId)}` }))
}
