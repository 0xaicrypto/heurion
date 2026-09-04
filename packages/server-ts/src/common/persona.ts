import type { FactsStore, KnowledgeStore } from '../evolution/stores'
import { CONTEXT_CONFIG } from './context-config.js' // #637 集中配置
import { GraphFactProvider } from '../memory/fact-provider.js'

/**
 * #840 读路径第二批:persona 切 graph — 渲染来源与存储解耦。
 * graph 提供时 facts/summaries 从单一事实源取(GraphFactProvider,与
 * keyword/layer3 路同口径);缺省回落 legacy 投影(缓存版本信号沿用)。
 */
export interface PersonaSource {
  facts: Array<{ content: string; category: string; importance: number; patientHash?: string | null; studyId?: string | null }>
  summaries: Array<{ title: string; content?: string; status?: string }>
}

/** graph 最小形状 — 避免 common 层引入完整 MemoryGraph 类型。 */
interface GraphLike {
  getCurrentNodesByType(type: string): Array<Record<string, any>>
}

export function graphPersonaSource(memory: { graph: GraphLike }): PersonaSource {
  const facts = new GraphFactProvider(memory.graph as any).listCurrent().map((f) => ({
    content: f.content, category: f.category, importance: f.importance,
    patientHash: f.patientHash, studyId: f.studyId,
  }))
  const summaries = (memory.graph.getCurrentNodesByType('summary') as Array<Record<string, any>>)
    .filter((n) => n.status === 'current')
    .map((n) => ({ title: String(n.title || ''), content: String(n.content || '') }))
  return { facts, summaries }
}

/**
 * §5.4 (#197): single persona builder shared by user-context and the
 * memory gateway. §13.3A: the global persona must never contain
 * patient-scoped facts.
 * #627: persona 不再包含 top-facts — 事实由 projection layer3 承担
 * (importance×recency 排序),身份级信息(preference/goal)与知识库标题
 * 保留,避免同一事实在 persona 与 layer3 重复注入。
 */

/**
 * #510: chat entry scenes. The scene selects the persona variant and the
 * tool surface — a general/chart/document request must not inherit the
 * patient-centric persona that made the model keep searching patient
 * records even for "explain this image" requests.
 */
export type ChatScene = 'general' | 'patient' | 'document' | 'chart'

/** Scene-specific guidance prepended to the shared base persona. */
const SCENE_GUIDANCE: Record<ChatScene, string> = {
  patient: '',
  general: `Handle the user's request as a standalone task. Do NOT search patient records and do NOT assume the request involves a patient, a study, or the knowledge base unless the user explicitly mentions one.`,
  document: `You are helping the user edit a document. Focus on the content in ## Current Document. Do NOT search patient records unless the user explicitly asks. When the user asks for a table, a chart, or a file export (Word/PPT/PDF), do NOT just describe it and do NOT paste raw markdown — call the insert_asset tool (table/plot/export); export renders the CURRENT DRAFT, so if the draft body is empty but reference materials exist, import them first (edit_document import_reference) and then export. Generation requests are handled by these tools directly — no other file pipeline exists in this session.`,
  chart: `You are generating charts, figures, and statistical analyses. When the real data is missing, say so explicitly and ask for it — never fabricate data or present placeholder values as results. Do NOT search patient records unless the user explicitly asks.`,
}

export function buildScenePersona(
  scene: ChatScene,
  facts: FactsStore,
  knowledge: KnowledgeStore,
  /** #840: 提供时从 graph 渲染(单一事实源);缺省回落 legacy 投影。 */
  memory?: { graph: GraphLike },
): string {
  const base = buildPersona(facts, knowledge, memory)
  const guidance = SCENE_GUIDANCE[scene]
  return guidance ? `${guidance}\n\n${base}` : base
}

export function buildPersona(
  facts: FactsStore,
  knowledge: KnowledgeStore,
  memory?: { graph: GraphLike },
): string {
  const source: PersonaSource = memory?.graph
    ? graphPersonaSource(memory)
    : {
        facts: facts.all().map((f) => ({ content: f.content, category: f.category, importance: f.importance, patientHash: f.patientHash, studyId: f.studyId })),
        summaries: knowledge.all().map((k) => ({ title: k.title, content: k.content, status: k.status })),
      }
  const allFacts = source.facts.filter(f => !f.patientHash && !f.studyId)
  const prefs = allFacts.filter(f => f.category === 'preference').sort((a, b) => b.importance - a.importance)
  // #814: constraint 与 preference/goal 同属身份级信息(天生无上下文),
  // 直接进 persona — 此前漏网落入 layer3 碎片。
  const constraints = allFacts.filter(f => f.category === 'constraint').sort((a, b) => b.importance - a.importance)
  const goals = allFacts.filter(f => f.category === 'goal').slice(0, CONTEXT_CONFIG.persona.goalsMax)
  const knowledgeSummaries = source.summaries.filter(k => (k.status ?? 'current') === 'current').slice(0, CONTEXT_CONFIG.persona.knowledgeTitlesMax)

  // #837-identity: 定位不限定肿瘤 — 面向医生与临床研究者的通用临床 AI 助手。
  const parts: string[] = [
    'You are Heurion, a clinical AI assistant for doctors and clinical researchers. You are not limited to any single specialty (e.g. oncology) — cover the full breadth of clinical medicine and clinical research.',
    'Be concise, evidence-based, and reference relevant patient data and accumulated knowledge.',
    'Only reference patients that appear in the Patient Roster above.',
    'Do not invent or hallucinate patient names, diagnoses, or clinical details.',
    'When stating a diagnosis, use only the exact terminology present in the patient profile or source documents. Do not infer or upgrade to a more specific diagnosis (for example, do not say "lung adenocarcinoma" if the profile only indicates NSCLC or a suspicious nodule).',
  ]

  if (prefs.length > 0) {
    parts.push('\nYour accumulated preferences:')
    for (const p of prefs.slice(0, CONTEXT_CONFIG.persona.prefsMax)) {
      parts.push(`- ${p.content} (importance: ${p.importance}/5)`)
    }
  }

  if (constraints.length > 0) {
    parts.push('\nActive constraints (must respect):')
    for (const c of constraints.slice(0, CONTEXT_CONFIG.persona.constraintsMax)) {
      parts.push(`- ${c.content}`)
    }
  }

  if (goals.length > 0) {
    parts.push('\nActive goals:')
    for (const g of goals) parts.push(`- ${g.content}`)
  }

  if (knowledgeSummaries.length > 0) {
    parts.push('\nYour knowledge base includes:')
    for (const k of knowledgeSummaries) parts.push(`- ${k.title}`)
  }

  return parts.join('\n')
}
