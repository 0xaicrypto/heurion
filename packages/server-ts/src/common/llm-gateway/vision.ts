/**
 * #921 — llm-gateway 拆分:视觉能力判定 / 多模态序列化。
 * 纯机械搬移自 src/common/llm-gateway.ts — 零行为变化。
 */
import type { ChatContentPart, ChatMessage } from './types.js'
import { currentLlmProvider, resolveActiveModel } from './provider.js'

/** #511: providers that accept image_url parts over the OpenAI-compatible
 *  endpoint. deepseek/opencode 默认走 deepseek-v4-flash(支持多模态),
 *  kimi 纯文本 → 由 modelSupportsVision 精确兜底。#784: anthropic 移除
 *  (直连条目已删,claude 经中转站走 OpenAI 兼容端点)。 */
const VISION_PROVIDERS: ReadonlySet<string> = new Set(['gemini', 'openai'])

/** #fix: 明确不支持视觉的模型。v3 时代 DeepSeek(deepseek-chat /
 *  deepseek-reasoner)是纯文本;v4+(deepseek-v4-flash/pro)支持
 *  OpenAI-compatible image_url 多模态输入。
 *  #fix 2026-09: 注册表假设可能落后于中转站实际路由 — Console Go 的
 *  deepseek-v4-flash 实测纯文本(生产 400: "Model only supports text
 *  input; received unsupported content type 'image_url'")。部署可用
 *  LLM_TEXT_ONLY_MODELS=deepseek-v4-flash(逗号分隔)覆盖注册表,注入侧
 *  即降级为文字占位;网关侧另有 400 自愈重试兜底(stripImageParts)。
 *  #925/#921 拆分:env 惰性读取(原模块加载时快照,运行时改 env 不生效;
 *  现每次调用读 env — 集合极小,构造成本可忽略)。 */
function textOnlyModels(): ReadonlySet<string> {
  return new Set([
    'deepseek-chat', 'deepseek-reasoner',
    ...(process.env.LLM_TEXT_ONLY_MODELS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  ])
}

/** #fix 2026-09: 上游 400 拒收图片错误的识别 — 命中即剥离图片重试一次。 */
export function isImageUnsupportedError(status: number, body: string): boolean {
  if (status !== 400) return false
  return /image_url|image url|content\s*type|multimodal|only supports text/i.test(body)
}

/** 剥离消息中的图片 part → 文字占位(模型纯文本时的降级路径)。 */
export function stripImageParts(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content) || !m.content.some((p) => p.type === 'image')) return m
    return {
      ...m,
      content: m.content.map((p) =>
        p.type === 'image' ? ({ type: 'text', text: `[image omitted: ${p.mime} — 当前模型仅支持文本输入]` } as ChatContentPart) : p,
      ),
    }
  })
}

/** 按模型名判定视觉能力:已知视觉模型(v4+ 家族,含
 *  deepseek-v4-flash-vision-exp)→ true;已知纯文本模型 → false;
 *  未知模型名保守 false(由调用方用 provider 维度兜底)。 */
export function modelSupportsVision(model: string): boolean {
  const m = model.toLowerCase()
  if (textOnlyModels().has(m)) return false
  // deepseek-v4 前缀覆盖 flash/pro/vision-exp 等全部 v4 变体;
  // 名称含 vision 的模型也按支持视觉处理。
  if (/^deepseek-v4/.test(m) || /vision/.test(m)) return true
  // #752: GLM-5.x 全系多模态(用户确认 glm-5.3-flash 支持图片输入)。
  if (/^glm-/.test(m)) return true
  return false
}

/**
 * 视觉能力判定(provider + model 双维度)。
 * - 显式传 model:模型明确支持视觉 → true;否则看 provider。
 * - 不传 model(老调用方):deepseek/opencode 默认模型是 deepseek-v4-flash,
 *   按视觉处理;gemini/openai 恒支持;kimi 恒不支持。
 */
export function providerSupportsVision(provider?: string, model?: string): boolean {
  const prov = (provider || process.env.DEFAULT_LLM_PROVIDER || 'deepseek').toLowerCase()
  if (model) return modelSupportsVision(model) || VISION_PROVIDERS.has(prov)
  return VISION_PROVIDERS.has(prov) || prov === 'deepseek' || prov === 'opencode'
}

/** #827: 当前生效的主模型是否多模态(provider + resolveActiveModel 双维度)。 */
export function isMainModelMultimodal(): boolean {
  return providerSupportsVision(currentLlmProvider(), resolveActiveModel())
}

/**
 * #827: 多模态输出提取(纯函数) — OpenAI-compat 约定的
 * `message.images[]`(image_url.url 或 url,常见于 gemini/中转站)+
 * content 内联 data-URI/https 图片兜底。返回 data:/https:// URL 列表。
 */
export function extractImagesFromChatResponse(message: any): string[] | undefined {
  if (!message) return undefined
  const urls: string[] = []
  if (Array.isArray(message.images)) {
    for (const img of message.images) {
      const u = typeof img === 'string' ? img : img?.image_url?.url || img?.url
      if (typeof u === 'string' && (u.startsWith('data:image/') || /^https?:\/\//.test(u))) urls.push(u)
    }
  }
  const content = typeof message.content === 'string' ? message.content : ''
  if (content) {
    for (const m of content.matchAll(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/\S+\.(?:png|jpe?g|webp|gif)(?:\?\S*)?/gi)) {
      urls.push(m[0])
    }
  }
  return urls.length > 0 ? urls : undefined
}

/** Serialize a message content into OpenAI /chat/completions parts. */
export function serializeContent(content: string | ChatContentPart[], model?: string): unknown {
  if (typeof content === 'string') return content
  // #fix: 双保险 — 即使上下文装配阶段已注入图片 part,发往纯文本模型
  // (deepseek-chat/reasoner)前必须降级,否则 provider 直接 400。
  if (model && !modelSupportsVision(model)) {
    return content.map((part) =>
      part.type === 'image'
        ? { type: 'text', text: `[图片附件已省略:当前模型 ${model} 不支持图片输入]` }
        : { type: 'text', text: part.text },
    )
  }
  return content.map((part) => {
    if (part.type === 'image') {
      return { type: 'image_url', image_url: { url: `data:${part.mime};base64,${part.dataBase64}` } }
    }
    return { type: 'text', text: part.text }
  })
}

/** #511: map message contents to OpenAI parts before sending. */
export function serializeMessages(messages: ChatMessage[], model: string): unknown[] {
  return messages.map((m) => ({ role: m.role, content: serializeContent(m.content, model) }))
}
