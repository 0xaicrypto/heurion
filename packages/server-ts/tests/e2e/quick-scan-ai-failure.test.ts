import { describe, test, expect, vi } from 'vitest'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import { analyzeWithGeminiVision } from '../../src/modules/patients/dicom-scanner.js'

/**
 * #1104-gap1 caller-level 回归锁: quick-scan 路由把 vision 分析结果写入
 * 患者临床记录(appendChiefComplaint / findings.ai_analysis)前必须区分
 * 成功/失败。此前 vision fn resolve 中文失败 marker 字符串、调用方只在
 * promise REJECT 时置 aiFailed — 失败文本被当真实 AI 结论写入临床记录。
 * 现在 vision fn 契约为 { ok:true, text } | { ok:false, error };mock 它
 * resolve {ok:false} 断言失败分支: marker 串不落入 chiefComplaint。
 */
vi.mock('../../src/modules/patients/dicom-scanner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/patients/dicom-scanner.js')>()
  return { ...actual, analyzeWithGeminiVision: vi.fn() }
})

describe('quick-scan AI 失败不落入患者临床记录 (#1104-gap1)', () => {
  test('vision 失败(ok:false)→ aiFailed 走失败分支,marker 串不写入 chiefComplaint', async () => {
    vi.mocked(analyzeWithGeminiVision).mockResolvedValue({
      ok: false,
      error: '（影像分析失败：ECONNREFUSED — 请重试或人工判读）',
    })

    const app = await getApp()
    const userId = await getAuthUserId()

    const create = await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { initials: 'AIF', age: 55, sex: 'M', chief_complaint: 'baseline complaint' },
    })
    const hash = JSON.parse(create.payload).patient_hash

    const scan = await app.inject({
      method: 'POST', url: '/api/v1/dicom/studies/mock_ct.dcm/quick-scan',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ patient_hash: hash }),
    })
    expect(scan.statusCode).toBe(200)
    const scanBody = JSON.parse(scan.payload)
    expect(vi.mocked(analyzeWithGeminiVision)).toHaveBeenCalledWith(userId, 'mock_ct.dcm')
    // findings 不出现 ai_analysis(失败标记只做遥测)
    expect(scanBody.findings.find((f: any) => f.type === 'ai_analysis')).toBeUndefined()

    // 患者永久临床记录不得包含失败 marker / [AI Vision] 段
    const detail = await app.inject({
      method: 'GET', url: `/api/v1/dicom/patients/${hash}/detail`, headers: await authHeader(),
    })
    expect(detail.statusCode).toBe(200)
    const body = JSON.parse(detail.payload)
    expect(body.chief_complaint).toContain('baseline complaint')
    expect(body.chief_complaint).not.toContain('影像分析失败')
    expect(body.chief_complaint).not.toContain('[AI Vision]')
  }, 30000)

  test('vision 成功(ok:true)→ [AI Vision] 仍正常写入(正向对照,防修坏成功路径)', async () => {
    vi.mocked(analyzeWithGeminiVision).mockResolvedValue({
      ok: true,
      text: '右肺上叶小结节,建议随访',
    })

    const app = await getApp()
    await getAuthUserId()

    const create = await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { initials: 'AIOK', age: 40, sex: 'F', chief_complaint: 'cough' },
    })
    const hash = JSON.parse(create.payload).patient_hash

    const scan = await app.inject({
      method: 'POST', url: '/api/v1/dicom/studies/mock_ct.dcm/quick-scan',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ patient_hash: hash }),
    })
    expect(scan.statusCode).toBe(200)
    expect(JSON.parse(scan.payload).findings.find((f: any) => f.type === 'ai_analysis')?.content).toContain('右肺上叶小结节')

    const detail = await app.inject({
      method: 'GET', url: `/api/v1/dicom/patients/${hash}/detail`, headers: await authHeader(),
    })
    const body = JSON.parse(detail.payload)
    expect(body.chief_complaint).toContain('[AI Vision]')
    expect(body.chief_complaint).toContain('右肺上叶小结节')
  }, 30000)
})
