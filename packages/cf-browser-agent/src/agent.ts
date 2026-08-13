/**
 * #485 — browser-task execution: Cloudflare Agent Browser via the agents
 * SDK. `createBrowserTools` lets the LLM drive a live Chromium session
 * (navigate, click, type, screenshot, evaluate) through CDP.
 *
 * The LLM model is OpenAI-compatible (env LLM_API_KEY/LLM_BASE_URL/LLM_MODEL)
 * so no separate Workers AI binding is required to run the POC.
 */
import { createBrowserTools } from 'agents/browser/ai'
import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'

export interface BrowserTaskInput {
  instruction: string
  url?: string
}

export interface BrowserTaskResult {
  conclusion: string
  dom_summary: string
  steps: string[]
  screenshot_url: string
}

export interface BrowserTaskDeps {
  browser: unknown
  llm: unknown
}

export async function runBrowserTask(
  input: BrowserTaskInput,
  deps: BrowserTaskDeps,
): Promise<BrowserTaskResult> {
  const tools = createBrowserTools({
    browser: deps.browser as any,
    // #485-followup: Worker Loaders(Dynamic Workers)需付费计划,loader 暂
    // 不可用 — CDP 会话可建立,但 agents 的代码执行层受限(已知限制)。
    loader: undefined as any,
  })

  const system = `You are a browser automation agent. You MUST use the provided tools to drive a real
browser via CDP. Do not just describe a plan.

Use browser_execute to run CDP code (navigate, evaluate document.title, etc.) against the live
browser. Use browser_search to look up CDP commands when unsure. Always actually perform the task
with tool calls and base your summary on real results. Keep the conclusion concise and factual.`

  const prompt = input.url
    ? `Start at ${input.url}.\n\nTask: ${input.instruction}`
    : `Task: ${input.instruction}`

  const result = await generateText({
    model: deps.llm as any,
    tools,
    system,
    prompt,
  })

  return {
    conclusion: result.text || '任务完成',
    dom_summary: '',
    steps: [],
    screenshot_url: '',
  }
}

/** Build the LLM model from env (OpenAI-compatible). */
export function buildLlm(env: Record<string, unknown>): unknown {
  const apiKey = String(env.LLM_API_KEY || '')
  const baseUrl = String(env.LLM_BASE_URL || 'https://api.openai.com/v1')
  const model = String(env.LLM_MODEL || 'gpt-4o-mini')
  const provider = createOpenAI({ apiKey, baseURL: baseUrl })
  return provider.chat(model)
}
