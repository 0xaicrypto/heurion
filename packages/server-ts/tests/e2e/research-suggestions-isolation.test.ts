import { describe, test, expect } from 'vitest'
import { getApp, authHeader, registerSecondUser } from '../setup.js'
import prisma from '../../src/common/prisma.js'

/**
 * #783 验收 — research-suggestions 两端点此前无 userId 作用域：
 * /patients/:hash/research-suggestions 不校验患者归属，
 * /research/suggestions/recent 全表捞 60 条 screening（跨租户泄露
 * 姓名缩写/verdict/reason）。修复后两端点只能看到自己名下
 * 研究（join ResearchStudy.userId）与患者的建议。
 */
describe('research suggestions isolation (#783)', () => {
  test('B 用户看不到 A 的患者建议,也拿不到 A 的 recent 汇总', async () => {
    const app = await getApp()
    const a = await authHeader()
    const b = await registerSecondUser()

    // A 创建患者 + 研究,并让患者对研究有一条 eligible 筛查
    const pat = await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...a, 'content-type': 'application/json' },
      payload: JSON.stringify({ initials: 'ISO' }),
    })
    const hash = JSON.parse(pat.payload).patient_hash

    const study = await app.inject({
      method: 'POST', url: '/api/v1/research/studies',
      headers: { ...a, 'content-type': 'application/json' },
      payload: JSON.stringify({ display_name: 'A 的研究', short_code: 'ISO783' }),
    })
    const studyId = JSON.parse(study.payload).study_id ?? JSON.parse(study.payload).id
    expect(studyId).toBeTruthy()

    await (prisma as any).researchScreening.create({
      data: {
        id: `scr_isolation_${Date.now()}`,
        studyId, patientHash: hash, initials: 'ISO',
        verdict: 'eligible', reason: 'isolation-check rev:1',
        criteriaResults: 'not-json-on-purpose', // 守卫:脏数据不得 500
        scannedAt: new Date().toISOString(),
      },
    })

    // A 能看到自己的建议(且脏 criteriaResults 不炸)
    const aOwn = await app.inject({
      method: 'GET', url: `/api/v1/patients/${hash}/research-suggestions`,
      headers: a,
    })
    expect(aOwn.statusCode).toBe(200)
    const aSuggestions = JSON.parse(aOwn.payload).suggestions
    expect(aSuggestions.some((s: any) => s.studyId === studyId)).toBe(true)

    // B 访问 A 的患者建议 → 404(患者不属于 B)
    const bPatient = await app.inject({
      method: 'GET', url: `/api/v1/patients/${hash}/research-suggestions`,
      headers: { authorization: `Bearer ${b.token}` },
    })
    expect(bPatient.statusCode).toBe(404)

    // B 的 recent 汇总不含 A 的筛查行
    const bRecent = await app.inject({
      method: 'GET', url: '/api/v1/research/suggestions/recent',
      headers: { authorization: `Bearer ${b.token}` },
    })
    expect(bRecent.statusCode).toBe(200)
    const bRows = JSON.parse(bRecent.payload).suggestions
    expect(bRows.some((s: any) => s.studyId === studyId || s.patientHash === hash)).toBe(false)

    // 清理
    await (prisma as any).researchScreening.deleteMany({ where: { studyId } })
    await (prisma as any).researchStudy.deleteMany({ where: { id: studyId } })
    await (prisma as any).patientRecord.deleteMany({ where: { hash } })
  })
})

/**
 * #899 验收 — /studies/:studyId/* 各端点此前缺归属校验（跨用户读写他人
 * 研究的入组/筛查/观察/评估/协议规则），修复后非属主一律 404。
 */
describe('research study access isolation (#899)', () => {
  test('B 访问 A 的 study 各端点一律 404', async () => {
    const app = await getApp()
    const a = await authHeader()
    const b = await registerSecondUser()

    const study = await app.inject({
      method: 'POST', url: '/api/v1/research/studies',
      headers: { ...a, 'content-type': 'application/json' },
      payload: JSON.stringify({ display_name: 'A 独享研究', short_code: 'IDOR899' }),
    })
    const studyId = JSON.parse(study.payload).study_id ?? JSON.parse(study.payload).id
    expect(studyId).toBeTruthy()

    const cases: Array<{ method: 'GET' | 'POST' | 'DELETE'; url: string }> = [
      { method: 'GET', url: `/api/v1/research/studies/${studyId}/roster` },
      { method: 'POST', url: `/api/v1/research/studies/${studyId}/enrollments` },
      { method: 'DELETE', url: `/api/v1/research/studies/${studyId}/enrollments/p_hash` },
      { method: 'GET', url: `/api/v1/research/studies/${studyId}/eligibility` },
      { method: 'POST', url: `/api/v1/research/studies/${studyId}/eligibility/rescan` },
      { method: 'GET', url: `/api/v1/research/studies/${studyId}/observations` },
      { method: 'GET', url: `/api/v1/research/studies/${studyId}/safety/stop-rule-status` },
      { method: 'GET', url: `/api/v1/research/studies/${studyId}/assessments` },
      { method: 'POST', url: `/api/v1/research/studies/${studyId}/assessments/visit1/complete` },
      { method: 'POST', url: `/api/v1/research/studies/${studyId}/import-protocol` },
      { method: 'POST', url: `/api/v1/research/studies/${studyId}/extract-rules` },
      { method: 'GET', url: `/api/v1/research/studies/${studyId}/protocol-rules` },
      { method: 'POST', url: `/api/v1/research/studies/${studyId}/protocol-rules/r1/confirm` },
      { method: 'DELETE', url: `/api/v1/research/studies/${studyId}/protocol-rules/r1` },
      { method: 'POST', url: `/api/v1/research/studies/${studyId}/screen/p_hash` },
      { method: 'POST', url: `/api/v1/research/studies/${studyId}/screen-all` },
    ]
    for (const c of cases) {
      const res = await app.inject({
        method: c.method,
        url: c.url,
        headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' },
        payload: c.method === 'POST' ? JSON.stringify({}) : undefined,
      })
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(404)
    }

    // 清理
    await (prisma as any).researchStudy.deleteMany({ where: { id: studyId } })
  })
})
