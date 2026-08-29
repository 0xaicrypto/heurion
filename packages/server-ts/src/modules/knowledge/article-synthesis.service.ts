import { resolveTierModel } from '../../common/llm-gateway.js'
/**
 * Article synthesis service (#687) — the LLM-driven regenerate path that
 * used to live in knowledge.router.ts. Router stays request/response-only;
 * prompts are the shared templates from memory/prompts.ts.
 */
import { deepseekChat, getApiKey} from '../../common/llm.js'
import { parseLlmJson } from '../../common/llm-json.js'
import { articleSynthesisPrompt, ARTICLE_SYNTHESIS_PERSONA } from '../../memory/prompts.js'
import type { MemoryService } from '../../memory/memory.service.js'
import type { ArticleNode, FactNode } from '../../memory/memory.types.js'
import type { Result } from '../../common/result.js'

/**
 * Re-write an article from its current source facts. LLM failure falls back
 * to the existing title/content — the version bump still happens.
 */
export async function regenerateArticleWithLlm(
  article: ArticleNode,
  memory: MemoryService,
  userId: string,
): Promise<Result<ArticleNode>> {
  const sourceFacts = article.sourceFacts
    .map(s => memory.graph.getLatestByStableId(s.stableId))
    .filter((n): n is FactNode => n?.type === 'fact' && n.status !== 'superseded')

  let title = article.title
  let content = article.content

  if (sourceFacts.length > 0) {
    const factList = sourceFacts
      .map(f => `[importance=${f.importance ?? 3}] [${f.category}] ${f.content}`)
      .join('\n')
    const prompt = articleSynthesisPrompt(factList, ARTICLE_SYNTHESIS_PERSONA.researcherEn)
    try {
      const raw = await deepseekChat(
        [{ role: 'user', content: prompt }],
        getApiKey(),
        {
          model: resolveTierModel('fast'),
          maxTokens: 2048,
          telemetryContext: { userId, workspaceId: userId, action: 'article.regenerate' },
        },
      )
      const parsed = parseLlmJson<{ title?: string; content?: string }>(raw)
      if (parsed) {
        if (parsed.title) title = String(parsed.title)
        if (parsed.content) content = String(parsed.content)
      }
    } catch {
      // Fall back to keeping existing title/content but still bumping the version.
    }
  }

  return memory.editArticle(article.stableId, { title, content }, 'system')
}
