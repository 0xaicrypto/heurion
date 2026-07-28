import { createExecutionPlaneService, type ExecutionJobStatus } from '../execution/execution-plane.service.js'
import { buildPayload, matchIntent, type PayloadBuildInput } from './plugin-capability.service.js'

const executionService = createExecutionPlaneService()

export interface PluginChatHandlerOptions {
  userId: string
  workspaceId?: string
  text: string
  patient?: PayloadBuildInput['patient']
  telemetryContext?: { userId: string; workspaceId?: string; action: string }
  send: (event: Record<string, unknown>) => void
}

export interface PluginChatResult {
  text: string
  job?: ExecutionJobStatus
  file?: {
    fileId: string
    fileName: string
    mimeType: string
    downloadUrl: string
    expiresIn: number
  }
}

async function pollJob(jobId: string, send: (event: Record<string, unknown>) => void, maxWaitMs = 30000, intervalMs = 1000): Promise<ExecutionJobStatus | null> {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    const status = await executionService.getStatus(jobId)
    if (status && status.status !== 'pending' && status.status !== 'running') {
      send({ type: 'job_status', job_id: jobId, status: status.status })
      return status
    }
    if (status) {
      send({ type: 'job_status', job_id: jobId, status: status.status })
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return executionService.getStatus(jobId)
}

export async function handlePluginChatRequest(options: PluginChatHandlerOptions): Promise<PluginChatResult> {
  const { userId, text, patient, send } = options
  const workspaceId = options.workspaceId || userId
  const telemetryContext = options.telemetryContext
    ? { ...options.telemetryContext, workspaceId: options.telemetryContext.workspaceId || workspaceId }
    : undefined

  send({ type: 'thought', text: '检测到可能的报告生成请求…' })

  const match = await matchIntent(userId, text)
  if (!match) {
    send({ type: 'thought', text: '没有匹配到已安装的报告生成插件。' })
    return { text: '我没有找到适合处理这个请求的插件。请先在插件市场安装需要的插件。' }
  }

  send({ type: 'plugin_selected', plugin_id: match.pluginId, tool: match.toolName, intent: match.intent, confidence: match.confidence })

  send({ type: 'payload_building', plugin_id: match.pluginId, tool: match.toolName })
  const payload = await buildPayload(match.pluginId, match.toolName, {
    text,
    patient,
    telemetryContext,
  })

  const jobType = `sidecar.${match.pluginId}.${match.toolName}`
  send({ type: 'job_enqueued', plugin_id: match.pluginId, tool: match.toolName, job_type: jobType })

  const job = await executionService.enqueue({
    type: jobType,
    payload,
    tenant: { userId, workspaceId: workspaceId || userId },
  })

  send({ type: 'job_status', job_id: job.job_id, status: job.status })

  const final = await pollJob(job.job_id, send)
  if (!final || final.status !== 'completed') {
    return {
      text: `插件任务 ${job.job_id} 当前状态：${final?.status || 'pending'}。你可以稍后通过任务 ID 查询状态。`,
      job: final || job,
    }
  }

  const result = final.result || {}
  const fileId = result.file_id as string | undefined
  const fileName = (result.file_name as string) || 'output'

  if (!fileId) {
    return { text: '插件任务已完成，但没有返回文件。', job: final }
  }

  const download = await executionService.getDownloadUrl(fileId)
  if (!download) {
    return {
      text: `文件 "${fileName}"（任务 ${job.job_id}）已生成，但无法生成下载链接。`,
      job: final,
    }
  }

  send({ type: 'file_ready', file_id: fileId, file_name: fileName, mime_type: download.mime_type })

  return {
    text: `已生成 "${fileName}"。`,
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
