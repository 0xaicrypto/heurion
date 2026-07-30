import { getApiKey, deepseekChat } from '../../common/llm.js'

export interface PractitionerObservation {
  category: string
  content: string
  evidence: string
  confidence: number
  timestamp?: number
}

const EXTRACT_SYSTEM = `You are a clinical observation extractor for a medical AI assistant. Given a conversation between a physician and an AI, extract structured observations about the patient's clinical status. Return ONLY a JSON array:

[{"category": "symptom|exam_finding|lab|medication_change|assessment|plan|patient_report", "content": "brief observation text", "evidence": "verbatim quote from the conversation", "confidence": 0.0-1.0}]

Be concise. Extract only what is clearly established. Use the source language for the content field.`

export async function extractPractitionerObservations(
  conversationText: string,
  options?: { model?: string },
): Promise<PractitionerObservation[]> {
  const apiKey = getApiKey()
  const model = options?.model || 'deepseek-chat'
  try {
    const raw = await deepseekChat(
      [{ role: 'system', content: EXTRACT_SYSTEM }, { role: 'user', content: conversationText }],
      apiKey,
      { model, maxTokens: 2048, temperature: 0.2 },
    )
    const parsed = JSON.parse(raw)
    const items = Array.isArray(parsed) ? parsed : parsed.observations || []
    return items
      .filter((i: any) => i.category && i.content && conversationText.includes(i.evidence || ''))
      .map((i: any) => ({
        category: i.category,
        content: i.content,
        evidence: i.evidence || '',
        confidence: Math.max(0, Math.min(1, parseFloat(i.confidence) || 0.7)),
        timestamp: Date.now(),
      }))
  } catch {
    return []
  }
}
