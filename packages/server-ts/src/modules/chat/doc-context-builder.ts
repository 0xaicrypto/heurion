/**
 * #921/#927 — document_context builder(自 conversation-turn.ts 拆出)。
 *
 * 职责:doc- 会话的文档上下文段装配 — 参考材料按相关性裁剪/正文提取、
 * 长文档分段与焦点段解析、选区注入预算、deck 资产块、编辑规则组装。
 * 依赖显式入参(docId/消息/选区/焦点记忆/进度回调/编辑定位回填目标),
 * 不再闭包捕获 conversation-turn 的局部状态;prisma 与配置仍为模块依赖。
 *
 * #927 item 1(注入预算与去重):
 *  - 选区原文注入走 fitTextToTokens 预算(4k token 上限,与 bodyInjection
 *    同口径),超限截断并带截断标注;editHint 回填始终是未截断原文,
 *    工具侧(edit_document rangeEdit)定位不受影响。
 *  - selectionSection 命中时,焦点段正文(bodyInjection)已包含选区原文,
 *    「用户选中文本」块不再重复注入全文 — 改为锚点+定位提示(保持模型
 *    可从「当前编辑段落」内定位选区)。
 * #927 item 2(静态规则上移):
 *  - FORMAT/CHART/REVISION/CITATION/CONFIRM 五条静态规则从文档正文之后
 *    上移到正文之前的稳定段(规则串本身不改,顺序保持);
 *  - CHART/CITATION 加门控:仅当回合上下文有参考材料(evidence)或消息
 *    诉求与图表/引用相关时注入(判定从简,见 shouldInjectChartCitationRules)。
 */
import prisma from '../../common/prisma'
import { estimateTokens, fitTextToTokens } from '../../common/token-estimate.js'
import { splitDocumentSections, resolveDocumentFocus } from '../../lib/doc-sections.js'
// #989 Phase 2: 块投影 — 上下文注入挂节 ID(target_section 确定性编辑)。
import { loadProjection, withSectionIds } from '../../lib/block-projection.js'
import { CONTEXT_CONFIG } from '../../common/context-config.js'
import { buildDocReferenceBlocks, findUploadFileByName } from '../shared/chat-context.js'
import type { EditHint } from '../../tools/tool-registry.js'
// #699: 文档场景规则外置 — 本文件只做组装。
import { refUnresolvedHint, refSourceRule, documentRules, FORMAT_RULE, CHART_RULE, REVISION_RULE, CITATION_RULE, CONFIRM_RULE, PLAN_RULE, SECTION_EDIT_RULE } from './writing-prompts.js'
// #976: 任务清单状态与稳定段渲染（common 层,tools/modules 共用）。
import { loadActivePlan, renderPlanBlock } from '../../common/plan-store.js'

export interface DocumentContextInput {
  userId: string
  /** #905: 已由 parseDocSessionId 校验过的 doc_+16hex id。 */
  docId: string
  /** 本回合用户消息(参考材料相关性打分/焦点推断/图表引用门控)。 */
  messageText: string
  /** #693 编辑器选区原文(dto 上限 20k 字符;注入侧另做 token 预算)。 */
  rawSelection: string | undefined
  /** #868 编辑定位回填目标(焦点段原文/选中文本 — rangeEdit 焦点优先匹配)。 */
  editHint: EditHint
  /** 焦点记忆:上一条 assistant 回复(模糊指令沿用上一回合正在处理的段落)。 */
  lastAssistantContent: string | null
  /** #fix 2026-09: 段内子进度(参考材料逐文件提取可达分钟级)。 */
  stage?: (label: string) => void
}

/** #927 item 1: 选区注入 token 预算 — chat.dto selection 上限 20k 字符此前
 *  裸注入;现与 bodyInjection 同口径走 fitTextToTokens 截断,超限带标注。 */
const MAX_SELECTION_INJECTION_TOKENS = 4000

/** 截断标注 — 提示模型以保留前缀为锚点,不要把标注本身当正文复制。 */
export const SELECTION_TRUNCATION_MARKER =
  '[……选中文本超长已截断 — old_text 请以上方保留的选区前缀为锚点逐字复制(空格/换行差异会被自动忽略),或请用户缩小选区]'

/** #927 item 1: 选区原文裁剪到注入预算(超限截断 + 标注)。 */
export function fitSelectionForPrompt(selection: string): string {
  if (estimateTokens(selection) <= MAX_SELECTION_INJECTION_TOKENS) return selection
  return `${fitTextToTokens(selection, MAX_SELECTION_INJECTION_TOKENS)}\n${SELECTION_TRUNCATION_MARKER}`
}

/** #927 item 2: CHART/CITATION 静态规则门控 — 仅当回合上下文有参考材料
 *  (evidence)或消息诉求与图表/引用相关时注入,写作轮次不再每轮携带。
 *  判定从简:消息命中 /引用|文献|citation|图|figure|chart/ 即相关
 *  (附件正文在用户消息侧,系统段只看 messageText;不做更深意图判定)。 */
const CHART_CITATION_TRIGGER_RE = /引用|文献|citation|图|figure|chart/i

export function shouldInjectChartCitationRules(input: { hasRefs: boolean; messageText: string }): boolean {
  return input.hasRefs || CHART_CITATION_TRIGGER_RE.test(String(input.messageText || ''))
}

/** #989 Phase 2: 节 ID 查询 — 按规范化标题对齐(同名标题按出现序,与
 *  withSectionIds 同一匹配规则)。next = 顺序消费(结构清单遍历);
 *  peek = 非消费查找(焦点段头 — 清单遍历后仍可查)。 */
function makeSectionIdResolver(projection: ReturnType<typeof loadProjection>) {
  const all = projection.nodes.filter((n) => n.kind === 'section')
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  let cursor = 0
  return {
    next(title: string): string {
      if (!title) return ''
      const idx = all.findIndex((n, i) => i >= cursor && norm(n.heading || '') === norm(title))
      if (idx === -1) return ''
      cursor = idx + 1
      return all[idx]?.id ?? ''
    },
    peek(title: string): string {
      if (!title) return ''
      const idx = all.findIndex((n) => norm(n.heading || '') === norm(title))
      return idx === -1 ? '' : all[idx]?.id ?? ''
    },
  }
}

/** document_context 段装配(原 conversation-turn.ts builder 主体,机械搬移
 *  + 上述 #927 两项最小修改;required 段语义/roster 门控等 P1 逻辑不变)。 */
export async function buildDocumentContext(input: DocumentContextInput): Promise<string> {
  const { userId, docId, messageText, editHint, stage } = input
  const doc = await prisma.doc.findFirst({ where: { id: docId, userId } })
  if (!doc) return ''
  const refs = await prisma.docReference.findMany({
    where: { userId, docId },
    orderBy: { createdAt: 'asc' },
  })
  // #writing-cost: 参考材料按用户消息相关性裁剪 — 只注入命中的
  // 文件(label/文件名关键词匹配),其余降级为"仅文件名"占位;避免
  // 每次轮询都全量提取所有参考正文(多文件时成本与 TTFB 飙升)。
  // 匹配失败时保留前 N 个(有正文优先),保证模型始终有上下文可用。
  const allRefs: Array<{ id?: string; label?: string | null; snapshot?: string | null; refType?: string | null }> = refs || []
  const msgText = String(messageText || '')
  const maxFiles = CONTEXT_CONFIG.scene.docRefFilesMax
  let refsToInject = allRefs
  if (allRefs.length > maxFiles) {
    const scored = allRefs.map((r) => {
      const label = String(r.label || r.snapshot || '')
      let score = 0
      if (msgText && label && msgText.toLowerCase().includes(label.toLowerCase())) score = 10
      else if (msgText && label) {
        // 部分词命中(label 的子串出现在消息中)
        const words = label.toLowerCase().split(/[\s._-]+/).filter((w) => w.length > 2)
        if (words.some((w) => msgText.toLowerCase().includes(w))) score = 5
      }
      return { r, score }
    })
    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, maxFiles)
    const withBody = top.some((x) => x.score > 0)
    if (withBody) {
      // 命中时:命中文件全量 + 其余降级为文件名占位(列表可见,不注入正文)。
      refsToInject = top.map((x) => x.r)
      const placeholder = allRefs
        .filter((r) => !top.some((t) => t.r.id === r.id))
        .map((r) => ({ ...r, snapshot: `[未注入正文 — 参考文件 ${r.label || r.snapshot || r.id} 未命中当前问题]` }))
      refsToInject = [...refsToInject, ...placeholder]
    } else {
      refsToInject = top.map((x) => x.r)
    }
  }
  // #fix: 上传文件引用(PDF/DOCX/txt)按文件名定位上传并注入提取的
  // 正文,LLM 才能真正读到稿件内容(此前只有文件名)。
  const { blocks: refBlocks } = await buildDocReferenceBlocks(userId, refsToInject || [], {
    // #fix: fileIndex 优先 + 上传目录文件名兜底 — 用户上传的文件
    // 一定在磁盘上,正文注入不依赖 fileIndex 表是否有记录。
    findFileByName: async (name) => findUploadFileByName(userId, name),
    // #fix 2026-09: 逐文件子进度 — 参考材料提取可达分钟级。
    onProgress: (i, total, label) => stage?.(`正在解析参考材料 ${i}/${total}：${String(label).slice(0, 40)}`),
    // #833: 参考材料超预算时按用户指名章节定位注入。
    userText: messageText,
  })
  const refBlock = refBlocks.join('\n\n')

  // #fix: 文件类参考材料未解析出正文时(如上传未入库),模型手里只有
  // 文件名,会误拿文件名调 ocr_image(只接受图片 file_id)而报错。
  // 明确引导:读 PDF/DOCX 正文用 import_reference,不用 ocr_image。
  // #699: 全部场景规则外置 writing-prompts.ts — 本文件只做组装。
  const refHint = refUnresolvedHint(allRefs.length > 0, refBlock)
  const refSource = refSourceRule(allRefs.length > 0)

  // #fix: 长文档分步润色 — 混合分段:有 markdown 标题按章节切,
  // 无标题按段落+token 长度兜底。文档超预算时按焦点段注入
  // (用户"继续"/"编辑第 N 段"切换焦点),模型始终只编辑可见段。
  const docText = String(doc.body || '')
  const sections = splitDocumentSections(docText, CONTEXT_CONFIG.scene.docSectionTokens)
  const docFits = estimateTokens(docText) <= CONTEXT_CONFIG.scene.docBodyTokens
  // #989 Phase 2: 结构清单行带节 ID(section id 查询在下方 projection 装载后
  // 才可用 — inventory 改为惰性函数)。
  let inventory = ''
  const buildInventory = () => {
    if (inventory) return inventory
    inventory = sections.sections
      .map((s) => {
        const id = sectionIdOf.next(s.title || '')
        return `${s.index}. ${id ? `[sec:${id}] ` : ''}${s.title || `第 ${s.index} 段`}`
      })
      .join('\n')
    return inventory
  }

  // #693: 选中即引用 — 用户选中的文本(来自编辑器选区,与 body 同源)
  // 优先成为编辑目标:注入独立上下文块,焦点段定位到包含它的段。
  const selection = typeof input.rawSelection === 'string' && input.rawSelection.trim() ? input.rawSelection.trim() : null
  let selectionSection: { index: number; title: string } | null = null

  let focus = 1
  let focusTitle = ''
  if (!docFits && sections.sections.length > 0) {
    if (selection) {
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
      const needle = norm(selection.slice(0, 200))
      const idx = sections.sections.findIndex((s) => norm(s.content).includes(needle))
      if (idx >= 0) {
        focus = idx + 1
        focusTitle = sections.sections[idx].title
        selectionSection = { index: focus, title: focusTitle }
      }
    }
    if (focusTitle === '') {
      // #927 拆分:焦点记忆(上一条 assistant 回复)由调用方显式传入。
      focus = resolveDocumentFocus(msgText, sections.sections, input.lastAssistantContent ?? undefined)
      const focused = sections.sections[focus - 1]
      if (focused) focusTitle = focused.title
    }
    // #868: 焦点段原文回填(未截断版 — bodyInjection 走 fitTextToTokens
    // 可能截断,工具侧定位必须用完整原文)。
    editHint.focusSectionContent = sections.sections[focus - 1]?.content ?? null
    editHint.focusIndex = focus
    editHint.focusTitle = focusTitle
  }
  // #868: 选中文本始终回填(短文档也受益于选区优先定位;未截断原文)。
  editHint.selectionText = selection

  // #989 Phase 2: 投影装载(存读校验 body_hash,不符/缺失确定性重建) —
  // 全文模式标题行挂 [sec:...];长文档模式结构清单/焦点段头带节 ID。
  const projection = loadProjection(docText, doc.blockProjection)
  const sectionIdOf = makeSectionIdResolver(projection)

  const bodyInjection = docFits
    ? withSectionIds(fitTextToTokens(docText, CONTEXT_CONFIG.scene.docBodyTokens), projection)
    : fitTextToTokens(sections.sections[focus - 1]?.content || docText, CONTEXT_CONFIG.scene.docBodyTokens)

  // #fix: 文档为空 + 参考材料有内容 — 分步润色:直接开始第一步,
  // 调用 edit_document 的 old_text/new_text 把参考资料第一部分的
  // 润色结果写回草稿(正文为空时工具会自动先导入唯一的参考材料),
  // 然后询问用户是否继续下一部分。禁止停在"要不要先导入"。
  const rules = documentRules({ docFits, selection, docBodyEmpty: !docText.trim(), selectionSection })

  // #927 item 2: 五条静态规则上移到文档正文之前的稳定段(原先挂在段尾,
  // 48K 正文之后注意力衰减);规则串本身不改,顺序保持
  // FORMAT → CHART → REVISION → CITATION → CONFIRM。
  // CHART/CITATION 按回合诉求门控(见 shouldInjectChartCitationRules)。
  const wantChartCitation = shouldInjectChartCitationRules({ hasRefs: allRefs.length > 0, messageText: msgText })
  // #971: 任务清单稳定段 — 活跃清单在文档正文之前注入（注意力位置
  // 同 #927 item 2 的规则前置逻辑）;无清单时为空串。闸门 2 的
  // hasActivePlan 在此一并取得（PLAN_RULE 门控用）。
  const activePlan = await loadActivePlan(userId, `doc-${docId}`).catch(() => null)
  const planBlock = renderPlanBlock(activePlan)

  const staticRules = [
    FORMAT_RULE,
    // #989 Phase 2: 节引用纪律常驻 — ID 可见即优先确定性节编辑。
    SECTION_EDIT_RULE,
    ...(wantChartCitation ? [CHART_RULE] : []),
    REVISION_RULE,
    ...(wantChartCitation ? [CITATION_RULE] : []),
    CONFIRM_RULE,
    // #976: PLAN_RULE 常驻 — 何时建清单归模型意图判断（工具侧 <3 步硬闸
    // 兜底,防 #806 打太极），不做回合门控 hardcode（#979 复盘修正）。
    PLAN_RULE,
  ].join('\n\n')

  // #773: deck 资产上下文可见性 — deck 存在时注入 ## Current Deck
  // (markdown 化表示,有界),模型才能执行"把第 3 页拆成两页"类请求
  // (走 edit_deck,slide_index 定位);与 #777 上传 pptx 联动。
  let deckBlock = ''
  if (doc.deck) {
    try {
      const deckJson = JSON.parse(String(doc.deck)) as {
        title?: string
        slides?: Array<{ title?: string; content?: Array<{ type?: string; text?: string; style?: string; url?: string; caption?: string; ref?: string }> }>
      }
      const deckLines: string[] = []
      if (deckJson.title) deckLines.push(`标题：${deckJson.title}`)
      const slides = Array.isArray(deckJson.slides) ? deckJson.slides : []
      slides.forEach((s, i) => {
        deckLines.push(`${i + 1}. ${String(s?.title || '未命名页').slice(0, 200)}`)
        for (const c of Array.isArray(s?.content) ? s.content : []) {
          if (c?.type === 'image') deckLines.push(`   ![${String(c.caption || '')}](${String(c.url || c.ref || '')})`)
          else if (typeof c?.text === 'string') deckLines.push(`   - ${c.text.slice(0, 200)}`)
        }
      })
      const deckMd = fitTextToTokens(deckLines.join('\n'), CONTEXT_CONFIG.scene.docBodyTokens / 2)
      deckBlock = `\n\n## Current Deck（AI 编排的 PPT 资产 — 与正文独立,编辑它不会改动正文）\n页码定位用于 edit_deck 的 slide_index(1-based):\n${deckMd}`
    } catch {
      deckBlock = ''
    }
  }

  // #927 item 1: 选区块注入 —
  // - selectionSection 命中(长文档选区已定位进焦点段):焦点段正文上方
  //   已含选区原文,不再重复注入;改锚点+定位提示(模型可定位)。
  // - 其余情况:注入选区原文(带 4k token 预算截断 + 标注)。
  let selectionBlock = ''
  if (selection && selectionSection) {
    // 锚点仅保留选区开头 40 字符(定位用) — 不重复注入选区原文本身。
    const anchor = selection.length > 40 ? `${selection.slice(0, 40)}…` : selection
    selectionBlock = `## 用户选中文本\n[选中文本已包含在上方「当前编辑段落」（第 ${selectionSection.index} 段${selectionSection.title ? `「${selectionSection.title}」` : ''}）的原文中,此处不再重复展示。编辑时从该段内以下列选区开头为锚点定位,并逐字复制 old_text(空格/换行差异会被自动忽略):「${anchor}」]\n\n`
  } else if (selection) {
    selectionBlock = `## 用户选中文本\n[用户选中的文本 — 如需修改请从此处逐字复制 old_text(空格/换行差异会被自动忽略)。]\n${fitSelectionForPrompt(selection)}\n\n`
  }

  // #989 Phase 2: 焦点段头带节 ID — 模型可用 target_section 确定性编辑本节。
  const focusId = sectionIdOf.peek(focusTitle || '')
  return `${planBlock}\n\n## Current Document\n标题：${doc.title}（正文约 ${Math.round(docText.replace(/\s+/g, ' ').length / 2)} 字）\n\n${staticRules}\n\n${docFits ? '' : `## 文档结构（共 ${sections.sections.length} 段,按${sections.mode === 'heading' ? '章节' : '长度'}划分;行内 [sec:...] 为节 ID,edit_document 用 target_section 引用）\n${buildInventory()}\n\n## 当前编辑段落（第 ${focus}/${sections.sections.length} 段${focusTitle ? `「${focusTitle}」` : ''}${focusId ? `— 节 ID [sec:${focusId}]` : ''}）\n`}${bodyInjection}\n\n${selectionBlock}## Reference Materials\n${refBlock || '(none)'}${refHint}\n\n${refSource}\n\n${rules}${deckBlock}`
}
