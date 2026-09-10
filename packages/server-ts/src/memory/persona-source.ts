/**
 * #939 — persona graph 渲染源：从 common/persona.ts 下移到 memory 层
 * （分层 #672：common 零依赖 memory）。graph → PersonaSource 投影在
 * 本层完成，common 层只消费已渲染的 PersonaSource（纯数据），断开
 * common/persona → memory/fact-provider → common/fact-render 循环。
 */
import type { PersonaSource } from '../common/persona.js'
import type { MemoryGraph } from './memory.graph.js'
import { GraphFactProvider } from './fact-provider.js'

export function graphPersonaSource(memory: { graph: MemoryGraph }): PersonaSource {
  const facts = new GraphFactProvider(memory.graph).listCurrent().map((f) => ({
    content: f.content, category: f.category, importance: f.importance,
    patientHash: f.patientHash, studyId: f.studyId,
  }))
  const summaries = (memory.graph.getCurrentNodesByType('summary') as Array<{ status?: string; title?: string; content?: string }>)
    .filter((n) => n.status === 'current')
    .map((n) => ({ title: String(n.title || ''), content: String(n.content || '') }))
  return { facts, summaries }
}
