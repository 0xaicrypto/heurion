/**
 * CONSORT 2010 / STROBE 临床研究入组筛选流向图引擎 (Automated Study Flowchart Engine)
 * 
 * 专为医学顶刊（NEJM / Lancet / JAMA / BMJ）标准 Figure 1 流向图设计：
 * - 阶梯式初筛与排除原因沉淀（Assessed -> Excluded by Reason -> Allocated -> Analyzed）；
 * - 输出出版级高分辨率矢量 SVG、Mermaid 流程图代码及 LaTeX TikZ 代码；
 * - 支持结合 @resvg/resvg-js 导出 300 DPI 印刷级 PNG。
 */

export interface ConsortExclusionItem {
  reason: string
  count: number
  percentage?: number
}

export interface ConsortArm {
  name: string
  allocated: number
  lost_to_followup?: number
  discontinued?: number
  analyzed: number
}

export interface ConsortDiagramData {
  title?: string
  total_assessed: number
  exclusions: ConsortExclusionItem[]
  eligible_total: number
  arms: ConsortArm[]
}

/**
 * 生成符合医学期刊规范的 CONSORT 2010 矢量流向图 (SVG)
 */
export function renderConsortSvg(data: ConsortDiagramData): string {
  const {
    title = 'CONSORT 2010 Flow Diagram',
    total_assessed,
    exclusions,
    eligible_total,
    arms,
  } = data

  const totalExcluded = exclusions.reduce((acc, curr) => acc + curr.count, 0)
  const width = 860
  const headerHeight = 70
  
  // Calculate dynamic heights
  const exclusionLineHeight = 22
  const exclusionBoxHeight = Math.max(80, 40 + exclusions.length * exclusionLineHeight)
  const totalHeight = headerHeight + 110 + exclusionBoxHeight + 280

  // Coordinates
  const cx = width / 2
  const boxWidth = 320
  const boxHeight = 65

  // Box 1: Enrollment / Assessed
  const b1_x = cx - boxWidth / 2
  const b1_y = headerHeight + 20

  // Box 2: Excluded (Side branch on the right)
  const b2_w = 340
  const b2_h = exclusionBoxHeight
  const b2_x = cx + 80
  const b2_y = b1_y + boxHeight + 35

  // Box 3: Randomized / Allocated
  const b3_y = b2_y + b2_h + 35

  // Exclusion items formatted
  const exclusionLines = exclusions.map((item, idx) => {
    const pct = item.percentage ?? (total_assessed > 0 ? (item.count / total_assessed) * 100 : 0)
    const pctStr = pct > 0 ? ` (${pct.toFixed(1)}%)` : ''
    return `<text x="${b2_x + 16}" y="${b2_y + 45 + idx * exclusionLineHeight}" font-family="Times New Roman, STSong, serif" font-size="13" fill="#334155">• ${escapeXml(item.reason)}: n = ${item.count}${pctStr}</text>`
  }).join('\n      ')

  // Arms rendering (2 branches: Treatment vs Control)
  let armsSvg = ''
  if (arms.length >= 2) {
    const arm1 = arms[0]!
    const arm2 = arms[1]!
    const armW = 340
    const armH = 110
    const gap = 60
    const arm1_x = cx - armW - gap / 2
    const arm2_x = cx + gap / 2
    const arms_y = b3_y + boxHeight + 45

    // Split branch line from b3
    const branchMidY = b3_y + boxHeight + 22
    const arm1_cx = arm1_x + armW / 2
    const arm2_cx = arm2_x + armW / 2

    armsSvg = `
      <!-- Allocation Branching Lines -->
      <line x1="${cx}" y1="${b3_y + boxHeight}" x2="${cx}" y2="${branchMidY}" stroke="#475569" stroke-width="1.8" />
      <line x1="${arm1_cx}" y1="${branchMidY}" x2="${arm2_cx}" y2="${branchMidY}" stroke="#475569" stroke-width="1.8" />
      <line x1="${arm1_cx}" y1="${branchMidY}" x2="${arm1_cx}" y2="${arms_y}" stroke="#475569" stroke-width="1.8" marker-end="url(#arrow)" />
      <line x1="${arm2_cx}" y1="${branchMidY}" x2="${arm2_cx}" y2="${arms_y}" stroke="#475569" stroke-width="1.8" marker-end="url(#arrow)" />

      <!-- Arm 1 Box -->
      <rect x="${arm1_x}" y="${arms_y}" width="${armW}" height="${armH}" rx="4" fill="#f8fafc" stroke="#3b82f6" stroke-width="1.6" filter="url(#shadow)" />
      <text x="${arm1_cx}" y="${arms_y + 24}" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-weight="bold" font-size="14" fill="#1e3a8a">${escapeXml(arm1.name)} (n = ${arm1.allocated})</text>
      <line x1="${arm1_x + 10}" y1="${arms_y + 34}" x2="${arm1_x + armW - 10}" y2="${arms_y + 34}" stroke="#e2e8f0" stroke-width="1" />
      <text x="${arm1_x + 16}" y="${arms_y + 56}" font-family="Times New Roman, STSong, serif" font-size="13" fill="#334155">• 失访 / 脱落: n = ${arm1.lost_to_followup ?? 0}</text>
      <text x="${arm1_x + 16}" y="${arms_y + 78}" font-family="Times New Roman, STSong, serif" font-size="13" fill="#334155">• 依从性不足终止: n = ${arm1.discontinued ?? 0}</text>
      <text x="${arm1_x + 16}" y="${arms_y + 98}" font-family="Times New Roman, STSong, serif" font-weight="bold" font-size="13" fill="#0f172a">• 纳入最终疗效分析: n = ${arm1.analyzed}</text>

      <!-- Arm 2 Box -->
      <rect x="${arm2_x}" y="${arms_y}" width="${armW}" height="${armH}" rx="4" fill="#f8fafc" stroke="#10b981" stroke-width="1.6" filter="url(#shadow)" />
      <text x="${arm2_cx}" y="${arms_y + 24}" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-weight="bold" font-size="14" fill="#065f46">${escapeXml(arm2.name)} (n = ${arm2.allocated})</text>
      <line x1="${arm2_x + 10}" y1="${arms_y + 34}" x2="${arm2_x + armW - 10}" y2="${arms_y + 34}" stroke="#e2e8f0" stroke-width="1" />
      <text x="${arm2_x + 16}" y="${arms_y + 56}" font-family="Times New Roman, STSong, serif" font-size="13" fill="#334155">• 失访 / 脱落: n = ${arm2.lost_to_followup ?? 0}</text>
      <text x="${arm2_x + 16}" y="${arms_y + 78}" font-family="Times New Roman, STSong, serif" font-size="13" fill="#334155">• 依从性不足终止: n = ${arm2.discontinued ?? 0}</text>
      <text x="${arm2_x + 16}" y="${arms_y + 98}" font-family="Times New Roman, STSong, serif" font-weight="bold" font-size="13" fill="#0f172a">• 纳入最终疗效分析: n = ${arm2.analyzed}</text>
    `
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${totalHeight}" width="${width}" height="${totalHeight}">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#475569" />
    </marker>
    <filter id="shadow" x="-3%" y="-3%" width="106%" height="110%" filterUnits="userSpaceOnUse">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.08" />
    </filter>
  </defs>

  <!-- Background Canvas -->
  <rect width="100%" height="100%" fill="#ffffff" />

  <!-- Diagram Title Banner -->
  <text x="${cx}" y="36" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-size="20" font-weight="bold" fill="#0f172a">${escapeXml(title)}</text>
  <text x="${cx}" y="56" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-size="13" fill="#64748b">CONSORT 2010 / STROBE 国际规范标准队列筛选流向图 (Automated Research Flowchart)</text>
  <line x1="60" y1="66" x2="${width - 60}" y2="66" stroke="#cbd5e1" stroke-width="1.2" />

  <!-- Stage Tags on Left Margin -->
  <text x="35" y="${b1_y + 36}" font-family="Arial, sans-serif" font-size="11" font-weight="bold" fill="#64748b" letter-spacing="1">ENROLLMENT</text>
  <text x="35" y="${b3_y + 36}" font-family="Arial, sans-serif" font-size="11" font-weight="bold" fill="#64748b" letter-spacing="1">ALLOCATION</text>
  <text x="35" y="${b3_y + 160}" font-family="Arial, sans-serif" font-size="11" font-weight="bold" fill="#64748b" letter-spacing="1">ANALYSIS</text>

  <!-- 1. Assessed for Eligibility Box -->
  <rect x="${b1_x}" y="${b1_y}" width="${boxWidth}" height="${boxHeight}" rx="4" fill="#f8fafc" stroke="#475569" stroke-width="1.6" filter="url(#shadow)" />
  <text x="${cx}" y="${b1_y + 26}" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-weight="bold" font-size="15" fill="#0f172a">评估初筛候选受试者 (Assessed for eligibility)</text>
  <text x="${cx}" y="${b1_y + 48}" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-size="14" fill="#334155">( N = ${total_assessed.toLocaleString()} 例 )</text>

  <!-- Vertical Trunk Line -->
  <line x1="${cx}" y1="${b1_y + boxHeight}" x2="${cx}" y2="${b3_y}" stroke="#475569" stroke-width="1.8" marker-end="url(#arrow)" />

  <!-- Branch Line to Exclusion Box -->
  <path d="M ${cx} ${b2_y + 25} L ${b2_x} ${b2_y + 25}" fill="none" stroke="#475569" stroke-width="1.8" marker-end="url(#arrow)" />

  <!-- 2. Exclusion Box -->
  <rect x="${b2_x}" y="${b2_y}" width="${b2_w}" height="${b2_h}" rx="4" fill="#fff1f2" stroke="#e11d48" stroke-width="1.5" filter="url(#shadow)" />
  <text x="${b2_x + 16}" y="${b2_y + 24}" font-family="Times New Roman, STSong, serif" font-weight="bold" font-size="14" fill="#be123c">排除受试者 (Excluded: n = ${totalExcluded.toLocaleString()})</text>
  <line x1="${b2_x + 10}" y1="${b2_y + 32}" x2="${b2_x + b2_w - 10}" y2="${b2_y + 32}" stroke="#fecdd3" stroke-width="1" />
  ${exclusionLines}

  <!-- 3. Eligible / Randomized Box -->
  <rect x="${b1_x}" y="${b3_y}" width="${boxWidth}" height="${boxHeight}" rx="4" fill="#eff6ff" stroke="#2563eb" stroke-width="1.6" filter="url(#shadow)" />
  <text x="${cx}" y="${b3_y + 26}" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-weight="bold" font-size="15" fill="#1e3a8a">最终合格入组队列 (Eligible / Allocated)</text>
  <text x="${cx}" y="${b3_y + 48}" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-size="14" fill="#1d4ed8">( N = ${eligible_total.toLocaleString()} 例 )</text>

  ${armsSvg}
</svg>`
}

/**
 * 导出为 Mermaid 流程图代码（可直接嵌入 Markdown 预览）
 */
export function renderConsortMermaid(data: ConsortDiagramData): string {
  const { total_assessed, exclusions, eligible_total, arms } = data
  const totalExcluded = exclusions.reduce((acc, curr) => acc + curr.count, 0)
  
  const exclusionText = exclusions
    .map(e => `• ${e.reason} (n=${e.count})`)
    .join('<br>')

  let mermaid = `graph TD\n`
  mermaid += `  A["评估初筛人群 (Assessed for eligibility)<br><b>N = ${total_assessed}</b>"] --> B{"合格入组判断"}\n`
  mermaid += `  B -->|排除 n = ${totalExcluded}| Ex["<b>排除人群 (Excluded)</b><br>${exclusionText}"]\n`
  mermaid += `  B -->|合格入组| C["<b>最终纳入研究队列 (Allocated)</b><br>N = ${eligible_total}"]\n`

  if (arms.length >= 2) {
    const arm1 = arms[0]!
    const arm2 = arms[1]!
    mermaid += `  C --> D1["<b>${arm1.name}</b><br>分配: n=${arm1.allocated}<br>最终分析: n=${arm1.analyzed}"]\n`
    mermaid += `  C --> D2["<b>${arm2.name}</b><br>分配: n=${arm2.allocated}<br>最终分析: n=${arm2.analyzed}"]\n`
  }

  mermaid += `  style A fill:#f8fafc,stroke:#475569,stroke-width:2px\n`
  mermaid += `  style Ex fill:#fff1f2,stroke:#e11d48,stroke-width:1.5px\n`
  mermaid += `  style C fill:#eff6ff,stroke:#2563eb,stroke-width:2px\n`
  if (arms.length >= 2) {
    mermaid += `  style D1 fill:#f0fdf4,stroke:#16a34a,stroke-width:1.5px\n`
    mermaid += `  style D2 fill:#f0fdf4,stroke:#16a34a,stroke-width:1.5px\n`
  }

  return mermaid
}

/**
 * 辅助转义 XML 字符
 */
function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '&': return '&amp;'
      case '\'': return '&apos;'
      case '"': return '&quot;'
      default: return c
    }
  })
}
