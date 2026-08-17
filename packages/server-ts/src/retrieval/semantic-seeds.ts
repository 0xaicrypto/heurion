/**
 * #562 — seed utterances for the semantic intent router.
 *
 * Built from the #549-#558 truth matrix plus hand-written variants (Chinese
 * first, bilingual). These drive centroid construction; the SAME samples are
 * the offline evaluation set (see tests/unit/semantic-intent-router.test.ts).
 * New expressions found in production (#560/#561 feedback loop) should be
 * appended here and centroids rebuilt.
 */

export const SEMANTIC_GENERATE_SEEDS: string[] = [
  // 明确生成请求（#549/#557 真值样本）
  '帮我生成一份出院小结 docx',
  '生成一份病例总结',
  '把表格导出为 PDF',
  '请给我做一个 PPT 汇报这个病例',
  '用 docx 把这份病历整理成文档',
  '帮我做个肺癌的幻灯片汇报',
  '帮我做一个 PPT',
  '帮我生成一个表格',
  '把检查结果整理成表格',
  '导出这个月的病例汇总 Excel',
  '帮我生成一份 PDF 病历摘要',
  '把 KM 曲线画出来',
  '生成一张疗效对比图',
  '做个 PPT 用于下周查房',
  '帮我起草一份知情同意书 docx',
  '生成药品说明书文档',
  '帮我做一份出院小结的 Word',
  '请生成一个 PPT',
  '帮我生成一张图表',
  '把随访数据做成饼图',
  '将这份病例制作成演示文稿',
  '帮我输出一份病历文档',
  '生成化疗方案汇总表',
  '帮我做一份入排标准核对表',
  '把患者清单导出成 Excel',
  '做一张生存分析图',
  '帮我生成出院小结模板',
  '制作一份病例汇报 PPT',
  '把这份数据做成柱状图',
  '帮我创建一份患者随访记录表',
  // 英文变体
  'generate a discharge summary docx',
  'make me a PPT about this case',
  'export this table as PDF',
  'create a word document for this patient',
  'export the data to excel',
  'please generate a presentation for the ward round',
  'make a chart of the survival curve',
  'generate a case summary document',
]

export const SEMANTIC_VETO_SEEDS: string[] = [
  // 编辑/润色类（#551/#552/#557）
  '帮我润色修改一下这篇论文',
  '改一下这份病例总结',
  '帮我完善那份出院小结',
  '把论文的结论部分重写一遍',
  '把这篇论文排版成 Word 发我',
  '帮我把 PPT 里第三页的图表改一下',
  'polish this manuscript',
  'revise the conclusion section',
  'edit the discharge summary',
  '这段报告写得太长了，帮我精简一下',
  '帮我修改一下病历里的错别字',
  '出院小结需要补充用药建议',
  '这份论文的讨论部分帮我改改',
  '把 PPT 的配色调整一下',
  '帮我改一下表格里的单位',
  '重新整理一下这段文字的格式',
  // 讨论/解读类（#549/#558-issue）
  '这个表格的数字怎么来的',
  '帮我做一下脑电图的分析',
  '上次那个 PPT 讲了什么',
  '这个图怎么解读',
  '分析一下 KM 曲线',
  '为什么这条曲线这么陡',
  '这个病人最近怎么样',
  '给我总结一下这个病人的治疗经过',
  '帮我补一份近期随访报告',
  '给我整理一个月度总结',
  '这个数据准确吗',
  '你觉得这个方案怎么样',
  '帮我看看这个检查结果',
  '这个治疗方案有没有文献支持',
  '上次说的 km curve 数据准确吗',
  '帮我分析一下这次复查的指标变化',
  '解释一下这个图的含义',
  '这个病人预后如何',
  '为什么这次的治疗效果不明显',
  '这个方案的副作用有哪些',
  '给我讲讲这个病例的难点',
  '这个检查结果需要进一步确认吗',
  // 英文变体
  'the numbers in this table look wrong',
  'how do I interpret this curve',
  'why is this curve so steep',
  'what does this slide mean',
  'summarize the treatment history for me',
]
