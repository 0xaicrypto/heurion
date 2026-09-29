/** #1146 循环依赖:ingestion 共享类型下沉叶子模块 —
 * service(注册默认分析器) 与 analyzer-registry(接口/实现) 此前互引成环。
 * 原字段 `any` 收窄为 `unknown`(消费端显式收窄)。 */

export interface MedicalRecordEntryDraft {
  type: string
  title: string
  date: string
  content: string
  aiSummary?: string
  status?: string
  createdBy?: 'system' | 'user' | 'agent'
  extractedText?: string
  rawJson?: Record<string, unknown>
}

export interface IngestionResult {
  confidence: 'high' | 'medium' | 'low'
  reasoning: string
  entries: MedicalRecordEntryDraft[]
  errors?: string[]
}

export interface IngestionJob {
  id: string
  userId: string
  fileId: string
  fileName: string
  mimeType: string
  patientHash?: string
  studyId?: string
  uploadedBy: string
  extractedText?: string
  extractedJson?: unknown
  status: string
  confidence?: string
  reasoning?: string
  resultPayload?: unknown
  retryCount: number
  failedReason?: string
  createdAt: string
  updatedAt: string
}

export interface IngestionAnalyzer {
  name: string
  analyze(job: IngestionJob): Promise<IngestionResult>
}
