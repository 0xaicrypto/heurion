import { generatePptx } from './src/handlers/pptx.js'
import { writeFileSync } from 'fs'

const payload = {
  template_id: 'default',
  output_name: 'spike_deck',
  schema_version: 1,
  content_type: 'sidecar.generate_pptx',
  data: {
    schemaVersion: 2,
    title: 'EGFR 突变 NSCLC 免疫治疗研究',
    theme: 'clinical',
    slides: [
      {
        title: '研究概览',
        notes: '说话人备注：强调 STROBE 报告规范。',
        content: [
          { type: 'paragraph', text: '回顾性真实世界研究，单中心，2020年1月–2024年12月', style: 'bullet' },
          { type: 'paragraph', text: '87 例 EGFR 敏感突变（19del/L858R）晚期 NSCLC 接受 ICI 治疗', style: 'bullet' },
          { type: 'paragraph', text: '87.4% 既往接受 EGFR-TKI 治疗（奥希替尼 58.6%）', style: 'bullet' },
        ],
      },
      {
        title: '治疗、数据收集与统计方法',
        notes: '备注：统计方法页。',
        content: [
          { type: 'paragraph', text: 'ICI 单药 vs ICI+铂类化疗±贝伐珠单抗（医生决定）', style: 'bullet' },
          { type: 'paragraph', text: 'Kaplan-Meier + 多变量 Cox 回归', style: 'bullet' },
        ],
      },
    ],
  },
}

const result = await generatePptx(payload)
console.log('result keys:', Object.keys(result ?? {}), typeof result)
console.log(JSON.stringify(result).slice(0, 400))
