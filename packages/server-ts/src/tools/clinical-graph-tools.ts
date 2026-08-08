import { BaseTool, ToolResult } from './base-tool.js'
import type { ToolContext } from './tool-registry.js'

export class SearchNodeTool extends BaseTool {
  constructor(private ctx: ToolContext) { super() }

  get name(): string { return 'search_node' }
  get description(): string {
    return 'Find clinical entities (facts, findings, meds, labs) and their connected information for a specific patient. Use when the question is entity-centric: "What did we conclude about the left renal mass?", "List all meds the patient is on."'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        patient_hash: { type: 'string', description: 'PHI-safe patient hash to search within.' },
        query: { type: 'string', description: 'Free-text query matched against node content.' },
        entity_type: { type: 'string', description: 'Optional filter: fact, article, document, gap, entity', enum: ['fact', 'article', 'document', 'gap', 'entity'] },
        top_k: { type: 'integer', description: 'Max results (default 8).', default: 8 },
      },
      required: ['patient_hash', 'query'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const patientHash = String(args.patient_hash || '')
    const query = String(args.query || '')
    const entityType = args.entity_type ? String(args.entity_type) : undefined
    const topK = Number(args.top_k || 8)
    if (!patientHash || !query) return { success: false, error: 'patient_hash and query required' }

    const allNodes = this.ctx.memory.graph.getAllNodes()
    const q = query.toLowerCase()

    // Tier 2: semantic retrieval over reviewed memories first (embedding
    // index, patient-isolated). Falls back to substring matching when the
    // embedding service is unavailable.
    let semanticHits: Array<{ stableId: string; content: string; type: string; score: number }> = []
    try {
      const { MemoryGraphGateway } = await import('../memory/memory-gateway.js')
      const gateway = new MemoryGraphGateway(
        this.ctx.userId,
        this.ctx.memory,
        this.ctx.facts,
        this.ctx.episodes,
        this.ctx.skills,
        this.ctx.knowledge,
      )
      semanticHits = await gateway.retrieve(query, { patientHash }, { topK, minScore: 0.35 })
    } catch {
      semanticHits = []
    }

    let candidates: any[] = []
    if (semanticHits.length > 0) {
      const byStable = new Map(allNodes.map((n) => [n.stableId, n]))
      candidates = semanticHits
        .filter((h) => !entityType || h.type === entityType)
        .map((h) => byStable.get(h.stableId))
        .filter((n): n is any => Boolean(n))
    } else {
      // #199: fallback uses a per-call keyword inverted index + patientHash
      // grouping instead of JSON.stringify-scanning every node.
      // Build once: keyword -> node ids, patientHash -> node ids.
      const byPatient = new Map<string | undefined, any[]>()
      const keywordIndex = new Map<string, any[]>()
      for (const n of allNodes) {
        const ph = (n as any).patientHash
        const group = byPatient.get(ph)
        if (group) group.push(n)
        else byPatient.set(ph, [n])
        const text = `${(n as any).content || ''} ${(n as any).title || ''}`.toLowerCase()
        const tokens = text.split(/[^a-z0-9一-龥]+/).filter((w) => w.length > 1)
        for (const tok of tokens) {
          const list = keywordIndex.get(tok)
          if (list) { if (!list.includes(n)) list.push(n) }
          else keywordIndex.set(tok, [n])
        }
      }
      const scoped = byPatient.get(patientHash) || []
      const queryTokens = q.split(/[^a-z0-9一-龥]+/).filter((w) => w.length > 1)
      let matched: any[] = []
      if (queryTokens.length > 0) {
        // Union of nodes that contain any query token, then exact-substring
        // check on the small candidate set (keeps behavior identical).
        const seen = new Set<any>()
        for (const tok of queryTokens) {
          const kw = q.includes(tok) ? tok : tok
          for (const n of keywordIndex.get(kw) || []) {
            if ((n as any).patientHash === patientHash && !seen.has(n)) { seen.add(n); matched.push(n) }
          }
        }
      }
      candidates = matched
        .filter((n) => (entityType ? n.type === entityType : true))
        .filter((n) => JSON.stringify(n).toLowerCase().includes(q))
        .slice(0, topK)
      if (candidates.length === 0 && scoped.length > 0) {
        // Single-token queries without index hits: fall back to scoped scan
        // only within this patient's group (never the whole graph).
        candidates = scoped
          .filter((n) => (entityType ? n.type === entityType : true))
          .filter((n) => JSON.stringify(n).toLowerCase().includes(q))
          .slice(0, topK)
      }
    }

    // #199: neighbor lookup is grouped by patientHash (built once).
    const byPatientAll = new Map<string | undefined, any[]>()
    for (const n of allNodes) {
      const ph = (n as any).patientHash
      const group = byPatientAll.get(ph)
      if (group) group.push(n)
      else byPatientAll.set(ph, [n])
    }
    const neighborPool = byPatientAll.get(patientHash) || allNodes
    const hits = candidates.slice(0, topK).map(n => {
      const connected = neighborPool.filter(other =>
        other.id !== n.id &&
        ['fact', 'article'].includes(other.type)
      ).slice(0, 5)

      return {
        node_id: n.stableId || n.id,
        node_type: n.type,
        content: (n as any).content || (n as any).title || '',
        connected: connected.map(c => ({
          node_id: c.stableId || c.id,
          node_type: c.type,
          content: (c as any).content || '',
        })),
      }
    })

    return {
      success: true,
      output: JSON.stringify({ hits, total: candidates.length, semantic: semanticHits.length > 0 }, null, 2),
    }
  }
}

export class SearchEncounterTool extends BaseTool {
  constructor(private ctx: ToolContext) { super() }

  get name(): string { return 'search_encounter' }
  get description(): string {
    return 'Find encounters (chat sessions, studies, lab postings) for a patient. Use for temporal or summary queries: "When did we last discuss the lesion?", "What changed between visits?"'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        patient_hash: { type: 'string' },
        query: { type: 'string', description: 'Free-text query.' },
        top_k: { type: 'integer', default: 8 },
      },
      required: ['patient_hash', 'query'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const patientHash = String(args.patient_hash || '')
    const query = String(args.query || '')
    const topK = Number(args.top_k || 8)
    if (!patientHash || !query) return { success: false, error: 'patient_hash and query required' }

    const events = this.ctx.eventLog.query({ limit: 200 }).filter(e =>
      (e.metadata as any)?.patientHash === patientHash ||
      e.content?.toLowerCase().includes(query.toLowerCase())
    )

    const sessionMap = new Map<string, { events: typeof events; lastTouched: number; count: number }>()
    for (const evt of events) {
      const sid = evt.sessionId || 'unknown'
      if (!sessionMap.has(sid)) sessionMap.set(sid, { events: [], lastTouched: 0, count: 0 })
      const entry = sessionMap.get(sid)!
      entry.events.push(evt)
      entry.count++
      entry.lastTouched = Math.max(entry.lastTouched, evt.timestamp)
    }

    const encounters = Array.from(sessionMap.entries())
      .sort((a, b) => b[1].lastTouched - a[1].lastTouched)
      .slice(0, topK)
      .map(([sessionId, data]) => ({
        encounter_id: sessionId,
        node_count: data.count,
        last_touched: data.lastTouched,
        sample: data.events.slice(-3).map(e => ({
          event_type: e.eventType,
          content: e.content?.slice(0, 200),
        })),
      }))

    return {
      success: true,
      output: JSON.stringify({ encounters }, null, 2),
    }
  }
}
