import { validateRenderContent, SCHEMA_VERSION, type TableContent } from '@heurion/contracts'
import { renderPdf } from './common.js'

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

  return renderPdf((doc) => {
    doc.fontSize(20).text(input.title, { align: 'center' })
    doc.moveDown(1)

    const colWidth = (doc.page.width - 100) / input.headers.length
    const fontSize = 10
    const rowHeight = 20

    let y = doc.y
    const drawRow = (cells: string[], isHeader: boolean) => {
      let x = 50
      const cellHeight = isHeader ? rowHeight + 5 : rowHeight
      cells.forEach((cell, i) => {
        doc.rect(x, y, colWidth, cellHeight).stroke()
        // #fix 2026-09: 'cjk' 单字体统一（applyCjkFont 已注册）——表头中文
        // 不能用 Helvetica（CJK 全方块）。粗体视觉由字号/底纹弥补。
        doc.font('cjk').fontSize(fontSize).text(cell, x + 2, y + 3, {
          width: colWidth - 4,
          align: 'left',
        })
        x += colWidth
      })
      y += cellHeight
    }

    drawRow(input.headers, true)
    for (const row of input.rows) {
      if (y > doc.page.height - 50) {
        doc.addPage()
        y = 50
      }
      drawRow(row, false)
    }
  }, 'table.pdf')
}
