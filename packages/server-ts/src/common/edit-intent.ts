/**
 * #984 — 编辑意图/确认信号词表单一来源。
 *
 * 此前编辑意图判定存在多份独立维护、不同步的词表（#977 复盘：近 10 次
 * 提交多次因漏词返工）：
 *   - retrieval/query-router.ts EDIT_MARKERS（sidecar 否决词 — "润色这篇
 *     论文"不是文件生成请求）
 *   - modules/chat/doc-executor.ts DOC_EDIT_INTENT_RE（执行器兜底触发词，
 *     #977 补过填充/补全/重试）
 *   - writing-prompts CONFIRM_RULE 的确认词家族（散落 hardcode）
 * 两表分工不同（路由 veto vs 执行器兜底触发）但语义同源，分叉必然复发。
 *
 * 本模块是唯一词源：词表数组 + 从数组构建的正则，双语逐词断言在
 * edit-intent.test.ts（约定：补词必须同步加断言）。
 *
 * 放 common 层而非 modules/chat：retrieval 层禁止 import modules/*
 * （arch-layers #940），query-router 需要引用否决词 — common 是唯一
 * 双方可达层（同 plan-store #672 先例）。
 */

/** 编辑意图中文词（执行器兜底触发 + sidecar 否决共用子集）。 */
export const DOC_EDIT_INTENT_ZH_WORDS = [
  '修改', '编辑', '删除', '插入', '整理', '润色', '重写', '重构', '调整',
  '扩写', '续写', '执行', '落实', '落盘', '改好', '填充', '补全', '补充',
  '完善', '改写', '重试', '修正', '排版', '改一下',
]

/** 编辑意图英文词（前缀匹配语义沿用原正则 — restructur/reorgan 匹配
 *  restructure/restructured/reorganisation 等形态）。 */
export const DOC_EDIT_INTENT_EN_WORDS = [
  'edit', 'polish', 'revise', 'rewrite', 'restructur', 'reorgan',
  'retry', 'improve', 'insert', 'update',
]

/** #984: 编辑意图判定（doc-executor 兜底触发）— 合并两表历史补丁全集。 */
export const DOC_EDIT_INTENT_RE = new RegExp(
  `${DOC_EDIT_INTENT_ZH_WORDS.join('|')}|${DOC_EDIT_INTENT_EN_WORDS.join('|')}`,
  'i',
)

/**
 * #551-followup: sidecar 否决词 — "帮我润色这篇论文"是对既有文档的编辑，
 * 不是文件生成请求。词源同上（query-router 引用本表）。
 */
export const EDIT_VETO_ZH_WORDS = ['润色', '修改', '改一下', '完善', '续写', '改写', '重写', '修正', '排版']
export const EDIT_VETO_EN_WORDS = ['polish', 'edit', 'revise', 'rewrite', 'improve']
export const EDIT_MARKERS = new RegExp(
  `(${[...EDIT_VETO_ZH_WORDS, ...EDIT_VETO_EN_WORDS].join('|')})`,
  'i',
)

/**
 * #976/#973/#984: 确认信号词（CONFIRM_RULE 的确认词家族单一来源）—
 * 继续确认/接力判定（PLAN_RELAY_RE）与提示文案共用本表。
 */
export const CONFIRM_SIGNAL_ZH_WORDS = ['同意', '可以', '开始', '继续', '好的', '按此计划']
export const CONFIRM_SIGNAL_EN_WORDS = ['go']
/** 接力触发词（继续/接着/下一步/重试第 K 步/开始确认）。 */
export const PLAN_RELAY_RE = /继续|接着|下一步|重试第?\s*\d*\s*步|^开始|开始吧|按此计划|^go\b/i
