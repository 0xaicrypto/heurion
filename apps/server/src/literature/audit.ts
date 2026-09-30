import { strFromU8, unzipSync } from 'fflate'
import { normalizeDoi } from './format.ts'

/** 从 docx/pptx 里抽出纯文本（只读正文与幻灯片 XML，不含批注/备注）。 */
export function extractOfficeText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, {
    filter: f => f.name === 'word/document.xml' || /^ppt\/slides\/slide\d+\.xml$/.test(f.name),
  })
  return Object.keys(files).sort().map(name =>
    strFromU8(files[name]!)
      .replace(/<\/w:p>|<\/a:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'),
  ).join('\n')
}

const DOI_RE = /\b10\.\d{4,9}\/[^\s"<>]+/gi

export interface CitationAudit {
  ok: boolean
  /** 文中出现、但没经 insert_citation 登记的 DOI —— 很可能是模型编造或手写的引用。 */
  unregisteredDois: string[]
}

/**
 * 引用规范后置校验：正式引用只能通过 insert_citation 取得。
 * 文档里出现的每个 DOI 都必须在本文档的引用登记表里。
 */
export function auditCitations(text: string, registeredDois: Iterable<string>): CitationAudit {
  const registered = new Set([...registeredDois].map(normalizeDoi))
  const found = new Set((text.match(DOI_RE) ?? []).map(d => normalizeDoi(d.replace(/[.,;)\]]+$/, ''))))
  const unregisteredDois = [...found].filter(d => !registered.has(d))
  return { ok: unregisteredDois.length === 0, unregisteredDois }
}
