import { deepseekChat, getApiKey, type LlmTelemetryContext } from '../../common/llm.js'
import { createExecutionPlaneService, type ExecutionJobStatus } from './execution-plane.service.js'

const service = createExecutionPlaneService()

export interface ChatHistoryMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface SidecarHandlerOptions {

  userId: string
  workspaceId?: string
  text: string
  patient?: {
    initials?: string | null
    age?: number | null
    sex?: string | null
    diagnosis?: string | null
    chiefComplaint?: string | null
  } | null
  /** Prior conversation messages in this session, injected as context. */
  history?: ChatHistoryMessage[]
  telemetryContext?: LlmTelemetryContext
}

function detectJobType(text: string): {
  type: string
  templateId: string
  outputName: string
} {
  const q = text.toLowerCase()
  if (/pptx?|powerpoint|幻灯片|汇报/.test(q)) {
    return { type: 'sidecar.generate_pptx', templateId: 'academic_presentation', outputName: 'Presentation' }
  }
  if (/表格|table|基线特征|baseline/.test(q)) {
    return { type: 'sidecar.render_table', templateId: 'baseline_table', outputName: 'Table_1' }
  }
  if (/图表|chart|plot|图|曲线/.test(q)) {
    return { type: 'sidecar.render_plot', templateId: 'km_curve', outputName: 'Plot' }
  }
  if (/出院小结|discharge summary/.test(q)) {
    return { type: 'sidecar.generate_docx', templateId: 'discharge_summary', outputName: 'Discharge_Summary' }
  }
  return { type: 'sidecar.generate_docx', templateId: 'case_summary', outputName: 'Case_Summary' }
}

/**
 * Detect pure capability questions like "Can you create a PPT?" / "你可以创建ppt文件吗？"
 * so we can answer them with instructions instead of rendering an empty file.
 */
function isCapabilityQuestion(text: string): boolean {
  const q = text.trim().toLowerCase().replace(/[?？]/g, '')
  if (!q || q.length > 45) return false
  return [
    /你可以.*创建.*ppt/,
    /你能.*做.*ppt/,
    /可以.*做.*ppt/,
    /支持.*ppt/,
    /can you create.*ppt/,
    /could you make.*ppt/,
    /can you generate.*ppt/,
    /do you support.*ppt/,
  ].some(p => p.test(q))
}

function buildHistoryBlock(history?: ChatHistoryMessage[]): string {
  if (!history || history.length === 0) return ''
  const lines = history
    .map((m) => {
      const who = m.role === 'assistant' ? 'Assistant' : 'User'
      return `${who}: ${m.content}`
    })
    .join('\n')
  return `\n\nConversation history (earlier messages in this chat; use them as context for the request):\n${lines}`
}

async function buildPayload(
  text: string,
  patient: SidecarHandlerOptions['patient'],
  history: SidecarHandlerOptions['history'],
  telemetryContext?: LlmTelemetryContext,
): Promise<Record<string, unknown>> {
  const { type, templateId, outputName } = detectJobType(text)

  const patientBlock = patient
    ? `Patient context:\n- Initials: ${patient.initials || 'N/A'}\n- Age: ${patient.age || 'N/A'}\n- Sex: ${patient.sex || 'N/A'}\n- Diagnosis: ${patient.diagnosis || 'N/A'}\n- Chief Complaint: ${patient.chiefComplaint || 'N/A'}`
    : 'No specific patient context.'

  const historyBlock = buildHistoryBlock(history)

  const prompt = type === 'sidecar.generate_pptx'
    ? `${patientBlock}${historyBlock}\n\nUser request: "${text}"\n\nCreate a PowerPoint presentation. Return ONLY a JSON object with these keys:
- title: presentation title
- subtitle: subtitle or conference/institution
- presenter: presenter name or institution
- date: date string
- slides: an array of 5-12 slides, each with { title, content }. Content should be concise, bullet-style text suitable for a clinical or academic presentation.

Base the presentation content on the conversation history and patient context above when available; if the request does not provide enough detail, fill in clinically plausible placeholder content.

JSON object:`
    : `${patientBlock}${historyBlock}\n\nUser request: "${text}"\n\nWe need to render a medical document using the "${templateId}" template. Return ONLY a JSON object with keys that match the template placeholders. Common placeholders include: patient_initials, age, sex, diagnosis, findings_html, treatment_plan, generated_at. Use the current date for generated_at. Use the conversation history and patient context above when available; if the request does not provide enough detail, use concise clinically plausible placeholders.\n\nJSON object:`

  let data: Record<string, unknown> = {}
  try {
    const apiKey = getApiKey()
    const raw = await deepseekChat(
      [{ role: 'user', content: prompt }],
      apiKey,
      {
        model: 'deepseek-chat',
        maxTokens: 2048,
        telemetryContext,
      },
    )
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) {
      data = JSON.parse(match[0])
    }
  } catch {
    // Fallback to minimal structured data
  }

  // Ensure minimum required fields exist
  data.patient_initials = data.patient_initials || patient?.initials || 'PT'
  data.age = data.age ?? patient?.age ?? 0
  data.sex = data.sex || patient?.sex || '-'
  data.diagnosis = data.diagnosis || patient?.diagnosis || '-'
  data.findings_html = data.findings_html || '-'
  data.treatment_plan = data.treatment_plan || '-'
  data.generated_at = data.generated_at || new Date().toISOString().slice(0, 10)

  if (type === 'sidecar.render_plot') {
    return {
      plot_type: data.plot_type || 'bar',
      title: data.title || 'Plot',
      x_label: data.x_label || 'X',
      y_label: data.y_label || 'Y',
      series: data.series || [{ x: [1, 2, 3], y: [1, 2, 1], label: 'Series 1' }],
      output_name: outputName,
    }
  }

  if (type === 'sidecar.render_table') {
    return {
      title: data.title || 'Table 1',
      headers: data.headers || ['Variable', 'Value'],
      rows: data.rows || [],
      output_name: outputName,
    }
  }

  return {
    template_id: templateId,
    output_name: outputName,
    data,
  }
}

async function pollJob(jobId: string, maxWaitMs = 30000, intervalMs = 1000): Promise<ExecutionJobStatus | null> {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    const status = await service.getStatus(jobId)
    if (status && (status.status === 'completed' || status.status === 'failed')) {
      return status
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return service.getStatus(jobId)
}

export interface SidecarFileInfo {
  fileId: string
  fileName: string
  mimeType: string
  downloadUrl: string
  expiresIn: number
  knowledgePayload?: {
    title: string
    content: string
  }
}

function buildKnowledgePayload(
  type: string,
  data: Record<string, unknown>,
  outputName: string,
): { title: string; content: string } | undefined {
  if (type === 'sidecar.generate_pptx') {
    const slides = Array.isArray(data.slides) ? data.slides : []
    const title = String(data.title || outputName)
    const content = slides
      .map((s: any) => `## ${s.title || ''}\n${s.content || ''}`)
      .join('\n\n')
    return { title, content: content || String(data.subtitle || '-') }
  }

  if (type === 'sidecar.generate_docx') {
    const title = String(data.title || outputName)
    const parts: string[] = []
    if (data.patient_initials) parts.push(`Patient: ${data.patient_initials}`)
    if (data.diagnosis) parts.push(`Diagnosis: ${data.diagnosis}`)
    if (data.findings_html) parts.push(`Findings: ${data.findings_html}`)
    if (data.treatment_plan) parts.push(`Plan: ${data.treatment_plan}`)
    const content = parts.join('\n\n') || String(data.content || '-')
    return { title, content }
  }

  if (type === 'sidecar.render_table') {
    const title = String(data.title || outputName)
    const headers = Array.isArray(data.headers) ? data.headers : []
    const rows = Array.isArray(data.rows) ? data.rows : []
    const content = [
      title,
      '',
      headers.join(' | '),
      rows.map((r: any) => (Array.isArray(r) ? r.join(' | ') : String(r))).join('\n'),
    ].join('\n')
    return { title, content }
  }

  return undefined
}

export async function handleSidecarRequest(options: SidecarHandlerOptions): Promise<{
  text: string
  job?: ExecutionJobStatus
  file?: SidecarFileInfo
}> {
  if (!process.env.EXECUTION_PLANE_URL || !process.env.WORKER_API_TOKEN) {
    return {
      text: 'Sidecar rendering is not configured on this instance. Please set EXECUTION_PLANE_URL and WORKER_API_TOKEN.',
    }
  }

  if (isCapabilityQuestion(options.text)) {
    return {
      text: '可以。请告诉我主题、患者或大致内容，我就可以用 Sidecar 渲染生成可下载的 .pptx 文件。',
    }
  }

  const payload = await buildPayload(options.text, options.patient, options.history, options.telemetryContext)
  const { type } = detectJobType(options.text)

  const job = await service.enqueue({
    type,
    payload,
    tenant: { userId: options.userId, workspaceId: options.workspaceId || options.userId },
  })

  const final = await pollJob(job.job_id)
  if (!final || final.status !== 'completed') {
    return {
      text: `Sidecar job ${job.job_id} is ${final?.status || 'still pending'}. You can check status at /api/v1/execution/jobs/${job.job_id}.`,
      job: final || job,
    }
  }

  const result = final.result || {}
  const fileId = result.file_id as string | undefined
  const fileName = (result.file_name as string) || 'output'

  if (!fileId) {
    return { text: 'Sidecar job completed but did not return a file_id.', job: final }
  }

  const download = await service.getDownloadUrl(fileId)
  if (!download) {
    return {
      text: `Rendered file "${fileName}" (job ${job.job_id}) is ready, but a download URL could not be generated.`,
      job: final,
    }
  }

  return {
    text: `Rendered "${fileName}".`,
    job: final,
    file: {
      fileId,
      fileName,
      mimeType: download.mime_type,
      downloadUrl: download.download_url,
      expiresIn: download.expires_in,
    },
  }
}
