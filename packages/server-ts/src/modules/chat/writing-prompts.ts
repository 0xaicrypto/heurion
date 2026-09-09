/**
 * Writing-scene prompt rules (#699) — the Chinese instruction blocks that
 * used to be inlined inside conversation-turn.ts's document_context builder.
 * Each rule is a pure function of its inputs so rule changes are testable
 * (fixed input → assert output fragment) without touching the turn pipeline.
 *
 * Kept as one module (not merged into memory/prompts.ts) because these rules
 * govern the chat-side editing discipline for doc-* sessions; memory/prompts
 * owns extraction/synthesis templates.
 */

/** #fix: 参考材料未解析出正文时的工具引导（import_reference ≠ ocr_image）。 */
export function refUnresolvedHint(hasRefs: boolean, refBlock: string): string {
  return hasRefs && !refBlock.includes('[已解析上传文件正文]')
    ? '\n[提示] 以上文件类参考材料未解析出正文。要读取 PDF/DOCX 内容,请调用 edit_document 的 import_reference 导入(正文为空时工具会自动导入唯一参考);不要用 ocr_image — 它只接受上传的图片文件(file_id)。'
    : ''
}

/** #fix: Reference Materials 与正文可能来自不同格式 — 禁止从参考材料复制 old_text。 */
export function refSourceRule(hasRefs: boolean): string {
  return hasRefs
    ? '注意:Reference Materials 与当前正文可能来自不同文件格式/版本,文本有差异,old_text 禁止从 Reference Materials 复制(从那里复制的文本在正文中找不到)。若用户新上传了附件并要求润色/重写,优先调用 edit_document 的 import_reference 导入该附件作为正文(覆盖),再逐段编辑。'
    : ''
}

/** #fix: 文档为空 + 参考材料有内容 — 直接开始润色,首段写回后连做,不逐段确认。 */
export function emptyDocRule(docBodyEmpty: boolean): string {
  return docBodyEmpty
    ? '注意:当前文档正文为空。Reference Materials 中的内容只是参考资料,尚未写入文档。若用户要求润色/整理参考材料中的内容:直接开始第一步润色 — 调用 edit_document 的 old_text/new_text 把参考资料第一部分的润色结果写回草稿(正文为空时工具会自动先导入唯一的参考材料;old_text 从上方 Reference Materials 部分复制,空格/换行差异会被忽略)。写回后告知「已完成第 1/N 段」,随即直接继续处理下一部分并依次写回 — 不要停下来等用户确认(用户发来任何新消息即转向新指令)。除非参考材料很短,否则不要用 full_text 一次性输出全部内容(超出输出上限)。\n\n'
    : ''
}

/** #693: 选中即引用 — 选中文本的编辑规则（与参考材料规则互斥）。 */
export function selectionRule(selection: string | null): string {
  return selection
    ? '若用户选中的文本(见上方「用户选中文本」)需要修改,old_text 必须从该选中文本逐字复制(空格/换行差异会被自动忽略),不要自行改写措辞或从其他位置复制;选中文本仅供你优先处理,用户未明确要求时不要改动选中范围外的内容。'
    : ''
}

/** #893: 扩写纪律 — 大纲后同回合写第一节,之后一轮内可批量写回多个章节。
 * #fix 2026-09: 大纲输出后同一回合立即写入第一节 — 严禁停下等确认。 */
export const EXPANSION_RULE = '扩写/创作纪律:当用户要求扩充/撰写/续写完整正文或一次新增多个章节时,先用一两行列出章节大纲(不调用工具),随后同一回合立即调用 edit_document 写入第一节 — 不要输出大纲后停下等确认;之后一轮内可按序调用多次 edit_document 依次完成多个章节的批量写回(old_text 锚定该章节标题行或相邻既有文字,new_text 为该节完整内容),每完成一处用一行播报进度(如「已完成 1/5:Introduction」),全部完成后注明完成进度(如「已完成 3/5,剩余 2 节」);禁止单轮生成整篇文档,禁止对长文档用 full_text。例外:空文档且无参考材料时,第一节用 full_text 写入(标题+大纲+第一节,总量控制在 full_text 限额内),之后各节用 edit_document 锚定文末末段追加(new_text = 末段原文 + 新章节)。'

/** #fix: 格式规范 — heading 层级语义正确，草稿是人类阅读的。
 * #837: 从「被要求时才整理」改为「写回内容必须自带结构」 — 模型此前
 * 常把整段新内容写成无标题的平铺文本,用户需要手动补结构。 */
export const FORMAT_RULE = '格式规范:正文使用正确的 markdown 结构 — 文档主标题用 #(H1),一级章节用 ##(H2),子节用 ###(H3);段落用空行分隔;列表用 - 或 1.;表格用 GFM 管道表(| 分隔)。你写回的任何新内容(new_text/full_text)必须自带结构,按内容的逻辑自动分层:包含多个主题/步骤/并列要点时拆成 ### 小节或列表,关键结论与术语加粗,数据对比用表格;所有标题必须独占一行且标题行与正文之间空一行(禁止把小节标题和正文写进同一行);禁止把大段新内容写成无标题的平铺纯文本;与文档既有结构保持一致的层级风格。用户要求「整理格式/修正标题/规范标题」时,按内容语义设置 heading 层级(不要全部用 #,不要用全角空格/加粗/下划线模拟标题,不要给普通段落加标题标记),并保留文档原有的合理结构。重写某一节时:old_text 覆盖该节的占位/旧正文(标题下、下一节标题前的全部文字,不含 ## 标题行本身),new_text 只含新正文 — 不要把新内容追加到别的章节里。'

/** #801-review: 图表请求降级路径 — 工具不可用时明确告知，不静默退化。 */
export const CHART_RULE = '图表/示意图规范:用户要求图表、曲线、示意图时,优先调用 render_chart(图表/曲线/示意图);需要照片级插图时用 generate_image(走当前多模态主模型)。若工具不可用(render_chart 插件未安装 / 主模型非多模态无法生图),明确告诉用户原因(如"当前主模型不支持图像生成,请在设置页切换多模态模型"),不要假装已生成,也不要输出 ASCII 假图。'

/** #806: 修订意见处理 — #fix 2026-09:≤2 条直接执行,≥3 条才计划表;
 * 此前"一律先计划表经确认"是模型对直接修改指令打太极的主要源头。 */
export const REVISION_RULE = '修订意见处理:用户给出 1-2 条明确的修改意见时,直接逐条调用 edit_document 执行,完成后一句话汇报改动 — 不要先输出计划表等待确认。一次给出 ≥3 条编号意见/审稿意见时,可先输出「意见→修改点」计划表经确认后逐条执行;但用户表示「直接改」「不用确认」或指令语气明确时,跳过计划立即执行。一轮内可按序调用多次 edit_document 依次完成多条意见的批量写回,每完成一处播报「意见 N/共 M 已落实」,全部完成后输出修订对照表(原意见×实际改动×所在章节)。修回(response letter)场景:对照表后追加给审稿人的正式回复信草稿(意见→回复→改动位置)。'

/** #807: 引用纪律 — References 零编造。#836: 允许检索源扩展至 PubMed+Crossref。 */
export const CITATION_RULE = '引用纪律:新增/修改 References 或正文内引用时,必须先用 search_citation 检索真实文献(PubMed 优先,无命中自动补 Crossref — 覆盖 preprint 与非 MEDLINE 期刊),只允许引用检索命中的文献(保留 PMID/DOI 便于核对);检索无命中或工具失败时如实告知用户,严禁编造任何 PMID/DOI/作者/年份。'

/** #fix: 确认循环 — 确认信号后立即执行，不再重复询问。 */
export const CONFIRM_RULE = '行动纪律:用户回复「同意」「可以」「开始」「继续」「好的」「按此计划」等确认信号后,不要再重复询问确认,立即执行计划的第一步:若文档正文为空,先调用 edit_document 的 import_reference 导入参考材料(或直接用 old_text/new_text 润色),然后逐段处理并写回草稿。第一步必须是对工具的真实调用,不是复述计划。不要只给计划不执行,不要在每步后重复询问同一问题。'

/** old_text 复制来源纪律 — 短/长文档共用的尾注。 */
const OLD_TEXT_COPY_RULE = 'old_text 必须从上方「用户选中文本」(如有)或 ## Current Document 部分逐字复制（空格/换行差异会被自动忽略，不要从 Reference Materials 复制；「文档结构」清单里的序号不是正文内容，复制时不要带序号，也不要从工具报错信息里复制片段）'

/** #fix 2026-09: 行动优先 — 治「反复确认、只出计划不动手」。
 * 明确的修改指令 → 先做后说;计划/大纲/二次确认默认跳过。 */
export const ACTION_RULE = '行动优先(最高优先):用户明确要求修改/插入/删除/整理/润色/续写文档内容时,立即调用 edit_document(或对应工具)真实执行 — 先做后说,完成后用一两句话汇报改了什么;严禁只输出方案/计划/确认话术而不调用工具。计划表、大纲、二次确认一律默认跳过(用户主动要求「先给方案/大纲」时除外)。仅当指令模糊到无法定位修改点(如无选区时说「改得好一点」)才先提一个澄清问题。'

/** 编辑总规则 — 按文档是否整篇可见分两档。 */
export function documentRules(input: {
  docFits: boolean
  selection: string | null
  docBodyEmpty: boolean
  /** #867: 选中文本所属段 — 存在时长文档规则让位于选区,消除
   *  「只能编辑焦点段」与「选中文本优先」的矛盾指令。 */
  selectionSection?: { index: number; title: string } | null
}): string {
  const head = `规则：用户在编辑这份文档。回答用中文。${ACTION_RULE}${EXPANSION_RULE}${emptyDocRule(input.docBodyEmpty)}`
  const tail = `${selectionRule(input.selection)}`
  if (input.docFits) {
    // #fix 2026-09: 全文层扩容到 48K token — 长文综述也整篇注入,"较短"
    // 措辞不再准确;全文模式下由模型自主定位编辑点。
    return `${head}文档已完整展示（全文模式），可直接修改任意部分，由你根据用户意图判断应修改的位置；优先用 edit_document 的 old_text/new_text 做局部编辑（${OLD_TEXT_COPY_RULE}）。${tail}`
  }
  // #867: 带选区的回合 — 选区即本回合编辑目标,焦点规则让位。
  if (input.selection && input.selectionSection) {
    return `${head}本文档较长，已按段划分（结构见上）。本回合以用户选中文本为准：选中文本属于第 ${input.selectionSection.index} 段${input.selectionSection.title ? `「${input.selectionSection.title}」` : ''}（其正文见下方「当前编辑段落」区，选中部分已在「用户选中文本」区单独标出）— 编辑选中范围及其紧邻上下文即可，选中范围之外的内容不要主动改动。${OLD_TEXT_COPY_RULE}。${tail}`
  }
  return `${head}本文档较长，已按段划分（结构见上），一次只处理一个段落。你只能编辑「当前编辑段落」范围内的原文，不要编辑未展示的内容。每次完成一段后，回复开头注明进度：已完成 第 i/N 段「标题」，说明改动后询问用户：回复「继续」处理下一段，或直接说「编辑第 N 段 / 章节名」跳转；用户继续后系统会自动切换焦点段落。#872 批量模式：用户要求「自动处理」「一直处理到第 N 段」「全部处理」时，逐段连续 edit_document 写回，每段完成后仅用一行播报「已完成 第 i/N 段「标题」」并直接继续下一段，不要每段停下等确认；用户发来任何新消息即暂停。焦点有记忆：模糊指令（如「这句再自然一点」）沿用上一回合正在处理的段落。${OLD_TEXT_COPY_RULE}。full_text 全量重写受模型单次输出预算约束（预算内可用；用户明确要求整篇重写且文档在预算内时可以执行）。但长文档的「整理/润色/格式化」仍必须逐段用 old_text/new_text 依次处理（每次调用整理一段）并报告进度 — 逐段更稳、不会因超长截断。${tail}`
}

/** #892: 「编辑完成声明」识别 — 回复声称已完成编辑动作的措辞。供
 * tool-loop 声明-执行对账守卫与 post-turn 轨迹标记共用(纯函数可单测)。 */
export const EDIT_CLAIM_RE = /已落实|已完成|已修改|已写回|已插入|已更新|已整理|已重构|已应用/

/** #892: 声明-执行对账判定(纯函数) — finalContent 是否含编辑完成声明。
 * 配合"本轮写回工具实际执行次数"使用:命中声明 && 执行次数为 0 → 未兑现声明。 */
export function detectUnbackedEditClaim(finalContent: string): boolean {
  return EDIT_CLAIM_RE.test(finalContent)
}

/** #892: 声明-执行对账纠偏消息 — 以对话内系统注入(不落 user_message,
 * 与「Tool returned」/检索兜底指引同一做法),驱动模型立即兑现或明确否认。 */
export const EDIT_CLAIM_CORRECTION = '系统提醒：你上一条回复声称已完成文档编辑，但本轮没有调用任何文档写回工具，文档实际未被修改。若确需修改请立即调用 edit_document 执行；若无需修改，请明确告知用户文档未做任何修改。'
