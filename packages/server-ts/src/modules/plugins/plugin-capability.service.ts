import { deepseekChat, getApiKey as getLlmApiKey, type LlmTelemetryContext } from '../../common/llm.js'
import { listInstalledPlugins } from './plugin-installation.service.js'
import { getCatalogById, type PluginManifest, type PluginTool } from './plugin-catalog.service.js'

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

export async function matchIntent(userId: string, text: string): Promise<PluginMatch | null> {
  const plugins = await getActivePlugins(userId)
  let best: PluginMatch | null = null
  const q = text.toLowerCase()

  for (const manifest of plugins) {
    const triggers = manifest.triggers || []
    for (const trigger of triggers) {
      for (const pattern of trigger.patterns) {
        if (q.includes(pattern.toLowerCase())) {
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
      return await buildPayloadWithLlm(tool, manifest, input, apiKey)
    } catch {
      // fall through to fallback
    }
  }

  return fallbackPayload(tool, input)
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
  const prompt = `${patientBlock}\n\nUser request: "${input.text}"\n\nYou are preparing arguments for the "${manifest.plugin.name}" plugin tool "${tool.name}".\nReturn ONLY a JSON object that conforms to this schema:\n${schemaJson}\n\nIf the request does not provide enough detail, use clinically plausible placeholders. Do not include markdown or explanation.\n\nJSON object:`

  const raw = await deepseekChat([{ role: 'user', content: prompt }], apiKey, {
    model: 'deepseek-chat',
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
