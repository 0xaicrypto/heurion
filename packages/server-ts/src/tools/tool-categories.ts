/** #1146 循环依赖:工具分类集合下沉叶子模块(无任何导入)。 */
/**
 * #829: side-effect-free tools — the tool loop may run these in parallel
 * within one model round (they only read external state). Everything else
 * (write-backs, sends, renders that enqueue jobs, sub-agents, background
 * deferrals) stays serial to preserve ordering-sensitive flows.
 */
export const READ_ONLY_TOOLS = new Set([
  'search_node',
  'search_encounter',
  'search_past_chats',
  'search_medical_web',
  'fetch_article_summary',
  'visit_medical_site',
  'extract_fulltext',
  'search_citation',
  'load_data_table',
  'load_skill',
  'query_logs',
  'mcp_list_tools',
  'stat_describe',
  'stat_ttest',
  'stat_chisq',
  'stat_km',
  'stat_plot',
  'stat_ai',
])

/**
 * #835: 尽最大努力检索(best-effort retrieval)策略集 — 这些只读检索工具的
 * 失败不应阻断回合:连续失败 ≥2 次后从后续轮次的 tools 列表移除(模型物理
 * 上无法再重试),配合注入的错误指引,让模型基于已有上下文/自身知识继续
 * 完成任务,而不是烧完 5 轮后空手而归。写回/渲染/子代理工具绝不入集。
 */
export const BEST_EFFORT_RETRIEVAL_TOOLS = new Set([
  'search_node',
  'search_encounter',
  'search_past_chats',
  'search_medical_web',
  'fetch_article_summary',
  'visit_medical_site',
  'extract_fulltext',
  'search_citation',
  'load_data_table',
])
