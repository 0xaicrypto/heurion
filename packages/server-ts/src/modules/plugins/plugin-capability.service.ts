import { deepseekChat, getApiKey as getLlmApiKey, type LlmTelemetryContext , DEEPSEEK_CHAT_MODEL } from '../../common/llm.js'
import { listInstalledPlugins } from './plugin-installation.service.js'
import { getCatalogById, type PluginManifest, type PluginTool } from './plugin-catalog.service.js'
import { SCHEMA_VERSION, validateRenderContent, type RenderContent } from '@heurion/contracts'
import { DISCUSSION_MARKERS, STRONG_GENERATE_VERBS } from '../../retrieval/query-router.js'

export interface PluginMatch {
  pluginId: string
  toolName: string
  intent: string
  confidence: number
}

export interface PayloadBuildInput {
  text: string
  patient?: {
    initials?: string | null
    age?: number | null
    sex?: string | null
    diagnosis?: string | null
    chiefComplaint?: string | null
  } | null
  /** Prior conversation messages in this session, injected as context. */
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  telemetryContext?: LlmTelemetryContext
}

export async function getActivePlugins(userId: string): Promise<PluginManifest[]> {
  const installed = await listInstalledPlugins(userId)
  const activeIds = installed.filter((i) => i.enabled).map((i) => i.pluginId)
  const manifests: PluginManifest[] = []
  for (const id of activeIds) {
    const manifest = await getCatalogById(id)
    if (manifest) manifests.push(manifest)
  }
  return manifests
}

/**
 * #549 — short, noisy trigger words ("ppt", "表格", "chart"…) fire only when
 * a strong generate verb is present; discussion sentences never match.
 */
const NOISY_SHORT_PATTERNS = new Set([
  'ppt', 'pptx', 'pdf', 'word', 'docx', '表格', '图表', '曲线', '汇报', '图',
  'table', 'plot', 'chart', 'graph', 'presentation',
])

export async function matchIntent(userId: string, text: string): Promise<PluginMatch | null> {
  const plugins = await getActivePlugins(userId)
  let best: PluginMatch | null = null
  const q = text.toLowerCase()
  // #549: discussion/question sentences are NEVER file-generation requests.
  if (DISCUSSION_MARKERS.test(q)) return null
  const hasStrongVerb = STRONG_GENERATE_VERBS.test(q)

  for (const manifest of plugins) {
    const triggers = manifest.triggers || []
    for (const trigger of triggers) {
      for (const pattern of trigger.patterns) {
        const p = pattern.toLowerCase()
        if (!q.includes(p)) continue
        // Short noisy word without an explicit generate verb → almost always
        // talk about existing content ("这个表格的数字怎么来的"). Skip.
        if (NOISY_SHORT_PATTERNS.has(p) && !hasStrongVerb) continue
        const score = pattern.length / Math.max(q.length, 1)
        if (!best || score > best.confidence) {
          const tool = manifest.tools[0]
          if (!tool) continue
          best = {
            pluginId: manifest.plugin.id,
            toolName: tool.name,
            intent: trigger.intent,
            confidence: score,
          }
        }
      }
    }
  }

  return best
}

export async function buildPayload(
  pluginId: string,
  toolName: string,
  input: PayloadBuildInput,
): Promise<Record<string, unknown>> {
  const manifest = await getCatalogById(pluginId)
  if (!manifest) throw new Error(`plugin not found: ${pluginId}`)
  const tool = manifest.tools.find((t) => t.name === toolName)
  if (!tool) throw new Error(`tool not found: ${toolName}`)

  const apiKey = getLlmApiKey()
  if (apiKey) {
    try {
      // #451: official renderer plugins get the content-guarantee layer
      // (LLM → schema validation → one correction retry → text-derived
      // fallback), migrated from the removed sidecar-chat-handler.
      const renderType = RENDER_TOOL_TYPES[`${manifest.plugin.id}.${tool.name}`]
      if (renderType) {
        return await buildRenderPayload(renderType, tool, manifest, input, apiKey)
      }
      return await buildPayloadWithLlm(tool, manifest, input, apiKey)
    } catch {
      // fall through to fallback
    }
  }

  return fallbackPayload(tool, input)
}

/**
 * #451: renderer plugins (heurion/pptx|docx|table|plot|pdf) — the tool's
 * `data` parameter is the versioned render-content model from contracts.
 * One correction retry with the exact schema errors; if both attempts fail
 * a minimal-but-complete content model is derived from the user's request —
 * a generator must NEVER receive an empty content model.
 */
const RENDER_TOOL_TYPES: Record<string, string> = {
  'heurion/pptx.generate_pptx': 'sidecar.generate_pptx',
  'heurion/docx.generate_docx': 'sidecar.generate_docx',
  'heurion/table.render_table': 'sidecar.render_table',
  'heurion/plot.render_plot': 'sidecar.render_plot',
  'heurion/pdf.convert_to_pdf': 'sidecar.convert_to_pdf',
}

/**
 * #451-fix: worker-side template IDs. The docx plugin only ships
 * case_summary / discharge_summary templates — 'default' is rejected with
 * "Template 'default' not found". The other renderers accept 'default'.
 */
const RENDER_TEMPLATE_IDS: Record<string, string> = {
  'sidecar.generate_docx': 'case_summary',
}

async function buildRenderPayload(
  renderType: string,
  tool: PluginTool,
  manifest: PluginManifest,
  input: PayloadBuildInput,
  apiKey: string,
): Promise<Record<string, unknown>> {
  const patientBlock = input.patient
    ? `Patient context:\n- Initials: ${input.patient.initials || 'N/A'}\n- Age: ${input.patient.age || 'N/A'}\n- Sex: ${input.patient.sex || 'N/A'}\n- Diagnosis: ${input.patient.diagnosis || 'N/A'}\n- Chief Complaint: ${input.patient.chiefComplaint || 'N/A'}`
    : 'No specific patient context.'
  const historyBlock = input.history && input.history.length > 0
    ? `\n\nConversation history (earlier messages in this chat; use them as context for the request):\n${input.history.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n')}`
    : ''

  const prompt = buildRenderPrompt(renderType, patientBlock, historyBlock, input.text)

  const call = async (p: string): Promise<unknown> => {
    const raw = await deepseekChat([{ role: 'user', content: p }], apiKey, {
      model: DEEPSEEK_CHAT_MODEL,
      telemetryContext: input.telemetryContext,
    })
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    try { return JSON.parse(match[0]) } catch { return null }
  }

  // Attempt 1
  let parsed = await call(prompt).catch(() => null)
  let check = parsed === null ? { ok: false as const, errors: ['unparseable LLM output'] } : validateRenderContent(renderType, parsed)
  // Attempt 2 — correction retry with the exact schema errors.
  if (!check.ok) {
    const retry = `${prompt}\n\n你的上一次输出未通过校验，错误如下：\n${check.errors.join('\n')}\n请只输出符合要求的 JSON。`
    parsed = await call(retry).catch(() => null)
    check = parsed === null ? { ok: false as const, errors: ['unparseable retry output'] } : validateRenderContent(renderType, parsed)
  }

  const data = check.ok
    ? (check.data as RenderContent)
    : fallbackRenderContent(renderType, input.text, patientBlock, historyBlock)

  return {
    template_id: RENDER_TEMPLATE_IDS[renderType] || 'default',
    output_name: (input.text.trim().slice(0, 40) || 'Output').replace(/\s+/g, '_'),
    schema_version: SCHEMA_VERSION,
    content_type: renderType,
    data: { ...(data as Record<string, unknown>), schemaVersion: SCHEMA_VERSION },
  }
}

/** Build a non-empty, schema-valid content model from the user's request. */
function fallbackRenderContent(renderType: string, userText: string, patientBlock: string, historyBlock: string): RenderContent {
  const request = userText.trim().slice(0, 3000) || '（未提供具体内容）'
  const context = `${patientBlock}\n${historyBlock}`.trim().slice(0, 12000)
  const body = context ? `${request}\n\n${context}` : request

  switch (renderType) {
    case 'sidecar.generate_pptx':
      return {
        schemaVersion: SCHEMA_VERSION,
        title: userText.trim().slice(0, 80) || 'Presentation',
        subtitle: 'Generated from chat',
        slides: [
          { title: '概述', content: [{ type: 'paragraph', text: request }] },
          { title: '详细内容', content: [{ type: 'paragraph', text: body }] },
        ],
      }
    case 'sidecar.generate_docx':
      return {
        schemaVersion: SCHEMA_VERSION,
        title: userText.trim().slice(0, 80) || 'Document',
        sections: [
          { heading: '概述', paragraphs: [{ type: 'paragraph', text: request }] },
          { heading: '详细内容', paragraphs: [{ type: 'paragraph', text: body }] },
        ],
      }
    case 'sidecar.render_table':
      return {
        schemaVersion: SCHEMA_VERSION,
        title: userText.trim().slice(0, 80) || 'Table',
        headers: ['项目', '内容'],
        rows: [[request.slice(0, 2000)]],
      }
    case 'sidecar.render_plot':
      return {
        schemaVersion: SCHEMA_VERSION,
        type: 'bar',
        title: userText.trim().slice(0, 80) || 'Plot',
        x_label: '项目',
        y_label: '数值',
        series: [{ label: '数据', x: [1], y: [1] }],
      }
    case 'sidecar.convert_to_pdf':
      return {
        schemaVersion: SCHEMA_VERSION,
        title: userText.trim().slice(0, 80) || 'Document',
        sections: [{ heading: '内容', paragraphs: [{ type: 'paragraph', text: body }] }],
      }
    default:
      return {
        schemaVersion: SCHEMA_VERSION,
        title: 'Document',
        sections: [{ heading: '内容', paragraphs: [{ type: 'paragraph', text: body }] }],
      } as RenderContent
  }
}

function buildRenderPrompt(renderType: string, patientBlock: string, historyBlock: string, text: string): string {
  const base = `${patientBlock}${historyBlock}\n\nUser request: "${text}"`
  switch (renderType) {
    case 'sidecar.generate_pptx':
      return `${base}\n\nCreate a PowerPoint presentation. Return ONLY a JSON object with these keys:
- title: presentation title
- subtitle: subtitle or conference/institution
- presenter: presenter name or institution
- date: date string
- slides: an array of 5-12 slides, each with { title, content }. Content should be concise, bullet-style text suitable for a clinical or academic presentation.

Base the presentation content on the conversation history and patient context above when available; if the request does not provide enough detail, fill in clinically plausible placeholder content.

JSON object:`
    case 'sidecar.render_table':
      return `${base}\n\nRender a medical table. Return ONLY a JSON object with these keys:
- title: table title
- headers: array of column header strings
- rows: array of rows, each an array of cell strings

Base the table content on the conversation history and patient context above when available; if the request does not provide enough detail, use clinically plausible placeholder values.

JSON object:`
    case 'sidecar.render_plot':
      return `${base}\n\nRender a statistical plot. Return ONLY a JSON object with these keys:
- plot_type: "bar", "line" or "pie"
- title: plot title
- x_label: x-axis label
- y_label: y-axis label
- series: array of { x: number[], y: number[], label: string }

Base the plot data on the conversation history and patient context above when available; if the request does not provide enough detail, use clinically plausible placeholder data.

JSON object:`
    default:
      return `${base}\n\nWe need to render a medical document using a document template. Return ONLY a JSON object with these keys:
- title: document title
- sections: array of { heading: string, paragraphs: string[] } — e.g. Patient, Diagnosis, Findings, Treatment Plan

Base the document content on the conversation history and patient context above when available; if the request does not provide enough detail, use concise clinically plausible placeholders.

JSON object:`
  }
}

/**
 * Content-shape hints for official renderer tools whose `data` parameter is an
 * open object. The worker renders these shapes, so guide the LLM accordingly.
 */
const DATA_SHAPE_HINTS: Record<string, string> = {
  'heurion/pptx.generate_pptx':
    'The "data" object must contain: { title: string, subtitle: string, presenter: string, date: string, slides: [{ title: string, content: string }] } where each slide content is concise bullet-style text.',
  'heurion/docx.generate_docx':
    'The "data" object must contain: { title: string, sections: [{ heading: string, paragraphs: string[] }] }.',
}

async function buildPayloadWithLlm(
  tool: PluginTool,
  manifest: PluginManifest,
  input: PayloadBuildInput,
  apiKey: string,
): Promise<Record<string, unknown>> {
  const patientBlock = input.patient
    ? `Patient context:\n- Initials: ${input.patient.initials || 'N/A'}\n- Age: ${input.patient.age || 'N/A'}\n- Sex: ${input.patient.sex || 'N/A'}\n- Diagnosis: ${input.patient.diagnosis || 'N/A'}\n- Chief Complaint: ${input.patient.chiefComplaint || 'N/A'}`
    : 'No specific patient context.'

  const schemaJson = JSON.stringify(tool.parameters, null, 2)
  const historyBlock = input.history && input.history.length > 0
    ? `\n\nConversation history (earlier messages in this chat; use them as context for the request):\n${input.history.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n')}`
    : ''
  const shapeHint = DATA_SHAPE_HINTS[`${manifest.plugin.id}.${tool.name}`] || ''
  const prompt = `${patientBlock}${historyBlock}\n\nUser request: "${input.text}"\n\nYou are preparing arguments for the "${manifest.plugin.name}" plugin tool "${tool.name}".\nReturn ONLY a JSON object that conforms to this schema:\n${schemaJson}${shapeHint ? `\n\n${shapeHint}` : ''}\n\nBase the arguments on the conversation history and patient context above when available; if the request does not provide enough detail, use clinically plausible placeholders. Do not include markdown or explanation.\n\nJSON object:`

  const raw = await deepseekChat([{ role: 'user', content: prompt }], apiKey, {
    model: DEEPSEEK_CHAT_MODEL,
    maxTokens: 2048,
    telemetryContext: input.telemetryContext,
  })

  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('no JSON object in LLM response')
  return JSON.parse(match[0]) as Record<string, unknown>
}

function fallbackPayload(tool: PluginTool, input: PayloadBuildInput): Record<string, unknown> {
  const params = tool.parameters as { properties?: Record<string, unknown>; required?: string[] }
  const payload: Record<string, unknown> = {}
  const patient = input.patient || {}

  for (const [key, prop] of Object.entries(params.properties || {})) {
    const p = prop as { type?: string; default?: unknown }
    if (p.default !== undefined) {
      payload[key] = p.default
      continue
    }
    switch (key) {
      case 'template_id':
        payload[key] = 'case_summary'
        break
      case 'output_name':
        payload[key] = 'Output'
        break
      case 'data':
        payload[key] = {
          patient_initials: patient.initials || 'PT',
          age: patient.age ?? 0,
          sex: patient.sex || '-',
          diagnosis: patient.diagnosis || '-',
          findings_html: '-',
          treatment_plan: '-',
          generated_at: new Date().toISOString().slice(0, 10),
        }
        break
      case 'title':
        payload[key] = 'Table 1'
        break
      case 'headers':
        payload[key] = ['Variable', 'Value']
        break
      case 'rows':
        payload[key] = []
        break
      case 'plot_type':
        payload[key] = 'bar'
        break
      case 'series':
        payload[key] = [{ x: [1, 2, 3], y: [1, 2, 1], label: 'Series 1' }]
        break
      case 'source_file_id':
        payload[key] = ''
        break
      default:
        if (p.type === 'string') payload[key] = '-'
        else if (p.type === 'array') payload[key] = []
        else if (p.type === 'object') payload[key] = {}
        else payload[key] = null
    }
  }

  return payload
}
