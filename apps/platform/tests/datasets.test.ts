import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeIngest } from '../src/datasets/ingest.ts'
import { DatasetError, DatasetService, parseCsv } from '../src/datasets/service.ts'
import { Store } from '../src/store/db.ts'

// 用仓库里的 .venv-compute（与容器里 /opt/compute 同一组包）真实运行导入脚本；没有这个环境时跳过
const PY = fileURLToPath(new URL('../../../.venv-compute/bin/python3', import.meta.url))
const SCRIPT = fileURLToPath(new URL('../scripts/dataset_ingest.py', import.meta.url))
const real = existsSync(PY)

function env() {
  const store = new Store(':memory:')
  const dir = mkdtempSync(join(tmpdir(), 'heurion-datasets-'))
  const svc = new DatasetService(store, dir, makeIngest({ python: PY, script: SCRIPT }))
  return { store, svc }
}
const csv = (text: string) => new TextEncoder().encode(text)

describe.skipIf(!real)('数据集：导入与概况', () => {
  it('CSV 导入：列类型、缺失、摘要；重复上传返回已有的；不支持的格式报错', async () => {
    const t = env()
    const body = 'id,group,age,crp,visit\n1,A,62,12.5,2024-03-01\n2,B,55,,2024-04-11\n3,A,70,8.1,2024-05-02\n4,B,48,20.3,2024-06-15\n5,A,66,9.9,2024-07-20\n6,B,59,15.0,2024-08-30\n7,A,61,11.2,2024-09-09\n'
    const { dataset } = t.svc.upload('u1', '队列.csv', csv(body))
    expect(dataset.status).toBe('processing')
    await t.svc.idle()
    const d = t.svc.get('u1', dataset.id)
    expect([d.status, d.rows, d.cols, d.format, d.name]).toEqual(['ready', 7, 5, 'CSV', '队列'])
    const col = Object.fromEntries(d.columns.map(c => [c.name, c]))
    expect(col.group!.type).toBe('categorical')
    expect(col.crp!.type).toBe('numeric')
    expect(col.crp!.missing).toBe(1)
    expect(col.visit!.type).toBe('date')
    expect(t.svc.upload('u1', '另一个名字.csv', csv(body)).duplicate).toBe(true)
    expect(() => t.svc.upload('u1', 'x.pdf', csv('x'))).toThrow(DatasetError)
    expect(t.svc.preview('u1', d.id, 2)).toEqual({ header: ['id', 'group', 'age', 'crp', 'visit'], rows: [['1', 'A', '62', '12.5', '2024-03-01'], ['2', 'B', '55', '', '2024-04-11']] })
  })

  it('疑似身份信息：列名与取值都能标出；每列须删掉或确认，处理完才能给 AI 用', async () => {
    const t = env()
    const body = 'pid,姓名,contact,age,score\n1,张三,13812345678,62,1.5\n2,李四,13987654321,55,2.5\n3,王五,13700001111,48,3.0\n'
    const { dataset } = t.svc.upload('u1', 'phi.csv', csv(body))
    await t.svc.idle()
    const d = t.svc.get('u1', dataset.id)
    expect(d.status).toBe('review')
    expect(d.phi.map(p => p.name)).toEqual(['姓名', 'contact'])
    expect(d.phi[1]!.reason).toContain('手机号')
    expect(() => t.svc.readyCsv('u1', d.id)).toThrow('身份信息')
    await expect(t.svc.resolvePhi('u1', d.id, ['姓名'], [])).rejects.toThrow('contact')

    const done = await t.svc.resolvePhi('u1', d.id, ['姓名', 'contact'], [])
    expect([done.status, done.cols, done.columns.map(c => c.name)]).toEqual(['ready', 3, ['pid', 'age', 'score']])
    const { path } = t.svc.readyCsv('u1', d.id)
    expect(readFileSync(path, 'utf8')).not.toContain('张三')
    expect(readFileSync(path, 'utf8')).not.toContain('13812345678')
  })

  it('确认「不是身份信息」的列保留并记下；别人的数据集碰不到；删除连文件一起删', async () => {
    const t = env()
    const { dataset } = t.svc.upload('u1', 'a.csv', csv('name,value\nalpha,1\nbeta,2\n'))
    await t.svc.idle()
    expect(t.svc.get('u1', dataset.id).phi.map(p => p.name)).toEqual(['name'])
    const done = await t.svc.resolvePhi('u1', dataset.id, [], ['name'])
    expect([done.status, done.cols]).toEqual(['ready', 2])
    expect(JSON.parse(t.store.getDataset(dataset.id)!.profile!).phi_resolved.kept).toEqual(['name'])

    expect(() => t.svc.get('u2', dataset.id)).toThrow('不存在')
    expect(() => t.svc.readyCsv('u2', dataset.id)).toThrow('不存在')
    expect(t.svc.list('u2')).toEqual([])

    const updated = t.svc.update('u1', dataset.id, { name: '试验', labels: { value: '数值（mg/L）', nope: 'x' } })
    expect([updated.name, updated.labels]).toEqual(['试验', { value: '数值（mg/L）' }])
    const { path } = t.svc.readyCsv('u1', dataset.id)
    t.svc.remove('u1', dataset.id)
    expect(existsSync(path)).toBe(false)
  })

  it('解析失败的文件如实标为失败', async () => {
    const t = env()
    const { dataset } = t.svc.upload('u1', 'bad.xlsx', csv('这不是 Excel'))
    await t.svc.idle()
    const d = t.svc.get('u1', dataset.id)
    expect(d.status).toBe('failed')
    expect(d.error).toBeTruthy()
  })
})

describe('数据集：CSV 解析', () => {
  it('引号、转义引号、引号内换行与逗号', () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\n"line1\nline2",3\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['line1\nline2', '3']])
  })
})
