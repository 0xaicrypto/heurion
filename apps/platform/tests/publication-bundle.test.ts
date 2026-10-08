import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import { TenantService } from '../src/auth/tenants.ts'
import { DatasetService, parseCsv } from '../src/datasets/service.ts'
import type { Ingest } from '../src/datasets/ingest.ts'
import { PublicationBundleService } from '../src/research/publication-bundle.ts'
import { StudyService } from '../src/research/service.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService, type Actor } from '../src/tenancy/patients.ts'

const dummyIngest: Ingest = async (_owner, src) => {
  return {
    csv: src,
    cleanup: () => {},
    profile: { ok: true, rows: 10, truncated: false, columns: [{ name: 'col1', type: 'text', missing: 0, unique: 1 }] }
  }
}

function setupEnv() {
  const store = new Store(':memory:')
  const tenants = new TenantService(store, { devMode: false })
  const keys = new TenantKeys(store, kekFrom({ secret: 'test-secret' }))
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'pb-pt-')), tenants, keys, store)
  const datasets = new DatasetService(store, mkdtempSync(join(tmpdir(), 'pb-ds-')), dummyIngest)
  const studies = new StudyService(store, datasets)
  const hosp = store.createTenant({ name: '国家医学中心', kind: 'org' })
  const user = store.createUser({
    username: 'pi_doctor',
    display_name: '课题组负责人',
    password_hash: 'hash',
    email: 'pi@hospital.org',
    tenant: { id: hosp.id, role: 'member' }
  })

  const actor: Actor = {
    userId: user.id,
    via: 'user',
  }

  const bundleService = new PublicationBundleService(studies, patients, datasets)
  return { store, studies, patients, datasets, bundleService, actor, user, hosp }
}

describe('SCI 投稿级成果包一键全量导出打包 (.zip) 测试', () => {
  it('1. buildBundle: 完整构建包含 12 项顶级成果资产的标准投稿 ZIP 包', async () => {
    const { studies, bundleService, actor, user } = setupEnv()

    // 创建课题研究
    const study = studies.create(user.id, {
      title: '晚期胃癌 3D 影像组学与分子标志物预后模型前瞻性多中心队列',
      design: 'prospective_cohort',
      summary: '评估基于 TotalSegmentator L3 骨骼肌质量指数 (SMI) 及 3D 影像组学特征构建的胃癌术后总生存率预测模型。'
    })

    const bundle = await bundleService.buildBundle(actor, study.id, {
      include_code: true
    })

    expect(bundle.filename).toContain(`SCI_Submission_Bundle_${study.id}`)
    expect(bundle.filename).toMatch(/\.zip$/)
    expect(bundle.totalFiles).toBe(12)
    expect(bundle.zipBuffer.length).toBeGreaterThan(10000)

    // 解压并深入校验每个文件
    const unzipped = unzipSync(bundle.zipBuffer)
    const fileNames = Object.keys(unzipped)
    expect(fileNames.length).toBe(12)

    // 1. Table 1 (.docx)
    expect(fileNames).toContain('Table1_Baseline_Characteristics.docx')
    const t1Bytes = unzipped['Table1_Baseline_Characteristics.docx']!
    expect(t1Bytes.length).toBeGreaterThan(1000)
    // 验证标准 PK zip magic bytes (OpenXML docx)
    expect(t1Bytes[0]).toBe(0x50) // 'P'
    expect(t1Bytes[1]).toBe(0x4b) // 'K'

    // 2. Figure 1: CONSORT 2010 Flowchart (.svg)
    expect(fileNames).toContain('Figure1_CONSORT_Flowchart.svg')
    const fig1Svg = new TextDecoder().decode(unzipped['Figure1_CONSORT_Flowchart.svg']!)
    expect(fig1Svg).toContain('<svg')
    expect(fig1Svg).toContain('CONSORT 2010 Participant Flow Diagram')
    expect(fig1Svg).toContain('</svg>')

    // 3. Figure 2: Love Plot (.svg)
    expect(fileNames).toContain('Figure2_Love_Plot_Covariate_Balance.svg')
    const fig2Svg = new TextDecoder().decode(unzipped['Figure2_Love_Plot_Covariate_Balance.svg']!)
    expect(fig2Svg).toContain('<svg')
    expect(fig2Svg).toContain('Love Plot')
    expect(fig2Svg).toContain('Standardized Mean Differences')
    expect(fig2Svg).toContain('</svg>')

    // 4. Figure 3: Kaplan-Meier Survival Curve (.svg)
    expect(fileNames).toContain('Figure3_Kaplan_Meier_Survival_Curve.svg')
    const fig3Svg = new TextDecoder().decode(unzipped['Figure3_Kaplan_Meier_Survival_Curve.svg']!)
    expect(fig3Svg).toContain('<svg')
    expect(fig3Svg).toContain('Kaplan-Meier Survival Analysis')
    expect(fig3Svg).toContain('No. at Risk')
    expect(fig3Svg).toContain('</svg>')

    // 5. Figure 4: Cox Forest Plot (.svg)
    expect(fileNames).toContain('Figure4_Cox_Forest_Plot.svg')
    const fig4Svg = new TextDecoder().decode(unzipped['Figure4_Cox_Forest_Plot.svg']!)
    expect(fig4Svg).toContain('<svg')
    expect(fig4Svg).toContain('</svg>')

    // 6. Figure 5: Nomogram Survival Predictor (.svg)
    expect(fileNames).toContain('Figure5_Nomogram_Survival_Predictor.svg')
    const fig5Svg = new TextDecoder().decode(unzipped['Figure5_Nomogram_Survival_Predictor.svg']!)
    expect(fig5Svg).toContain('<svg')
    expect(fig5Svg).toContain('Nomogram')
    expect(fig5Svg).toContain('Points')
    expect(fig5Svg).toContain('Total Points')
    expect(fig5Svg).toContain('1-Year Survival')
    expect(fig5Svg).toContain('3-Year Survival')
    expect(fig5Svg).toContain('5-Year Survival')
    expect(fig5Svg).toContain('</svg>')

    // 7. Figure 6A: ROC Diagnostic Performance (.svg)
    expect(fileNames).toContain('Figure6A_ROC_Performance.svg')
    const fig6aSvg = new TextDecoder().decode(unzipped['Figure6A_ROC_Performance.svg']!)
    expect(fig6aSvg).toContain('<svg')
    expect(fig6aSvg).toContain('ROC Diagnostic Performance')
    expect(fig6aSvg).toContain('Sensitivity')
    expect(fig6aSvg).toContain('1 - Specificity')
    expect(fig6aSvg).toContain('</svg>')

    // 8. Figure 6B: Decision Curve Analysis (DCA) (.svg)
    expect(fileNames).toContain('Figure6B_Decision_Curve_Analysis_DCA.svg')
    const fig6bSvg = new TextDecoder().decode(unzipped['Figure6B_Decision_Curve_Analysis_DCA.svg']!)
    expect(fig6bSvg).toContain('<svg')
    expect(fig6bSvg).toContain('Decision Curve Analysis')
    expect(fig6bSvg).toContain('Net Benefit')
    expect(fig6bSvg).toContain('Treat All')
    expect(fig6bSvg).toContain('Treat None')
    expect(fig6bSvg).toContain('</svg>')

    // 9. Manuscript Draft (.md)
    expect(fileNames).toContain('Manuscript_Statistical_Methods_and_Results.md')
    const msText = new TextDecoder().decode(unzipped['Manuscript_Statistical_Methods_and_Results.md']!)
    expect(msText).toContain('Statistical Methods & Results Section Draft')
    expect(msText).toContain('CONSORT 2010')
    expect(msText).toContain('STROBE')
    expect(msText).toContain('Table 1')
    expect(msText).toContain('Love Plot')
    expect(msText).toContain('Kaplan-Meier')
    expect(msText).toContain('Nomogram')
    expect(msText).toContain('Receiver Operating Characteristic')
    expect(msText).toContain('Decision Curve Analysis')

    // 10. STROBE Statement Checklist (.md)
    expect(fileNames).toContain('STROBE_Statement_Checklist.md')
    const strobeText = new TextDecoder().decode(unzipped['STROBE_Statement_Checklist.md']!)
    expect(strobeText).toContain('STROBE Statement')
    expect(strobeText).toContain('Item No.')
    expect(strobeText).toContain('Title and Abstract')
    expect(strobeText).toContain('Give the source of funding and the role of the funders')

    // 11. Statistical Reproducibility Script (.py)
    expect(fileNames).toContain('Statistical_Reproducibility_Script.py')
    const pyText = new TextDecoder().decode(unzipped['Statistical_Reproducibility_Script.py']!)
    expect(pyText).toContain('#!/usr/bin/env python3')
    expect(pyText).toContain('import numpy as np')
    expect(pyText).toContain('import pandas as pd')
    expect(pyText).toContain('from lifelines import KaplanMeierFitter')
    expect(pyText).toContain('def compute_e_value(')

    // 12. README Manifest (.txt)
    expect(fileNames).toContain('README_Submission_Manifest.txt')
    const manifestText = new TextDecoder().decode(unzipped['README_Submission_Manifest.txt']!)
    expect(manifestText).toContain('HEURION CLINICAL RESEARCH COLLABORATIVE PLATFORM')
    expect(manifestText).toContain('SCI PUBLICATION-GRADE SUBMISSION BUNDLE')
    expect(manifestText).toContain('BUNDLE INVENTORY')

    // 全套资产严格零 Emoji 检查
    const allText = [fig1Svg, fig2Svg, fig3Svg, fig4Svg, fig5Svg, fig6aSvg, fig6bSvg, msText, strobeText, pyText, manifestText].join('\n')
    expect(allText).not.toMatch(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u)
  })
})
