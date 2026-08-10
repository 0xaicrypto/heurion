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
  'glm-5.2',
  'gpt-5.6-luna',
  'grok-4.5',
]

for (const m of models) {
  try {
    const result = await generateText({
      model: openai.chat(m),
      tools: {
        ping: tool({ description: 'test tool', parameters: z.object({}) }),
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
