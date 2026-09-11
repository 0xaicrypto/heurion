/**
 * #985 — 声明-执行对账单一模块。
 *
 * 「回复声称完成编辑」的判定此前有三套独立实现（三次 hotfix 各加一套）：
 *   1. EDIT_CLAIM_RE（writing-prompts，#892 零写回守卫 + post-turn 轨迹）
 *   2. countClaimedEditItems（writing-prompts，#967 部分执行对账）
 *   3. tool-loop 内联的对照表/编号步骤检测（#979 text_plan 守卫）
 * 且 countClaimedEditItems 只认中文 — edit_document 等工具 description 是
 * 英文，模型用英文回复（"1/3 completed"、"All comments addressed"）时
 * 对账形同虚设。三套并存还有口径漂移风险（#967/#977/#979 判定细节各异）。
 *
 * 本模块是唯一出口：双语声明词表、双语进度计数器、text-plan 形态识别。
 * 调用方：tool-loop / doc-executor / post-turn-pipeline。纯函数可单测
 * （中文用例保持 + 英文用例，见 edit-reconciliation.test.ts）。
 */

/**
 * #892/#985: 「编辑完成声明」识别（双语）— 回复声称已完成编辑动作的措辞。
 * 中文沿用原词表；英文为 edit_document 等工具 description 的语态
 * （completed/done/updated/applied/addressed/implemented/written back）。
 */
export const EDIT_CLAIM_RE = /已落实|已完成|已修改|已写回|已插入|已更新|已整理|已重构|已应用|\b(?:done|completed|addressed|updated|applied|implemented|written back)\b/i

/** 声明-执行对账判定(纯函数) — finalContent 是否含编辑完成声明。
 * 配合"本轮写回工具实际成功执行次数"使用:命中声明 && 成功次数为 0 → 未兑现声明。 */
export function detectUnbackedEditClaim(finalContent: string): boolean {
  return EDIT_CLAIM_RE.test(finalContent)
}

/**
 * 部分执行对账（#967 家族：声称全部完成、实际只写了第一处）— 数"声称
 * 已完成"的条目数(纯函数)。解析教过的进度格式（双语）:
 *   中文:EXPANSION_RULE「已完成 X/Y」、REVISION_RULE「意见 N/共 M 已落实」;
 *   英文:"1/3 completed"、"N of M addressed"、"completed X/Y"。
 * 对照表(中英)按含完成话术的行数计（排除表头/分隔行）。逐条如实播报
 * （已完成 1/5 / 1 of 5 done）不计入对账缺口 — claimed == executed 是诚实进度。
 */
export function countClaimedEditItems(finalContent: string): number {
  let claimed = 0
  const bump = (n: string | undefined) => {
    const v = parseInt(String(n ?? ''), 10) || 0
    if (v > claimed) claimed = v
  }
  for (const m of finalContent.matchAll(/(?:已完成|已落实)\s*(\d+)\s*\/\s*(\d+)/g)) bump(m[1])
  for (const m of finalContent.matchAll(/意见\s*(\d+)\s*\/\s*共\s*(\d+)\s*已落实/g)) bump(m[1])
  // 英文进度形态:"1/3 completed" / "completed 1/3" / "3 of 5 comments addressed"
  // (N of M 与动词之间允许常见名词短语,数字紧邻动词的形态同样覆盖)。
  for (const m of finalContent.matchAll(/(\d+)\s*\/\s*(\d+)\s*(?:completed|done|addressed|updated)/gi)) bump(m[1])
  for (const m of finalContent.matchAll(/(?:completed|done|addressed|updated)\s+(\d+)\s*\/\s*(\d+)/gi)) bump(m[1])
  for (const m of finalContent.matchAll(/(\d+)\s+of\s+(\d+)\s+(?:(?:comments?|items?|edits?|sections?|changes?|points?)\s+)?(?:completed|done|addressed|updated|fixed)/gi)) bump(m[1])
  // 对照表行（双语）：markdown 表格行且含改动词（表头不含这些词）。
  const tableHeader = /修订对照|原意见|实际改动|revision table|response to reviewers|response to comments/i
  if (tableHeader.test(finalContent)) {
    const claimWord = /新增|修改|更新|插入|落实|替换|已有|added|updated|inserted|replaced|addressed|implemented|polished/i
    const rows = finalContent
      .split('\n')
      .filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s|:-]+\|\s*$/.test(l) && claimWord.test(l))
    if (rows.length > claimed) claimed = rows.length
  }
  return claimed
}

/**
 * #979/#985: text-only 计划表形态识别 — 收尾输出 ≥3 个编号步骤/对照表
 * 且本回合无 set_task_plan 调用 → 模型在用纯文本管理进度（用户生产实例:
 * 两次问进度给出互不一致的口头清单），逼向结构化账本。
 * 判据(纯函数):编号步骤 ≥3 行 或 对照表形态,且内容涉及任务/步骤/计划
 * （双语锚点,英文取保守集合避免误伤普通回答）。
 */
export function detectTextOnlyPlan(finalContent: string): {
  numberedStepLines: number
  tableLike: boolean
  hit: boolean
} {
  const numberedStepLines = finalContent
    .split('\n')
    .filter((l) => /^\s*\d+\s*[.、）)]\s*\S/.test(l)).length
  const tableLike = /对照表|计划表|步骤如下|整改计划|revision table|response plan|action plan/i.test(finalContent)
  const topicLike = /任务|步骤|计划|填写|修改|\b(?:plan|steps?|task|items?)\b/i.test(finalContent)
  // hit 语义与原 tool-loop 内联判定一致(仅提取重构,行为零变化)。
  return { numberedStepLines, tableLike, hit: (numberedStepLines >= 3 || tableLike) && topicLike }
}
