/**
 * #485 — Cloudflare Worker: heurion browser-task execution endpoint.
 * POST /browser-task → Agent Browser run; x-worker-token auth.
 */
import { runBrowserTask, buildLlm, type BrowserTaskInput } from './agent.js'

export interface Env {
  WRB_TASK_TOKEN: string
  LLM_API_KEY?: string
  LLM_BASE_URL?: string
  LLM_MODEL?: string
  BROWSER: unknown
  LOADER: unknown
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/healthz') {
      return new Response('ok', { status: 200 })
    }

    if (url.pathname !== '/browser-task' || request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    }

    // #485: bearer-style worker token.
    const token = request.headers.get('x-worker-token') || ''
    if (!env.WRB_TASK_TOKEN || token !== env.WRB_TASK_TOKEN) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
    }

    let body: BrowserTaskInput
    try {
      body = await request.json() as BrowserTaskInput
    } catch {
      return new Response(JSON.stringify({ error: 'invalid JSON' }), { status: 400, headers: { 'content-type': 'application/json' } })
    }
    if (!body.instruction || !String(body.instruction).trim()) {
      return new Response(JSON.stringify({ error: 'instruction is required' }), { status: 400, headers: { 'content-type': 'application/json' } })
    }

    try {
      const llm = buildLlm({ ...env })
      const result = await runBrowserTask(
        { instruction: body.instruction.trim(), url: body.url },
        { browser: env.BROWSER, loader: env.LOADER, llm },
      )
      return new Response(JSON.stringify({ success: true, ...result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    } catch (err) {
      return new Response(
        JSON.stringify({ success: false, error: (err as Error).message.slice(0, 300) }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      )
    }
  },
}
