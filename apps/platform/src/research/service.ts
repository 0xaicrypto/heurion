import type { DatasetService } from '../datasets/service.ts'
import type { Store, StudyRow } from '../store/db.ts'

/**
 * 临床研究项目：把研究方案、数据集、分析、稿件放在一起。
 * - 文档（方案 / 论文 / 幻灯片）与数据集经「归入」进研究，各自只属于一个研究；归入研究的文档不出现在写作的文档列表里（docs.context）。
 * - 分析不用手工维护：用这个研究的数据集画出来的图（带分析来源的资产）自动汇总。
 * - 删除研究：里面的文档一起进回收站（可恢复），数据集仍在「全部数据集」里。
 * - 归属按用户（与文档、数据集一致）；以后加研究团队协作时改按租户 + 成员。
 * 入组患者（从患者库按条件筛选）见 cohort.ts：入组关系在机构的患者库里，不进 study_items。
 */

export const DESIGNS: Record<NonNullable<StudyRow['design']>, string> = {
  retrospective_cohort: '回顾性队列', prospective_cohort: '前瞻性队列', rct: '随机对照试验', case_control: '病例对照', cross_sectional: '横断面', other: '其他',
}
export const STATUSES: Record<StudyRow['status'], string> = { planning: '筹备中', ongoing: '进行中', completed: '已完成' }
export const DOC_ROLES: Record<string, string> = { protocol: '研究方案', manuscript: '论文', slides: '幻灯片', other: '其他文档' }

export class StudyError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 = 400) { super(message) }
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export class StudyService {
  /** 删除研究时的回调（清掉患者库里的入组关系，见 cohort.ts） */
  onRemove: ((owner: string, id: string) => void) | null = null

  constructor(private readonly store: Store, private readonly datasets?: DatasetService) {}

  /** 研究本身（只能是自己的；别人的当不存在）。 */
  get(owner: string, id: string): StudyRow { return this.own(owner, id) }

  private own(owner: string, id: string): StudyRow {
    const s = this.store.getStudy(id)
    if (!s || s.owner !== owner) throw new StudyError('not_found', '研究不存在', 404)
    return s
  }

  list(owner: string) {
    return this.store.listStudies(owner).map(s => {
      const items = this.store.studyItems(s.id)
      return { ...s, docs: items.filter(i => i.kind === 'doc').length, datasets: items.filter(i => i.kind === 'dataset').length }
    })
  }

  create(owner: string, input: { title?: unknown; design?: unknown; status?: unknown; summary?: unknown }): StudyRow {
    const title = clean(input.title, 120)
    if (!title) throw new StudyError('bad_title', '研究名称不能为空')
    return this.store.addStudy({ owner, title, design: design(input.design), status: status(input.status) ?? 'planning', summary: clean(input.summary, 4000) || null })
  }

  update(owner: string, id: string, patch: { title?: unknown; design?: unknown; status?: unknown; summary?: unknown }): StudyRow {
    this.own(owner, id)
    const next: Parameters<Store['updateStudy']>[1] = {}
    if (patch.title !== undefined) { const t = clean(patch.title, 120); if (!t) throw new StudyError('bad_title', '研究名称不能为空'); next.title = t }
    if (patch.design !== undefined) next.design = design(patch.design)
    if (patch.status !== undefined) { const st = status(patch.status); if (!st) throw new StudyError('bad_status', '状态只能是 planning / ongoing / completed'); next.status = st }
    if (patch.summary !== undefined) next.summary = clean(patch.summary, 4000) || null
    this.store.updateStudy(id, next)
    // 研究改名：归入文档的归属标签跟着更新
    if (next.title) for (const i of this.store.studyItems(id).filter(i => i.kind === 'doc')) this.store.setDocContext(i.ref_id, { kind: 'study', study_id: id, title: next.title, role: i.role })
    return this.store.getStudy(id)!
  }

  /** 删除研究：研究里的文档（方案、论文、幻灯片）一起进回收站（可恢复，恢复后在文档列表里）；数据集保留在「全部数据集」。返回进回收站的文档数。 */
  remove(owner: string, id: string): { trashed_docs: number } {
    this.own(owner, id)
    let n = 0
    for (const i of this.store.studyItems(id)) if (i.kind === 'doc') {
      this.store.setDocContext(i.ref_id, null)
      const d = this.store.getDoc(i.ref_id)
      if (d && !d.deleted_at) { this.store.trashDoc(i.ref_id, true); n++ }
    }
    this.onRemove?.(owner, id)
    this.store.deleteStudy(id)
    return { trashed_docs: n }
  }

  /** 把文档或数据集归入研究（只能是自己的；已在别的研究里时要先移出）。 */
  link(owner: string, id: string, input: { kind?: unknown; ref_id?: unknown; role?: unknown }): void {
    const s = this.own(owner, id)
    const kind = input.kind === 'doc' || input.kind === 'dataset' ? input.kind : null
    const ref = typeof input.ref_id === 'string' ? input.ref_id : ''
    if (!kind || !ref) throw new StudyError('bad_item', 'kind 只能是 doc / dataset，ref_id 必填')
    if (kind === 'doc') {
      const d = this.store.getDoc(ref)
      if (!d || d.owner !== owner || d.deleted_at) throw new StudyError('not_found', '文档不存在', 404)
      const ctx = d.context ? JSON.parse(d.context) as { kind: string } : null
      if (ctx?.kind === 'patient') throw new StudyError('in_patient', '这份文档属于一位患者（病例报告），不能归入研究', 409)
    } else {
      const ds = this.store.getDataset(ref)
      if (!ds || ds.owner !== owner) throw new StudyError('not_found', '数据集不存在', 404)
    }
    const cur = this.store.studyOf(kind, ref)
    if (cur?.study_id === id) return
    if (cur) throw new StudyError('in_other_study', `已经归在研究「${this.store.getStudy(cur.study_id)?.title ?? ''}」里，先从那里移出`, 409)
    const role = kind === 'dataset' ? 'data' : typeof input.role === 'string' && DOC_ROLES[input.role] ? input.role : 'other'
    this.store.addStudyItem({ study_id: id, kind, ref_id: ref, role })
    if (kind === 'doc') this.store.setDocContext(ref, { kind: 'study', study_id: id, title: s.title, role })
  }

  unlink(owner: string, id: string, kind: unknown, ref: string): void {
    this.own(owner, id)
    if (kind !== 'doc' && kind !== 'dataset') throw new StudyError('bad_item', 'kind 只能是 doc / dataset')
    if (!this.store.removeStudyItem(id, kind, ref)) throw new StudyError('not_found', '研究里没有这一项', 404)
    if (kind === 'doc') this.store.setDocContext(ref, null)
  }

  /** 研究的全部内容：文档（按角色）、数据集、自动汇总的分析。 */
  read(owner: string, id: string) {
    const s = this.own(owner, id)
    const items = this.store.studyItems(id)
    const docs = items.filter(i => i.kind === 'doc').flatMap(i => {
      const d = this.store.getDoc(i.ref_id)
      return d && !d.deleted_at ? [{ doc_id: d.id, title: d.title, kind: d.kind, role: i.role, updated_at: d.updated_at, added_at: i.added_at }] : []
    })
    const datasetIds = items.filter(i => i.kind === 'dataset').map(i => i.ref_id)
    const datasets = datasetIds.flatMap(dsId => {
      const d = this.store.getDataset(dsId)
      const o = d?.origin ? JSON.parse(d.origin) as { kind?: string; shape?: string } : null
      return d ? [{ dataset_id: d.id, name: d.name, format: d.format, rows: d.rows, cols: d.cols, status: d.status, updated_at: d.updated_at, version: d.version, cohort: o?.kind === 'cohort' ? { shape: o.shape ?? 'wide' } : null }] : []
    })
    const ids = new Set(datasetIds)
    const analyses = this.store.provenanceAssets(owner).filter(a => a.provenance.datasets.some(d => ids.has(d.id)))
      .map(a => ({ asset_id: a.id, name: a.name, created_at: a.created_at, datasets: a.provenance.datasets.filter(d => ids.has(d.id)).map(d => d.name), has_code: Boolean(a.provenance.code), code_path: a.provenance.code_path }))
    return { ...s, design_label: s.design ? DESIGNS[s.design] : null, status_label: STATUSES[s.status], docs, datasets, analyses }
  }

  /** 研究里可分析的数据集（研究文档里对话时自动带上）。 */
  readyDatasets(owner: string, id: string) {
    return this.read(owner, id).datasets.filter(d => d.status === 'ready')
  }
}

function design(v: unknown): StudyRow['design'] {
  return typeof v === 'string' && v in DESIGNS ? v as StudyRow['design'] : null
}
function status(v: unknown): StudyRow['status'] | null {
  return v === 'planning' || v === 'ongoing' || v === 'completed' ? v : null
}
