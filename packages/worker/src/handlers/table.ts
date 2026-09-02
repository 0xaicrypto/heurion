import { renderPdf } from './common.js'

export interface TableInput {
  title?: string
  headers: string[]
  rows: string[][]
}

export async function renderTable(input: TableInput) {
  return renderPdf((doc) => {
    if (input.title) {
      doc.fontSize(20).text(input.title, { align: 'center' })
      doc.moveDown(1)
    }

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
