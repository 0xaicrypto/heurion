/**
 * #849/D5 — 中科院《国际期刊预警名单》年度快照(医学相关子集)。
 *
 * 诚实性说明:本文件为人工维护的医学相关子集快照,不是官方完整名单的镜像。
 * 完整名单每年由中科院文献情报中心发布,应人工核对后更新(更新时改动
 * SNAPSHOT_EDITION 并逐条确认 asOf/note)。历史预警但已不在最新名单的刊,
 * note 中标注来源年份 — 红线防护宁可错报不可漏报,展示时附年份供人判断。
 */

export const SNAPSHOT_EDITION = '2025'

export interface WarningListEntry {
  name: string
  issn?: string
  edition: string
  note: string
}

const ENTRIES: WarningListEntry[] = [
  { name: 'Journal of Oncology', edition: '2021', note: '中科院预警名单(2021 版)收录;Hindawi 大规模撤稿后已停刊' },
  { name: 'Oxidative Medicine and Cellular Longevity', edition: '2023', note: '中科院预警名单(2023 版)收录;Hindawi 系,已停刊' },
  { name: 'BioMed Research International', edition: '2023', note: '中科院预警名单(2023 版)收录;Hindawi 系,已停刊' },
  { name: 'Disease Markers', edition: '2023', note: '中科院预警名单(2023 版)收录;Hindawi 系,已停刊' },
  { name: 'Contrast Media & Molecular Imaging', edition: '2023', note: '中科院预警名单(2023 版)收录;Hindawi 系,已停刊' },
  { name: 'Journal of Healthcare Engineering', edition: '2023', note: '中科院预警名单(2023 版)收录;Hindawi 系,已停刊' },
  { name: 'Computational Intelligence and Neuroscience', edition: '2023', note: '中科院预警名单(2023 版)收录;Hindawi 系,已停刊' },
  { name: 'Journal of Environmental and Public Health', edition: '2023', note: '中科院预警名单(2023 版)收录;Hindawi 系,已停刊' },
  { name: 'Scanning', edition: '2023', note: '中科院预警名单(2023 版)收录;Hindawi 系,已停刊' },
  { name: 'Journal of Nanomaterials', edition: '2022', note: '中科院预警名单(2022 版)收录;Hindawi 系,已停刊' },
  { name: 'Bioengineered', edition: '2024', note: '中科院预警名单(2024 版)收录' },
  { name: 'Journal of Nanobiotechnology', edition: '2024', note: '中科院预警名单(2024 版)收录' },
  { name: 'Medicine', edition: '2023', note: '中科院预警名单(2023 版)收录(Wolters Kluwer);投稿量大、审稿周期长,建议人工复核最新名单' },
]

export const CAS_WARNING_LIST = {
  edition: SNAPSHOT_EDITION,
  asOf: '2025-02',
  entries: ENTRIES,
}

/** 归一化刊名用于匹配(小写、去标点、压空格)。 */
export function normalizeJournalName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').trim()
}
