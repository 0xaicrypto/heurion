import { EventLog, Event } from '../../core/event-log'
import { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../../evolution/stores'
import { ContractEngine } from '../../core/contracts'
import { MemoryProjection } from '../../retrieval/memory-projection'
import { deepseekChat, getApiKey } from '../../common/llm.js'
import { detectGap, autoResolveGaps } from '../../evolution/cascade-gaps.js'

export class ChatOrchestrator {
  private projection: MemoryProjection

  constructor(
    private eventLog: EventLog,
    private factsStore: FactsStore,
    private episodesStore: EpisodesStore,
    private skillsStore: SkillsStore,
    private knowledgeStore: KnowledgeStore,
    private contracts: ContractEngine,
  ) {
    this.projection = new MemoryProjection(eventLog)
  }

  async turn(params: {
    userId: string; message: string; sessionId: string
    patientHash: string | null; persona: string
    llmCall: (systemPrompt: string, userMessage: string) => Promise<string>
  }): Promise<{ userEvent: Event; response: string; budget: any[] }> {
    const { userId, message, sessionId, patientHash, persona, llmCall } = params

    const userEvent = this.eventLog.append({
      timestamp: Date.now() / 1000, eventType: 'user_message', content: message,
      metadata: { patientHash }, agentId: userId, sessionId,
    })

    const projected = await this.projection.project({
      userId, patientHash, sessionId,
      persona, facts: this.factsStore.all(), episodes: this.episodesStore.all(), skills: this.skillsStore.all(),
    })

    const preCheck = this.contracts.preCheck(message)
    if (preCheck.violations.length > 0) console.warn('pre-check violations:', preCheck.violations)

    const response = await llmCall(projected.systemPrompt, message)

    const postCheck = this.contracts.postCheck(message, response)
    this.eventLog.append({
      timestamp: Date.now() / 1000, eventType: 'assistant_response', content: response,
      metadata: { contractPassed: postCheck.passed }, agentId: userId, sessionId,
    })

    return { userEvent, response, budget: projected.budget }
  }

  // #2: Extract facts automatically using DeepSeek
  async postTurn(userId: string, sessionId: string, userMessage: string, patientHash?: string) {
    const recentEvents = this.eventLog.query({ sessionId, limit: 6 }).reverse()
    const conversation = recentEvents
      .map(e => `${e.eventType === 'user_message' ? 'USER' : 'AI'}: ${e.content.slice(0, 300)}`)
      .join('\n')

    const turnCount = this.eventLog.query({ sessionId }).length
    this.episodesStore.upsert(sessionId, userMessage.slice(0, 150), turnCount)

    const totalTurns = this.eventLog.count()
    if (totalTurns % 5 === 0 && totalTurns > 0) {
      try {
        const apiKey = getApiKey()
        const patientCtx = patientHash
          ? '\nCurrent context: discussing patient ' + patientHash + '. Facts about this patient should have sourceType: "patient" and patientHash set.'
          : ''
        const extractionPrompt = `Extract key facts from this clinical conversation. Return ONLY a JSON array of objects with:
- category: preference/fact/constraint/goal/context
- importance: 1-5
- content: short sentence
- sourceType: "patient" (if about a specific patient), "doctor" (if about doctor's preference/workflow), "research" (if about studies/trials), "general" (otherwise)
${patientCtx}\n\n${conversation}\n\n[JSON array]:`

        const result = await deepseekChat([{ role: 'user', content: extractionPrompt }], apiKey)
        const jsonMatch = result.match(/\[[\s\S]*\]/)
        if (jsonMatch) {
          const facts = JSON.parse(jsonMatch[0])
          for (const f of facts) {
            if (f.category && f.content) {
              this.factsStore.add({
                category: f.category,
                importance: Math.min(5, Math.max(1, f.importance || 3)),
                content: f.content,
                sourceType: f.sourceType || 'general',
                patientHash: f.sourceType === 'patient' ? (patientHash || undefined) : undefined,
              })
            }
          }
          this.factsStore.commit()
          this.eventLog.append({
            timestamp: Date.now() / 1000,
            eventType: 'evolution',
            content: `🧠 Extracted ${facts.length} new facts`,
            metadata: { factCount: facts.length, categories: [...new Set(facts.map((f: any) => f.category))] },
            agentId: userId, sessionId,
          })
          console.log(`[EVOLVE] Extracted ${facts.length} facts (turn ${totalTurns})`)

          // Auto-resolve pending gaps that match new facts
          const resolved = autoResolveGaps(userId, facts)
          if (resolved.length > 0) console.log(`[GAP] Auto-resolved ${resolved.length} gaps`)

          // Auto-generate knowledge article when 3+ facts accumulate
          const allFacts = this.factsStore.all()
          if (allFacts.length >= 3 && allFacts.length % 5 === 0) {
            try {
              const factList = allFacts.slice(-10).map(f => `[${f.category}] ${f.content}`).join('\n')
              const articlePrompt = `Synthesize these clinical facts into a concise knowledge article (1-2 paragraphs):\n\n${factList}\n\nReturn JSON: { "title": "...", "content": "..." }`
              const articleResult = await deepseekChat([{ role: 'user', content: articlePrompt }], apiKey)
              const jsonMatch2 = articleResult.match(/\{[\s\S]*\}/)
              if (jsonMatch2) {
                const article = JSON.parse(jsonMatch2[0])
                if (article.title && article.content) {
                  this.knowledgeStore.add({
                    title: article.title,
                    content: article.content,
                    sources: allFacts.slice(-10).map((f: any) => f.id),
                  })
                  this.knowledgeStore.commit()
                  console.log(`[KNOWLEDGE] Article generated: ${article.title}`)
                }
              }
            } catch (err) {
              console.log('[KNOWLEDGE] Article generation skipped:', (err as Error).message.slice(0, 100))
            }
          }
        }
      } catch (err) {
        console.log('[EVOLVE] Fact extraction skipped:', (err as Error).message.slice(0, 100))
      }
    }

    // Detect knowledge gaps on every turn — queries with no matching facts
    try {
      const relatedFacts = this.factsStore.all().filter(f =>
        userMessage.toLowerCase().split(/\s+/)
          .map(w => w.replace(/[^\p{L}\p{N}]/gu, ''))
          .filter(Boolean)
          .some(w => w.length > 3 && f.content.toLowerCase().includes(w))
      )
      if (relatedFacts.length === 0 && userMessage.length > 15) {
        detectGap(userMessage, userId, 0, conversation.slice(0, 300))
        console.log(`[GAP] Detected: "${userMessage.slice(0, 80)}"`)
      }
    } catch (err) {
      console.log('[GAP] Detection skipped:', (err as Error).message.slice(0, 100))
    }
  }
}
