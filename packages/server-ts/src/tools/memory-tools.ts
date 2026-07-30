import { BaseTool, ToolResult } from './base-tool.js'
import type { ToolContext } from './tool-registry.js'

export class SearchPastChatsTool extends BaseTool {
  constructor(private ctx: ToolContext) { super() }

  get name(): string { return 'search_past_chats' }
  get description(): string {
    return 'Search past chat conversations for relevant information. Use when the user refers to something discussed earlier, or when you need context from previous sessions on a topic.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (free-text, matched against conversation content).' },
        patient_hash: { type: 'string', description: 'Optional patient hash to scope search.' },
        top_k: { type: 'integer', description: 'Max results (default 5).', default: 5 },
      },
      required: ['query'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args.query || '')
    const patientHash = args.patient_hash ? String(args.patient_hash) : undefined
    const topK = Number(args.top_k || 5)
    if (!query) return { success: false, error: 'query required' }

    const q = query.toLowerCase()
    const sessions = this.ctx.episodes.all()
    const scored = sessions
      .map(s => {
        const summary = (s.summary || '').toLowerCase()
        let score = 0
        if (summary.includes(q)) score += 5
        const words = q.split(/\s+/).filter(w => w.length > 2)
        for (const w of words) { if (summary.includes(w)) score += 2 }
        return { session: s, score }
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)

    const results = scored.map(s => ({
      session_id: s.session.sessionId,
      summary: s.session.summary,
      turn_count: (s.session as any).turnCount || 0,
      score: s.score,
    }))

    return {
      success: true,
      output: results.length > 0
        ? JSON.stringify({ results, total: results.length }, null, 2)
        : 'No matching past conversations found.',
    }
  }
}
