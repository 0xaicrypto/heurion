/**
 * Deterministic synonym-cluster vectorizer used to mock the embedding service
 * in tests (semantic-intent-router, intent-router integration).
 *
 * Each intent-bearing concept is a cluster (生成/制作/创建 …; 润色/完善/改写 …)
 * so it approximates how a real semantic embedder generalizes over
 * paraphrases, while staying fully deterministic in CI. One dimension per
 * cluster, value = 1 when the text contains any member term.
 */
const GEN_CLUSTERS = [
  ['生成', '制作', '创建', '输出', '做一份', '做一个'],
  ['导出', 'export'],
  ['docx', 'word', '文档', 'document'],
  ['pdf'],
  ['ppt', '幻灯片', '演示文稿', 'presentation'],
  ['表格', '图表', '图', 'table', 'chart', 'plot'],
  ['excel', '汇总', '汇总表'],
  ['绘制', '画', 'make'],
  ['模板'],
  ['曲线', '柱状图', '饼图', '生存分析图'],
]
const VETO_CLUSTERS = [
  ['润色', '完善', '改写', '重写', '修订', '精简', 'polish', 'rewrite', 'revise'],
  ['修改', '改', '调整', '排版', 'edit', 'fix', 'correct'],
  ['分析', '解读', '解释', '讲讲', 'interpret', 'explain', 'mean'],
  ['怎么', '为什么', '怎么样', 'how', 'why', 'wrong'],
  ['讨论', '总结', '整理', 'summarize', 'discuss'],
  ['看看', '准确', '预后', '副作用', '补充', '错别字', '配色', '单位', '格式'],
]
const ALL_CLUSTERS = [...GEN_CLUSTERS, ...VETO_CLUSTERS]

export function fakeEmbed(texts: string[]): number[][] {
  return texts.map((t) => {
    const lower = t.toLowerCase()
    const v = ALL_CLUSTERS.map((cluster) =>
      cluster.some((term) => lower.includes(term.toLowerCase())) ? 1 : 0,
    )
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
    return v.map((x) => x / norm)
  })
}
