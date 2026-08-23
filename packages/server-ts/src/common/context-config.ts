/**
 * #637 阶段 5 — 集中 ContextConfig。
 *
 * 此前预算常量/场景上限/注入配额散落 conversation-turn/persona/
 * projection/chat-context 各文件,同一数字多处手写。集中后改一处生效
 * 全局,并为装配管线(阶段 2)提供单一配置源。
 */

// ── 预算（#630 口径:剩余 = maxTotal − system − history）──
export const CONTEXT_CONFIG = {
  /** 全链路 token 上限。 */
  maxTotalTokens: parseInt(process.env.MAX_TOTAL_TOKENS || '64000', 10),
  /** 历史消息 token 预算。 */
  maxHistoryTokens: parseInt(process.env.MAX_HISTORY_TOKENS || '32000', 10),
  /** 历史轮数窗口。 */
  historyTurns: parseInt(process.env.HISTORY_TURNS || '20', 10),

  // ── projection 内部配额（memory-projection.ts）──
  projection: {
    /** 虚构窗口（展示用;真实口径以 maxTotalTokens 为准）。 */
    maxTokens: 8000,
    episodeDays: 7,
    recencyLambda: 0.3,
    patientContextTokens: 1000,
    reserveTokens: 500,
    episodesBudget: 1500,
    factsBudget: 1500,
    skillsMax: 5,
  },

  // ── persona 身份级信息配额（persona.ts）──
  persona: {
    prefsMax: 5,
    goalsMax: 3,
    knowledgeTitlesMax: 5,
  },

  // ── 注入配额（conversation-turn.ts / knowledge-inject.ts）──
  injection: {
    /** 自动注入三档:充足 → 3×4K;中等 → 2×3K;紧张 → 1×2K(#630)。 */
    kbItemsRich: 3,
    kbCharsRich: 4096,
    kbItemsMid: 2,
    kbCharsMid: 3072,
    kbItemsTight: 1,
    kbCharsTight: 2048,
    kbTotalRich: 12_000,
    kbTotalMid: 8_000,
    kbTotalTight: 4_000,
    /** 显式选择(#620/#633)。 */
    pickedMax: 3,
    pickedCharsPerItem: 4000,
  },

  // ── 场景上下文配额（conversation-turn.ts）──
  scene: {
    rosterMax: 50,
    studiesMax: 10,
    protocolChars: 700,
    /** #fix: 写作会话注入的当前文档 token 预算(脚本感知裁剪,见
     *  token-estimate.fitTextToTokens)。 */
    docBodyTokens: parseInt(process.env.DOC_BODY_TOKENS || '20000', 10),
    docRefChars: 4000,
    recentFilesMax: 5,
    fileContextChars: 120,
    /** #fix: 附件文本提取字符上限(每文件,提取阶段;token 层面由
     *  attachmentTokenBudget 裁剪)。默认 300K — 长文档(整篇稿件)不在此截断。 */
    attachmentExtractChars: parseInt(process.env.ATTACHMENT_TEXT_MAX_CHARS || '300000', 10),
    /** #fix: 附件文本 token 预算(脚本感知) — 总预算减 system(6K)+最小
     *  历史(4K)+输出预留(2K),剩余全给附件。 */
    attachmentTokenBudget: parseInt(process.env.ATTACHMENT_TOKEN_BUDGET || '52000', 10),
  },

  // ── 检索（chat-context.ts / picker）──
  retrieval: {
    factsCap: 50,
    crossPatientMax: 5,
    pickerTopK: 50,
  },
} as const

export type ContextConfig = typeof CONTEXT_CONFIG
