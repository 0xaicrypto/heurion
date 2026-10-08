import { describe, it, expect } from 'vitest'
import { renderConsortSvg, renderConsortMermaid, type ConsortDiagramData } from '../src/research/consort.ts'
import { calculateEValue, generateLovePlotSvg, type LovePlotConfig } from '../src/research/causal-inference.ts'
import { generateTable1FromData } from '../src/datasets/table1.ts'
import { exportTable1ToDocx } from '../src/datasets/table1-docx.ts'
import { unzipSync } from 'fflate'

describe('临床科研进阶套件测试 (Research Extensions)', () => {
  it('1. CONSORT 2010 矢量纳排筛选流向图生成验证', () => {
    const mockConsort: ConsortDiagramData = {
      title: 'DAPA-HF 试验人群 CONSORT 入组流向图',
      total_assessed: 4744,
      exclusions: [
        { reason: '未行增强薄层 CT (层厚 > 3mm)', count: 184 },
        { reason: '既往合并恶性肿瘤病史', count: 45 },
        { reason: '关键生化指标 (eGFR / NT-proBNP) 缺失', count: 57 },
      ],
      eligible_total: 1420,
      arms: [
        {
          name: '达格列净组 (Dapagliflozin 10mg qd)',
          allocated: 710,
          lost_to_followup: 4,
          discontinued: 12,
          analyzed: 694,
        },
        {
          name: '安慰剂对照组 (Placebo)',
          allocated: 710,
          lost_to_followup: 6,
          discontinued: 15,
          analyzed: 689,
        },
      ],
    }

    const svg = renderConsortSvg(mockConsort)
    expect(svg).toContain('<svg')
    expect(svg).toContain('DAPA-HF 试验人群 CONSORT 入组流向图')
    expect(svg).toContain('4,744')
    expect(svg).toContain('1,420')
    expect(svg).toContain('未行增强薄层 CT (层厚 &gt; 3mm): n = 184')
    expect(svg).toContain('达格列净组 (Dapagliflozin 10mg qd) (n = 710)')
    expect(svg).toContain('纳入最终疗效分析: n = 694')
    expect(svg).toContain('</svg>')

    const mermaid = renderConsortMermaid(mockConsort)
    expect(mermaid).toContain('graph TD')
    expect(mermaid).toContain('N = 4744')
    expect(mermaid).toContain('排除 n = 286')
    expect(mermaid).toContain('N = 1420')
  })

  it('2. VanderWeele E-value 混杂敏感度计算与抗辩论断验证', () => {
    // 验证 DAPA-HF 主要终点 HR = 0.74 (95% CI: 0.65 - 0.85)
    const res = calculateEValue({
      effect_type: 'HR',
      estimate: 0.74,
      ci_lower: 0.65,
      ci_upper: 0.85,
    })

    expect(res.effect_type).toBe('HR')
    expect(res.estimate).toBe(0.74)
    // 1 / 0.74 = 1.3514 -> E-value = 1.3514 + sqrt(1.3514 * 0.3514) = 1.3514 + 0.6891 = 2.04 ~ 2.06
    expect(res.e_value_point).toBeGreaterThanOrEqual(2.0)
    expect(res.e_value_point).toBeLessThanOrEqual(2.1)
    // Upper bound 0.85 -> 1 / 0.85 = 1.1765 -> E-value = 1.1765 + sqrt(1.1765 * 0.1765) = 1.1765 + 0.4557 = 1.63
    expect(res.e_value_ci).toBeGreaterThanOrEqual(1.58)
    expect(res.e_value_ci).toBeLessThanOrEqual(1.68)

    // 验证中英文自动生成的审稿抗辩文段
    expect(res.academic_defense_zh).toContain('VanderWeele E-value')
    expect(res.academic_defense_zh).toContain('未被观察测量的潜在残留混杂因素')
    expect(res.academic_defense_zh).toContain('高度的稳健性与抗偏倚能力')
    expect(res.academic_defense_en).toContain('robust causal resilience against potential unmeasured residual confounding')
  })

  it('3. Love Plot 协变量平衡收敛散点图生成验证', () => {
    const config: LovePlotConfig = {
      title: 'DAPA-HF 1:1 PSM 倾向评分匹配前后协变量平衡诊断图',
      smd_strict_threshold: 0.05,
      smd_loose_threshold: 0.10,
      covariates: [
        { name: 'age', label_zh: '年龄 (岁)', pre_smd: 0.18, post_smd: 0.028 },
        { name: 'female', label_zh: '女性比例', pre_smd: 0.14, post_smd: 0.019 },
        { name: 'lvef', label_zh: '左室射血分数 (LVEF)', pre_smd: 0.22, post_smd: 0.034 },
        { name: 'nt_pro_bnp', label_zh: '血清 NT-proBNP', pre_smd: 0.31, post_smd: 0.015 },
        { name: 'l3_smi', label_zh: 'L3 骨骼肌指数 (SMI)', pre_smd: 0.25, post_smd: 0.018 },
      ],
    }

    const svg = generateLovePlotSvg(config)
    expect(svg).toContain('<svg')
    expect(svg).toContain('DAPA-HF 1:1 PSM 倾向评分匹配前后协变量平衡诊断图')
    expect(svg).toContain('SMD = 0.10 (常规平衡警戒线)')
    expect(svg).toContain('SMD = 0.05 (严格随机化线)')
    expect(svg).toContain('L3 骨骼肌指数 (SMI)')
    expect(svg).toContain('Unmatched')
    expect(svg).toContain('Matched / Balanced')
    expect(svg).toContain('</svg>')
  })

  it('4. 原生 Word (.docx) 医学标准三线表二进制导出验证', () => {
    // 构造模拟临床研究数据生成 Table 1
    const mockData = [
      { id: 1, group: '达格列净组', age: 66, sex: 'Male', l3_smi: 56.5, lvef: 31.0 },
      { id: 2, group: '达格列净组', age: 64, sex: 'Female', l3_smi: 52.8, lvef: 32.5 },
      { id: 3, group: '达格列净组', age: 67, sex: 'Male', l3_smi: 58.1, lvef: 29.5 },
      { id: 4, group: '对照组', age: 65, sex: 'Male', l3_smi: 55.8, lvef: 31.2 },
      { id: 5, group: '对照组', age: 66, sex: 'Female', l3_smi: 53.0, lvef: 30.8 },
      { id: 6, group: '对照组', age: 68, sex: 'Male', l3_smi: 54.2, lvef: 28.9 },
    ]

    const table1 = generateTable1FromData(mockData, {
      group_col: 'group',
      title: 'Table 1. Baseline Characteristics of DAPA-HF Cohort',
      include_smd: true,
      include_p_value: true,
      labels: {
        age: 'Age (years)',
        sex: 'Sex',
        l3_smi: 'L3 Skeletal Muscle Index (cm²/m²)',
        lvef: 'Left Ventricular Ejection Fraction (%)',
      },
    })

    expect(table1.headers.length).toBeGreaterThan(3)
    expect(table1.rows.length).toBeGreaterThan(3)

    // 导出为 .docx 二进制
    const docxBytes = exportTable1ToDocx(table1)
    expect(docxBytes).toBeInstanceOf(Uint8Array)
    expect(docxBytes.length).toBeGreaterThan(1000)

    // 验证导出的 docx 为合法 Zip 包并包含标准 Word 文档文件
    const unzipped = unzipSync(docxBytes)
    expect(unzipped['[Content_Types].xml']).toBeDefined()
    expect(unzipped['word/document.xml']).toBeDefined()
    expect(unzipped['word/styles.xml']).toBeDefined()

    // 验证 document.xml 包含标准三线表 OpenXML 语法
    const docXml = new TextDecoder().decode(unzipped['word/document.xml'])
    expect(docXml).toContain('<w:tblBorders>')
    expect(docXml).toContain('<w:top w:val="single" w:sz="12"') // 1.5 pt 顶线
    expect(docXml).toContain('<w:bottom w:val="single" w:sz="12"') // 1.5 pt 底线
    expect(docXml).toContain('<w:bottom w:val="single" w:sz="6"') // 0.75 pt 表头底线
    expect(docXml).toContain('Table 1. Baseline Characteristics of DAPA-HF Cohort')
    expect(docXml).toContain('Age (years)')
    expect(docXml).toContain('L3 Skeletal Muscle Index')
  })
})
