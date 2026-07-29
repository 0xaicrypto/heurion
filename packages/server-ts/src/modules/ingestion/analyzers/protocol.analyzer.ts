import { extractRulesFromProtocol } from '../../research/protocol-extractor.js'
import type { IngestionAnalyzer, IngestionJob, IngestionResult, MedicalRecordEntryDraft } from '../ingestion.service.js'

export const protocolAnalyzer: IngestionAnalyzer = {
  name: 'protocol',
  async analyze(job: IngestionJob): Promise<IngestionResult> {
    const text = job.extractedText || ''
    if (!text.trim()) {
      return {
        confidence: 'low',
        reasoning: 'No extracted text available for protocol analysis.',
        entries: [],
      }
    }

    if (!job.studyId) {
      return {
        confidence: 'low',
        reasoning: 'Protocol ingestion requires a studyId context.',
        entries: [],
      }
    }

    const rules = await extractRulesFromProtocol(job.studyId, text, {
      telemetryContext: {
        userId: job.userId,
        workspaceId: job.userId,
        action: 'ingestion.protocol_analyze',
      },
      sourceJobId: job.id,
      extractedFrom: job.fileName,
    })

    if (rules.length === 0) {
      return {
        confidence: 'low',
        reasoning: 'No structured rules identified in protocol text.',
        entries: [],
      }
    }

    const lines = rules.map((r) => `[${r.category}] ${r.rule}`)
    const content = `提取到 ${rules.length} 条研究规则/事件：\n${lines.join('\n')}`

    const entry: MedicalRecordEntryDraft = {
      type: 'protocol',
      title: `[Protocol] ${job.fileName}`,
      date: new Date().toISOString(),
      content,
      aiSummary: `${rules.filter((r) => r.category === 'inclusion').length} inclusion, ${rules.filter((r) => r.category === 'exclusion').length} exclusion, ${rules.filter((r) => r.category === 'schedule').length} schedule rules`,
      status: 'pending_review',
      createdBy: 'system',
      extractedText: text,
      rawJson: { source: 'protocol', studyId: job.studyId, rules },
    }

    return {
      confidence: 'medium',
      reasoning: `Extracted ${rules.length} protocol rule(s) and persisted pending StudyProtocolRule records.`,
      entries: job.patientHash ? [entry] : [],
    }
  },
}
