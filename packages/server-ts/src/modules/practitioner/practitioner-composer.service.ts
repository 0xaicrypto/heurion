import type { PractitionerObservation } from './practitioner-extractor.service.js'
import type { DistilledInsight } from './practitioner-distiller.service.js'
import { getApiKey, deepseekChat } from '../../common/llm.js'

export interface ClinicalNarrative {
  type: 'soap' | 'summary' | 'handoff' | 'progress_note'
  content: string
  sections: Record<string, string>
}

const COMPOSE_SYSTEM = (type: string) => `You compose clinical narratives from structured observations and insights. Given observations and insights, produce a ${type} note.

Return JSON: {"sections": {"subjective": "...", "objective": "...", "assessment": "...", "plan": "..."}, "content": "full narrative text"}

Be concise and clinically precise. Use SOAP format.`

export async function composeNarrative(
  observations: PractitionerObservation[],
  insights: DistilledInsight[],
  narrativeType: ClinicalNarrative['type'] = 'soap',
  patientContext?: string,
): Promise<ClinicalNarrative> {
  const obsBlock = observations.map(o => `[${o.category}] ${o.content}`).join('\n')
  const insightBlock = insights.map(i => `[${i.type}] ${i.content}`).join('\n')

  const prompt = [
    patientContext ? `Patient: ${patientContext}` : '',
    'Observations:', obsBlock,
    'Insights:', insightBlock,
  ].filter(Boolean).join('\n')

  const apiKey = getApiKey()
  try {
    const raw = await deepseekChat(
      [
        { role: 'system', content: COMPOSE_SYSTEM(narrativeType) },
        { role: 'user', content: prompt },
      ],
      apiKey,
      { model: 'deepseek-chat', maxTokens: 2048, temperature: 0.3 },
    )
    const parsed = JSON.parse(raw)
    return {
      type: narrativeType,
      content: parsed.content || '',
      sections: parsed.sections || {},
    }
  } catch {
    return { type: narrativeType, content: '', sections: {} }
  }
}
