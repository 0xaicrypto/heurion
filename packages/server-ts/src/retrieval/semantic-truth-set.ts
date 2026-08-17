/**
 * #562 — semantic router offline evaluation truth set.
 *
 * Drawn from the #549-#558 misroute history plus hand-written colloquial
 * variants. Used by scripts/semantic-router-eval.ts (real bge-m3 embedding)
 * and asserted by unit tests with the fake embedder.
 *
 * Safety property: generate samples must never classify as veto and vice
 * versa; low-confidence answers may fall through to the LLM ('uncertain').
 * Acceptance (#562): generate recall ≥ 0.9 on the real embedding service.
 */

export const SEMANTIC_TRUTH_GENERATE: string[] = [
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
  '请生成一个 PPT',
  '帮我生成一张图表',
  '把随访数据做成饼图',
  '将这份病例制作成演示文稿',
  '帮我输出一份病历文档',
  '生成化疗方案汇总表',
  '把患者清单导出成 Excel',
  '做一张生存分析图',
  '帮我生成出院小结模板',
  '制作一份病例汇报 PPT',
  '把这份数据做成柱状图',
  '帮我创建一份患者随访记录表',
  'generate a discharge summary docx',
  'make me a PPT about this case',
  'export this table as PDF',
  'please generate a presentation for the ward round',
]

export const SEMANTIC_TRUTH_VETO: string[] = [
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
  '上次说的 km curve 数据准确吗',
  '帮我分析一下这次复查的指标变化',
  '解释一下这个图的含义',
  '这个病人预后如何',
  '为什么这次的治疗效果不明显',
  '这个方案的副作用有哪些',
  'the numbers in this table look wrong',
  'how do I interpret this curve',
  'why is this curve so steep',
]
