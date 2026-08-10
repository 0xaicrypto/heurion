/**
 * #486 — browser_task: Cloudflare Agent Browser via the heurion/browser-agent
 * plugin. Simulates a real user performing a task in a browser (login,
 * navigate, click, verify) by calling the plugin's configured Worker
 * endpoint (#485). Plugin-gated — unavailable unless installed.
 */
import { BaseTool, ToolResult } from './base-tool.js'

interface BrowserTaskArgs {
  instruction: string
  url?: string
}

interface WorkerResponse {
  success?: boolean
  conclusion?: string
  dom_summary?: string
  screenshot_url?: string
  steps?: string[]
  error?: string
}

export class BrowserTaskTool extends BaseTool {
  constructor(private ctx: { userId: string }) { super() }

  get name(): string { return 'browser_task' }
  get description(): string {
    return 'Simulate a real user performing a task in a browser (login, navigate, click, type, verify) via Cloudflare Agent Browser. Pass a clear natural-language instruction, e.g. "log in to https://heurion.org, open the patient chat and ask for an EGFR pathway diagram, then confirm an image appears". Returns the conclusion, a DOM summary, steps performed and a screenshot.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'What the browser agent should do, in natural language' },
        url: { type: 'string', description: 'Optional starting URL' },
      },
      required: ['instruction'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const input = args as unknown as BrowserTaskArgs
    if (!input.instruction || !String(input.instruction).trim()) {
      return { success: false, error: 'instruction is required' }
    }

    // #486-followup: worker endpoint + token + approval mode come from the
    // plugin's settings (token stored encrypted). Default approval = allow.
    let workerUrl = ''
    let workerToken = ''
    let approvalMode = 'allow'
    try {
      const { getPluginConfig } = await import('../modules/plugins/plugin-installation.service.js')
      const config = await getPluginConfig(this.ctx.userId, 'heurion/browser-agent')
      workerUrl = String(config.worker_url || '').replace(/\/$/, '')
      workerToken = String(config.worker_token || '')
      if (config.approval_mode === 'ask' || config.approval_mode === 'deny') {
        approvalMode = config.approval_mode
      }
    } catch {
      // config read failure — report below
    }

    // #486-followup: ask mode — surface the request for user approval
    // (cost + privacy guard); deny mode — disabled.
    if (approvalMode === 'deny') {
      return { success: false, error: 'browser-agent 已被禁用（approval_mode=deny）。请到插件设置中修改。' }
    }
    if (approvalMode === 'ask') {
      return {
        success: true,
        output: JSON.stringify({
          approval_required: true,
          message: `需要打开浏览器执行：${input.instruction.slice(0, 200)}。请询问用户是否同意（浏览器会话按用量计费）。同意后重试本任务。`,
        }, null, 2),
      }
    }

    if (!workerUrl) {
      return { success: false, error: 'browser-agent 未配置：请在插件设置中填写 Worker 地址（worker_url）。' }
    }

    try {
      const res = await fetch(`${workerUrl}/browser-task`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(workerToken ? { 'x-worker-token': workerToken } : {}),
        },
        body: JSON.stringify({
          instruction: input.instruction.trim(),
          ...(input.url ? { url: input.url } : {}),
        }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { success: false, error: `browser-task worker HTTP ${res.status}: ${text.slice(0, 200)}` }
      }
      const data = (await res.json()) as WorkerResponse
      if (data.success === false || data.error) {
        return { success: false, error: data.error || 'browser-task failed' }
      }
      return {
        success: true,
        output: JSON.stringify({
          conclusion: data.conclusion || '',
          dom_summary: data.dom_summary || '',
          steps: data.steps || [],
          screenshot_url: data.screenshot_url || '',
        }, null, 2),
      }
    } catch (err) {
      return { success: false, error: `browser-task failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}
