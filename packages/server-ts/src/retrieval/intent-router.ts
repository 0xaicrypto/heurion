/**
 * #452 — IntentRouter: unified sidecar-intent resolution (Chain of
 * Responsibility). One place decides "is this a document/render request":
 *
 *   1. Plugin trigger matcher (installed + enabled plugins, per user)
 *   2. Keyword fallback (render intent even before any renderer plugin is
 *      installed — the plugin handler then guides the user to the
 *      marketplace)
 *
 * This replaces the three parallel implementations (query-router regex,
 * sidecar-chat-handler detectJobType, plugin trigger matching). The router
 * classification itself stays in retrieval/query-router (rule + LLM, cached
 * per query — plugin matching must NOT enter that cache because it is
 * per-user).
 */
import { matchIntent } from '../modules/plugins/plugin-capability.service.js'
import { classifySidecarIntent } from './query-router.js'

/**
 * True when the query is a document/render request — either an installed
 * plugin trigger matched, or the keyword fallback recognized it.
 */
export async function resolveSidecarIntent(userId: string, text: string): Promise<boolean> {
  const match = await matchIntent(userId, text)
  if (match) return true
  return classifySidecarIntent(text)
}
