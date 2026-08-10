import { generateText, tool } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'

const openai = createOpenAI({
  apiKey: process.env.KEY,
  baseURL: 'https://opencode.ai/zen/go/v1',
})
const model = openai.chat('deepseek-v4-flash')

const result = await generateText({
  model,
  tools: {
    ping: tool({ description: 'test tool', parameters: z.object({}) }),
  },
  system: 'You are a browser agent. Perform the task using tools.',
  prompt: 'Call the ping tool and report the result.',
})

console.log('text:', (result.text || '').slice(0, 200))
console.log('steps:', JSON.stringify(result.steps ?? []).slice(0, 200))
console.log('requestBody:', JSON.stringify(result.requestBody ?? {}).slice(0, 800))
