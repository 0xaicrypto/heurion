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
  maxTotalTokens: parseInt(process.env.MAX_TOTAL_TOKENS || '128000', 10),
  /** 历史消息 token 预算。 */
  maxHistoryTokens: parseInt(process.env.MAX_HISTORY_TOKENS || '32000', 10),
  /** 历史轮数窗口。 */
  historyTurns: parseInt(process.env.HISTORY_TURNS || '20', 10),
  /** #writing-cost: 写作(doc-*)会话的历史预算 — P0 hotfix 2026-09:
   *  实测 27k+ 上下文(旧值 12k 历史 + 文档正文 + 规则 + facts)下 glm
   *  工具调用可靠性坍塌(每轮 completion 全是思考、零 tool_calls),
   *  ≤10k 上下文探针 100% 正常;且历史对润色任务价值低(每轮聚焦当前
   *  文档)。降到 1.5k — 足够承接「继续」/焦点记忆,不再把上下文顶到
   *  工具失效区。 */
  docHistoryTokens: parseInt(process.env.DOC_HISTORY_TOKENS || '1500', 10),
  /** P0 hotfix 2026-09: doc 会话历史轮数窗口(与 docHistoryTokens 同步
   *  收紧)— 非 doc 会话仍走 HISTORY_TURNS(默认 20 轮)。 */
  docHistoryTurns: parseInt(process.env.DOC_HISTORY_TURNS || '6', 10),

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
    /** #814: layer3 降级为"未成文记忆" — 仅 importance ≥ 此值或近 N 天的
     *  facts 进入碎片投影(其余交给 summary/JIT 合成覆盖,#815)。 */
    layer3ImportanceMin: parseInt(process.env.LAYER3_IMPORTANCE_MIN || '4', 10),
    layer3RecentDays: parseInt(process.env.LAYER3_RECENT_DAYS || '14', 10),
  },

  // ── persona 身份级信息配额（persona.ts）──
  persona: {
    prefsMax: 5,
    constraintsMax: 5,
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
    /** #815: JIT 惰性合成 — 无总结覆盖时的读时综合兜底(env 可关)。 */
    jitEnabled: process.env.JIT_SYNTHESIS_ENABLED !== 'false',
    jitMinFacts: 3,
    jitFactsMax: 10,
  },

  // ── 场景上下文配额（conversation-turn.ts）──
  scene: {
    rosterMax: 50,
    studiesMax: 10,
    protocolChars: 700,
    /** #fix: 写作会话注入的当前文档 token 预算(脚本感知裁剪,见
     *  token-estimate.fitTextToTokens)。
     *  #fix 2026-09: 20000 → 48000 — 全文层扩容,长文综述(数万 token)
     *  也整篇注入,由模型自主定位编辑点(上下文装配质量 >> 服务端焦点
     *  启发式);成本核算 glm-5.3-flash $0.15/1M ≈ $0.007/回合,且有
     *  x-opencode-session 会话头 prompt cache。焦点机制(#866-868)降级
     *  为超过此阈值的超大文档兜底层。 */
    docBodyTokens: parseInt(process.env.DOC_BODY_TOKENS || '48000', 10),
    /** #writing-cost: 单轮注入参考材料的文件数上限(按 label 与用户消息
     *  相关性优先) — 不相关参考不每轮全量注入。 */
    docRefFilesMax: parseInt(process.env.DOC_REF_FILES_MAX || '3', 10),
    docRefChars: 4000,
    /** #fix: 参考材料里上传文件(PDF/DOCX/txt)提取正文的 token 预算 —
     *  正文注入取代"只有文件名",LLM 才能真正读到稿件内容。 */
    docRefFileTokens: parseInt(process.env.DOC_REF_FILE_TOKENS || '8000', 10),
    /** #fix: 长文档分步润色 — 无标题文档按段落合并的目标块大小(token)。
     *  有标题时按章节切分,不受此值影响。 */
    docSectionTokens: parseInt(process.env.DOC_SECTION_TOKENS || '1500', 10),
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
    /** P0 hotfix 2026-09: doc- 写作会话(无患者上下文)的 layer3 facts
     *  注入条数封顶 — 27k 上下文下 glm 工具调用可靠性坍塌(≤10k 全正常),
     *  facts 对润色价值低,10 条(≈500 token)封顶。 */
    docFactsCap: 10,
    crossPatientMax: 5,
    pickerTopK: 50,
  },
} as const

export type ContextConfig = typeof CONTEXT_CONFIG
