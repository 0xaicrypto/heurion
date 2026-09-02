import { validateRenderContent, type DocumentContent } from '@heurion/contracts'
import { renderPdf } from './common.js'

/**
 * #686: convert_to_pdf 入口契约化 — 控制面（insert_asset export / 插件
 * 管线）发送的是契约 DocumentContent（sections[].paragraphs）。旧实现
 * 只认 legacy 的 {content, sections:[{heading, body}]}，契约形状进来时
 * body 恒 undefined → 渲出空白 PDF（#686-A 的"零校验"直接后果）。
 * 现在契约形状优先，legacy 形状容错保留。
 */
interface LegacyPdfInput {
  title?: string
  content?: string
  sections?: { heading: string; body?: string }[]
}

function isDocumentContent(payload: unknown): payload is DocumentContent {
  return validateRenderContent('sidecar.convert_to_pdf', payload).ok
}

export async function convertToPdf(payload: unknown) {
  let title: string | undefined
  if (isDocumentContent(payload)) {
    const doc = payload
    title = doc.title
    return renderPdf((d) => {
      if (title) {
        d.fontSize(24).text(title, { align: 'center' })
        d.moveDown(2)
      }
      for (const section of doc.sections || []) {
        d.fontSize(18).text(section.heading, { underline: true })
        d.moveDown(0.5)
        for (const p of section.paragraphs || []) {
          const text = String((p as { text?: string }).text || '')
          const style = (p as { style?: string }).style
          d.fontSize(12).text(style === 'bullet' ? `• ${text}` : text)
          d.moveDown(0.3)
        }
        d.moveDown(0.7)
      }
    }, 'document.pdf')
  }

  // Legacy tolerance — direct callers / older jobs.
  const input = payload as LegacyPdfInput
  if (!input || (!input.title && !input.content && !input.sections)) {
    throw new Error('convert_to_pdf payload does not match DocumentContent contract nor legacy {content, sections} shape')
  }
  return renderPdf((doc) => {
    if (input.title) {
      doc.fontSize(24).text(input.title, { align: 'center' })
      doc.moveDown(2)
    }
    if (input.content) {
      doc.fontSize(12).text(input.content)
      doc.moveDown(1)
    }
    for (const section of input.sections || []) {
      doc.fontSize(18).text(section.heading, { underline: true })
      doc.moveDown(0.5)
      doc.fontSize(12).text(section.body || '')
      doc.moveDown(1)
    }
  }, 'document.pdf')
}
