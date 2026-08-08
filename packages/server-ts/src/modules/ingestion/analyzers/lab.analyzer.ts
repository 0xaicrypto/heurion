import { createAiProvider } from '../../../common/ai/index.js'
import { DEEPSEEK_CHAT_MODEL } from '../../../common/llm.js'
import type { IngestionAnalyzer, IngestionJob, IngestionResult } from '../ingestion.service.js'

const aiProvider = createAiProvider()

export const labAnalyzer: IngestionAnalyzer = {
  name: 'lab',
  async analyze(job: IngestionJob): Promise<IngestionResult> {
    const text = job.extractedText || ''
    if (!text.trim()) {
      return {
        confidence: 'low',
        reasoning: 'No extracted text available for lab analysis.',
        entries: [],
      }
    }

    const prompt = `You are a clinical data extraction assistant. Given the following medical report text, extract laboratory test results.

Return ONLY a JSON object with this exact shape:
{
  "items": [
    {
      "name": "test name",
      "value": "measured value",
      "unit": "unit",
      "referenceRange": "reference range",
      "abnormal": true or false,
      "interpretation": "short interpretation or empty string"
    }
  ]
}

If the text does not contain lab results, return {"items": []}.

Text:
${text.slice(0, 8000)}

JSON:`

    const chatResult = await aiProvider.chat(
      [{ role: 'user', content: prompt }],
      {
        model: DEEPSEEK_CHAT_MODEL,
        maxTokens: 2048,
        telemetryContext: {
          userId: job.userId,
          workspaceId: job.userId,
          action: 'ingestion.lab_analyze',
        },
      },
    )
    const raw = chatResult.content

    let parsed: { items: any[] }
    try {
      const match = raw.match(/\{[\s\S]*\}/)
      parsed = JSON.parse(match ? match[0] : raw)
    } catch {
      parsed = { items: [] }
    }

    const items = Array.isArray(parsed.items) ? parsed.items : []
    if (items.length === 0) {
      return {
        confidence: 'low',
        reasoning: 'No lab items identified in text.',
        entries: [],
      }
    }

    const entries = items.map((item: any) => ({
      type: 'lab',
      title: item.name || 'Lab test',
      date: new Date().toISOString(),
      content: `${item.name}: ${item.value} ${item.unit || ''} (ref: ${item.referenceRange || 'n/a'})${item.interpretation ? ` — ${item.interpretation}` : ''}`,
      aiSummary: item.abnormal ? `Abnormal: ${item.interpretation || item.value}` : 'Within reference range',
      status: 'pending_review' as const,
      createdBy: 'system' as const,
      extractedText: text,
      rawJson: item,
    }))

    return {
      confidence: 'medium',
      reasoning: `Extracted ${entries.length} lab item(s) from report.`,
      entries,
    }
  },
}
