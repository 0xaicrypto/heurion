import { validateRenderContent, SCHEMA_VERSION, type TableContent } from '@heurion/contracts'
import { renderPdf } from './common.js'

/** #中-14: 行越界截断的纯函数（导出供单测钉住可见提示的触发条件）。 */
export function normalizeTableRows(colCount: number, rows: string[][]): {
  rows: string[][]
  overflowRows: number
  colCount: number
} {
  let overflowRows = 0
  const normalized = rows.map((row) => {
    if (row.length > colCount) overflowRows++
    return row.slice(0, colCount)
  })
  return { rows: normalized, overflowRows, colCount }
}

/**
 * #686: render_table 入口契约化 — 契约 TableContent（schemaVersion/title/
 * headers/rows）必检;legacy 直调（无 schemaVersion、title 可空）走归一化
 * 兜底,非法输入给出明确错误而不是 pdfkit 内部异常。
 */
export async function renderTable(payload: unknown) {
  const p = (payload || {}) as Record<string, unknown>

  // Legacy 容错:无 schemaVersion 的旧形状(title 缺省/headers 单列)。
  if (!p.schemaVersion) {
    p.schemaVersion = SCHEMA_VERSION
    if (typeof p.title !== 'string' || !p.title.trim()) p.title = 'Table'
  }

  const check = validateRenderContent('sidecar.render_table', p)
  if (!check.ok) {
    throw new Error(`render_table payload failed contract validation: ${check.errors.join('; ')}`)
  }
  const input = p as unknown as TableContent

  // #中-14: 行长度超过表头列数时此前直接越界渲染（第 N+1 个单元格画到表格
  // 外/页面右缘之外，视觉上静默丢失）。按表头列数截断并给可见提示。
  const { rows, overflowRows, colCount } = normalizeTableRows(input.headers.length, input.rows)

  return renderPdf((doc, hasCjk) => {
    doc.fontSize(20).text(input.title, { align: 'center' })
    doc.moveDown(1)

    const colWidth = (doc.page.width - 100) / colCount
    const fontSize = 10
    const rowHeight = 20

    let y = doc.y
    const drawRow = (cells: string[], isHeader: boolean) => {
      let x = 50
      const cellHeight = isHeader ? rowHeight + 5 : rowHeight
      cells.forEach((cell, i) => {
        doc.rect(x, y, colWidth, cellHeight).stroke()
        // #fix 2026-09: 'cjk' 单字体统一——表头中文不能用 Helvetica（CJK
        // 全方块）。粗体视觉由字号/底纹弥补。
        // #928: 条件使用 — 缺 CJK 字体的部署里 'cjk' 未注册,此前无条件
        // doc.font('cjk') 让 render_table 整个必败;现在降级 Helvetica。
        if (hasCjk) doc.font('cjk')
        doc.fontSize(fontSize).text(cell, x + 2, y + 3, {
          width: colWidth - 4,
          align: 'left',
        })
        x += colWidth
      })
      y += cellHeight
    }

    drawRow(input.headers, true)
    for (const row of rows) {
      if (y > doc.page.height - 50) {
        doc.addPage()
        y = 50
      }
      drawRow(row, false)
    }
    if (overflowRows > 0) {
      if (y > doc.page.height - 70) {
        doc.addPage()
        y = 50
      }
      doc.font(hasCjk ? 'cjk' : 'Helvetica').fontSize(9).fillColor('#B45309')
      doc.text(`⚠️ ${overflowRows} 行的单元格数超出表头列数（${colCount} 列）— 超出的单元格已省略`, 50, y + 8, { width: doc.page.width - 100 })
    }
  }, 'table.pdf')
}
