import { generateText, tool } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'

const openai = createOpenAI({
  apiKey: process.env.KEY,
  baseURL: 'https://opencode.ai/zen/go/v1',
})

const models = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'minimax-m3',
  'kimi-k3',
]

for (const m of models) {
  try {
    const result = await generateText({
      model: openai.chat(m),
      tools: {
        ping: tool({
          description: 'Execute CDP commands against a live browser session using JavaScript code.\n\nAvailable in your code:\n\ndeclare const cdp: {\n  send(method: string, params?: unknown, options?: {\n    timeoutMs?: number;\n    sessionId?: string;\n  }): Promise<unknown>;\n  attachToTarget(targetId: string, options?: {\n    timeoutMs?: number;\n  }): Promise<string>;\n  getDebugLog(limit?: number): Promise<unknown[]>;\n  clearDebugLog(): Promise<void>;\n};\n\nWrite an async arrow function in JavaScript. Do NOT use TypeScript syntax.\n\nFor page-scoped commands such as Page.*, Runtime.*, and DOM.*, first create or select a target, call cdp.attachToTarget(targetId), and pass the returned sessionId in command options.\n\nExample:\nasync () => {\n  return await cdp.send("Browser.getVersion");\n}\n\nPage example:\nasync () => {\n  const { targetId } = await cdp.send("Target.createTarget", {\n    url: "about:blank"\n  });\n  const sessionId = await cdp.attachToTarget(targetId);\n  await cdp.send("Page.enable", {}, { sessionId });\n  await cdp.send(\n    "Page.navigate",\n    { url: "https://example.com" },\n    { sessionId }\n  );\n  const { result } = await cdp.send(\n    "Runtime.evaluate",\n    { expression: "document.title" },\n    { sessionId }\n  );\n  return result.value;\n}',
          parameters: z.object({ code: z.string() }),
        }),
      },
      system: 'You are a browser agent. Perform the task using tools.',
      prompt: 'Call the ping tool and report the result.',
      maxOutputTokens: 400,
    })
    const steps = result.steps ?? []
    const called = steps.some((s) => JSON.stringify(s.content ?? []).includes('tool-call'))
    console.log(`${m}: toolCall=${called} steps=${steps.length} text=${(result.text || '').slice(0, 60)}`)
  } catch (e) {
    console.log(`${m}: ERROR ${String(e).slice(0, 120)}`)
  }
}
