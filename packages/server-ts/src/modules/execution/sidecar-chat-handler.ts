import { deepseekChat, getApiKey } from '../../common/llm.js'
import { createExecutionPlaneService, type ExecutionJobStatus } from './execution-plane.service.js'

const service = createExecutionPlaneService()

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

async function buildPayload(
  text: string,
  patient: SidecarHandlerOptions['patient'],
): Promise<Record<string, unknown>> {
  const { type, templateId, outputName } = detectJobType(text)

  const patientBlock = patient
    ? `Patient context:\n- Initials: ${patient.initials || 'N/A'}\n- Age: ${patient.age || 'N/A'}\n- Sex: ${patient.sex || 'N/A'}\n- Diagnosis: ${patient.diagnosis || 'N/A'}\n- Chief Complaint: ${patient.chiefComplaint || 'N/A'}`
    : 'No specific patient context.'

  const prompt = `${patientBlock}\n\nUser request: "${text}"\n\nWe need to render a medical document using the "${templateId}" template. Return ONLY a JSON object with keys that match the template placeholders. Common placeholders include: patient_initials, age, sex, diagnosis, findings_html, treatment_plan, generated_at. Use the current date for generated_at. If the request does not provide enough detail, use concise clinically plausible placeholders.\n\nJSON object:`

  let data: Record<string, unknown> = {}
  try {
    const apiKey = getApiKey()
    const raw = await deepseekChat([{ role: 'user', content: prompt }], apiKey)
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

export async function handleSidecarRequest(options: SidecarHandlerOptions): Promise<{
  text: string
  job?: ExecutionJobStatus
}> {
  if (!process.env.EXECUTION_PLANE_URL || !process.env.WORKER_API_TOKEN) {
    return {
      text: 'Sidecar rendering is not configured on this instance. Please set EXECUTION_PLANE_URL and WORKER_API_TOKEN.',
    }
  }

  const payload = await buildPayload(options.text, options.patient)
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
    text: `Rendered "${fileName}". Download (expires in ${download.expires_in}s): ${download.download_url}`,
    job: final,
  }
}
