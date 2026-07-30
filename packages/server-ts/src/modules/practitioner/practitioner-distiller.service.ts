import type { PractitionerObservation } from './practitioner-extractor.service.js'
import { getApiKey, deepseekChat } from '../../common/llm.js'

export interface DistilledInsight {
  type: 'clinical_impression' | 'key_finding' | 'action_item' | 'uncertainty'
  content: string
  supportingObservations: string[]
  urgency: 'routine' | 'attention' | 'critical'
}

const DISTILL_SYSTEM = `You distill clinical observations into structured insights. Given a list of observations from a clinical encounter, group them into insights. Return JSON array:

[{"type": "clinical_impression|key_finding|action_item|uncertainty", "content": "insight text", "supportingObservations": ["obs content 1", ...], "urgency": "routine|attention|critical"}]

Be concise and clinically meaningful. Identify the most important patterns.`

export async function distillObservations(
  observations: PractitionerObservation[],
): Promise<DistilledInsight[]> {
  if (observations.length === 0) return []

  const obsText = observations
    .map((o, i) => `${i + 1}. [${o.category}] ${o.content} (confidence: ${o.confidence})`)
    .join('\n')

  const apiKey = getApiKey()
  try {
    const raw = await deepseekChat(
      [{ role: 'system', content: DISTILL_SYSTEM }, { role: 'user', content: obsText }],
      apiKey,
      { model: 'deepseek-chat', maxTokens: 1024, temperature: 0.3 },
    )
    const parsed = JSON.parse(raw)
    return (Array.isArray(parsed) ? parsed : []).map((i: any) => ({
      type: i.type,
      content: i.content,
      supportingObservations: i.supportingObservations || [],
      urgency: i.urgency || 'routine',
    }))
  } catch {
    return []
  }
}
