import { describe, expect, it } from 'vitest'
import { StudyError, StudyService } from '../src/research/service.ts'
import { Store } from '../src/store/db.ts'

function env() {
  const store = new Store(':memory:')
  const svc = new StudyService(store)
  const doc = (owner: string, title: string) => store.createDoc({ owner, title, kind: 'doc', state: new Uint8Array() })
  const dataset = (owner: string, name: string) => {
    const d = store.addDataset({ owner, name, filename: `${name}.csv`, format: 'CSV', size: 1, sha256: name + owner })
    store.updateDataset(d.id, { status: 'ready', rows: 412, cols: 9 })
    return d
  }
  return { store, svc, doc, dataset }
}

describe('临床研究项目', () => {
  it('新建、归入方案 / 论文 / 数据集；归入的文档不在文档列表里；改名后文档归属跟着改；删除研究时文档进回收站', () => {
    const t = env()
    const s = t.svc.create('u1', { title: 'SGLT2 与肾功能', design: 'retrospective_cohort' })
    expect(s.status).toBe('planning')
    const protocol = t.doc('u1', '研究方案 v2')
    const paper = t.doc('u1', '论文初稿')
    const loose = t.doc('u1', '其他笔记')
    const ds = t.dataset('u1', '队列数据')
    t.svc.link('u1', s.id, { kind: 'doc', ref_id: protocol.id, role: 'protocol' })
    t.svc.link('u1', s.id, { kind: 'doc', ref_id: paper.id, role: 'manuscript' })
    t.svc.link('u1', s.id, { kind: 'dataset', ref_id: ds.id })
    expect(t.store.listDocs('u1').map(d => d.title)).toEqual(['其他笔记'])
    const r = t.svc.read('u1', s.id)
    expect([r.design_label, r.status_label]).toEqual(['回顾性队列', '筹备中'])
    expect(r.docs.map(d => [d.title, d.role]).sort()).toEqual([['研究方案 v2', 'protocol'], ['论文初稿', 'manuscript']])
    expect(r.datasets.map(d => [d.name, d.rows])).toEqual([['队列数据', 412]])
    expect(t.svc.list('u1')[0]).toMatchObject({ docs: 2, datasets: 1 })

    t.svc.update('u1', s.id, { title: 'SGLT2i 与 eGFR 下降', status: 'ongoing' })
    expect(JSON.parse(t.store.getDoc(protocol.id)!.context!)).toMatchObject({ kind: 'study', title: 'SGLT2i 与 eGFR 下降', role: 'protocol' })

    t.svc.unlink('u1', s.id, 'doc', paper.id)
    expect(t.store.listDocs('u1').map(d => d.title).sort()).toEqual(['其他笔记', '论文初稿'])
    // 删除研究：研究里的方案进回收站（可恢复，恢复后回到文档列表、不再带研究归属）；移出过的论文不受影响
    expect(t.svc.remove('u1', s.id)).toEqual({ trashed_docs: 1 })
    expect(t.store.listDocs('u1').map(d => d.title).sort()).toEqual(['其他笔记', '论文初稿'])
    expect(t.store.getDoc(protocol.id)!.deleted_at).toBeTruthy()
    t.store.trashDoc(protocol.id, false)
    expect(t.store.listDocs('u1')).toHaveLength(3)
    expect(t.store.getDataset(ds.id)).toBeTruthy()
    expect(t.svc.list('u1')).toEqual([])
    void loose
  })

  it('分析：用研究数据集画的图自动汇总（别的数据集的不算）', () => {
    const t = env()
    const s = t.svc.create('u1', { title: '研究' })
    const ds = t.dataset('u1', 'A'), other = t.dataset('u1', 'B')
    t.svc.link('u1', s.id, { kind: 'dataset', ref_id: ds.id })
    const at = new Date().toISOString()
    t.store.putAsset({ owner: 'u1', mime: 'image/png', name: 'km.png', bytes: new Uint8Array([1]), provenance: { code: 'print(1)', code_path: 'km.py', datasets: [{ id: ds.id, name: 'A', version: 1, rows: 412 }], turn_id: null, at } })
    t.store.putAsset({ owner: 'u1', mime: 'image/png', name: 'other.png', bytes: new Uint8Array([1]), provenance: { code: null, code_path: null, datasets: [{ id: other.id, name: 'B', version: 1, rows: 1 }], turn_id: null, at } })
    expect(t.svc.read('u1', s.id).analyses.map(a => [a.name, a.has_code, a.datasets])).toEqual([['km.png', true, ['A']]])
  })

  it('每样只属于一个研究；病例报告不能归入研究；别人的研究、文档、数据集都碰不到', () => {
    const t = env()
    const s1 = t.svc.create('u1', { title: '一' }), s2 = t.svc.create('u1', { title: '二' })
    const d = t.doc('u1', '方案')
    t.svc.link('u1', s1.id, { kind: 'doc', ref_id: d.id, role: 'protocol' })
    expect(() => t.svc.link('u1', s2.id, { kind: 'doc', ref_id: d.id })).toThrow('先从那里移出')
    const report = t.doc('u1', 'P-0001 病例报告')
    t.store.setDocContext(report.id, { kind: 'patient', patient_id: 'pt1', code: 'P-0001' })
    expect(() => t.svc.link('u1', s1.id, { kind: 'doc', ref_id: report.id })).toThrow('患者')

    const theirs = t.doc('u2', '别人的')
    expect(() => t.svc.read('u2', s1.id)).toThrow(StudyError)
    expect(() => t.svc.link('u1', s1.id, { kind: 'doc', ref_id: theirs.id })).toThrow('不存在')
    expect(() => t.svc.link('u2', s1.id, { kind: 'doc', ref_id: theirs.id })).toThrow('研究不存在')
    expect(() => t.svc.create('u1', { title: '  ' })).toThrow('名称')
  })
})
