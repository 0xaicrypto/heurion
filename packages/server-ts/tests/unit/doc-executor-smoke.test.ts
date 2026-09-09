import { describe, test, expect } from 'vitest'
import { deepseekChatWithToolsStream } from '../../src/common/llm.js'
import { resolveActiveModel } from '../../src/common/llm-gateway.js'
import { EXECUTOR_RULE } from '../../src/modules/chat/writing-prompts.js'
import type { ToolDefinition } from '../../src/tools/base-tool.js'

/**
 * P0 hotfix 2026-09 — 真实中转站 e2e 冒烟(默认 skip,不进 CI)。
 *
 * 复现生产失效条件的精简版:~12k 字符文档 + 编辑指令 + 仅写回工具面,
 * 断言模型产生 edit_document 工具调用(原生 tool_calls 或 tool_call 块)。
 * 对照口径:≤10k token 精简上下文下 glm-5.3-flash 100% 正常返回工具调用;
 * 27k+ 毒上下文则零工具调用(本执行器兜底的存在依据)。
 *
 * 运行(需要真实 key 与中转站 env):
 *   RUN_LLM_SMOKE=1 DEEPSEEK_API_KEY=... \
 *   npx vitest run tests/unit/doc-executor-smoke.test.ts
 */
const RUN = process.env.RUN_LLM_SMOKE === '1' && Boolean(process.env.DEEPSEEK_API_KEY)

/** ~12k 字符的多章节文档(含若干可编辑锚点)。 */
function buildLongDocBody(): string {
  const sections: string[] = ['# 纳入患者的随访管理综述（冒烟用正文）', '', '## 摘要', '', '本综述系统梳理纳入患者的随访管理路径，目前结论(方案待定)，需结合最新证据进一步确认。', '']
  for (let i = 1; i <= 14; i++) {
    sections.push(
      `## 第 ${i} 章 随访要点 ${i}`,
      '',
      `本章讨论随访第 ${i} 个月的关键管理事项(细节待定)。患者在此阶段需要完成实验室检查与影像学评估，` +
        `并根据(方案待定)的路径调整随访频率。临床实践中应关注药物不良反应、依从性与生活质量，` +
        `同时对高危亚组加强监测。相关支持性证据已在正文其余章节展开，本章仅保留操作性结论(待定)。`,
      '',
    )
  }
  return sections.join('\n')
}

const EDIT_DOCUMENT_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'edit_document',
    description: 'Edit the current writing-session document. Range edit: pass old_text (copied from the current document) and new_text. One edit per call; make multiple calls to edit multiple parts.',
    parameters: {
      type: 'object',
      properties: {
        old_text: { type: 'string', description: 'Range mode: the original text to replace.' },
        new_text: { type: 'string', description: 'Range mode: the replacement text.' },
        full_text: { type: 'string', description: 'Full mode: the complete new document content in markdown.' },
        summary: { type: 'string', description: 'A one-line summary of what changed.' },
      },
      required: [],
    },
  },
}

describe.skipIf(!RUN)('doc executor smoke (real relay, RUN_LLM_SMOKE=1)', () => {
  test('~12k 精简上下文 + 编辑指令 → 产生 edit_document 工具调用', async () => {
    const docBody = buildLongDocBody()
    const messages = [
      { role: 'system' as const, content: EXECUTOR_RULE },
      {
        role: 'user' as const,
        content: [
          '## 当前文档全文\n',
          docBody,
          '\n\n## 用户任务\n',
          '把摘要段里的「(方案待定)」替换为「(方案已由指导委员会确认)」，并润色该句使其更简洁。',
          '\n\n## 既定方案（逐项用工具执行）\n',
          '1. 摘要段：「(方案待定)」→「(方案已由指导委员会确认)」并润色该句。',
        ].join('\n'),
      },
    ]

    const res = await deepseekChatWithToolsStream(
      messages,
      process.env.DEEPSEEK_API_KEY!,
      {
        model: resolveActiveModel(),
        telemetryContext: { userId: 'smoke', workspaceId: 'smoke', action: 'doc.executor.smoke' },
        timeoutMs: 180_000,
      },
      [EDIT_DOCUMENT_DEF],
      undefined,
    )

    const toolCallBlocks = (res.text || '').match(/<tool_call>[\s\S]*?<\/tool_call>/g) || []
    const nativeCalls = res.toolCalls || []
    const blockHit = toolCallBlocks.some((b) => b.includes('edit_document'))
    const nativeHit = nativeCalls.some((c) => c.name === 'edit_document')
    expect(blockHit || nativeHit).toBe(true)
  }, 240_000)
})
