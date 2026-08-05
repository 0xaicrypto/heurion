import type { EpisodesStore } from '../../evolution/stores'
import { makeLogger } from '../../common/logger.js'

/**
 * §5.1 (#189): session summarizer extracted from the gateway.
 * Summaries are Session Memory (draft layer, un-reviewed) — they update the
 * session's episodes instead of entering the review queue (the
 * episode_summary proposal was a no-op). LLM failure degrades gracefully.
 */
const log = makeLogger('memory.session-summarizer')

export class SessionSummarizer {
  constructor(
    private userId: string,
    private episodes: EpisodesStore,
  ) {}

  async summarize(input: {
    conversation: string
    sessionId: string
    patientHash?: string
    sinceIdx?: number
  }): Promise<{ summary: string; proposals: number }> {
    const { deepseekChat, getApiKey } = await import('../../common/llm.js')
    let apiKey: string
    try {
      apiKey = getApiKey()
    } catch {
      return { summary: '', proposals: 0 }
    }

    const prompt = `你是临床对话摘要器。把以下对话压缩为结构化摘要，保留：
- 患者标识与诊断结论（含鉴别诊断）
- 已做出的治疗决策与理由
- 用药/剂量变更
- 关键检查数值与趋势
- 未解决问题与待办（含时间节点）
- 用户偏好与约束

要求：中文输出；≤400 tokens；使用以下模板（每节保留，空节写"(none)"）：

## Objective
## 患者重要信息
## 决策与理由
## 已完成
## 进行中
## 阻塞
## 下一步
## 相关文件与检查

不要提及摘要过程本身。

对话：
${input.conversation.slice(0, 12000)}`

    let summary: string
    try {
      summary = (await deepseekChat(
        [{ role: 'user', content: prompt }],
        apiKey,
        {
          model: process.env.DEEPSEEK_CHAT_MODEL || 'deepseek-v4-flash',
          maxTokens: 400,
          telemetryContext: { userId: this.userId, workspaceId: this.userId, action: 'memory.summarize' },
        },
      )) || ''
    } catch (err) {
      log.warn('summarize degraded (LLM failed)', { reason: (err as Error).message.slice(0, 120) })
      return { summary: '', proposals: 0 }
    }

    if (!summary.trim()) return { summary: '', proposals: 0 }

    try {
      const turnCount = this.episodes.all().find((e: any) => e.sessionId === input.sessionId)?.turnCount ?? 0
      this.episodes.upsert(input.sessionId, summary, turnCount + 1)
      this.episodes.commit()
    } catch (err) {
      log.warn('session memory update skipped', { reason: (err as Error).message.slice(0, 120) })
    }

    return { summary, proposals: 0 }
  }
}
