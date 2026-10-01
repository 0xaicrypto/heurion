import { strFromU8, unzipSync } from 'fflate'
import type { Store } from '../db.ts'

/**
 * 编辑器文件内评论同步（S4）：用户在 Collabora 里"选中即评论"，评论落在文件里
 * （docx：word/comments.xml + document.xml 里的 commentRangeStart/End）。
 * 本模块把它们同步进评论表（锚点 = 所在段落的 w14:paraId），按 file_comment_id 去重；
 * AI 回复只写线程（reply_comment），不回写 OOXML 评论 —— 避免双源。
 */
export function syncFileComments(store: Store, docId: string, bytes: Uint8Array): { imported: number } {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, { filter: f => f.name === 'word/document.xml' || f.name === 'word/comments.xml' })
  } catch {
    return { imported: 0 }
  }
  const commentsXml = files['word/comments.xml']
  if (!commentsXml) return { imported: 0 }

  // 1) comments.xml：w:comment(id/author) → 文本
  const xml = strFromU8(commentsXml)
  const comments = new Map<string, { author: string; text: string }>()
  const re = /<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g
  for (const m of xml.matchAll(re)) {
    const attrs = m[1] ?? ''
    const id = /\bw:id="([^"]+)"/.exec(attrs)?.[1]
    const author = /\bw:author="([^"]*)"/.exec(attrs)?.[1] ?? '用户'
    const text = [...(m[2] ?? '').matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(x => x[1]).join('')
    if (id) comments.set(id, { author, text: text.trim() })
  }
  if (comments.size === 0) return { imported: 0 }

  // 2) document.xml：commentRangeStart(w:id) → 所在段落的 paraId
  const doc = strFromU8(files['word/document.xml'] ?? new Uint8Array())
  const anchorByComment = new Map<string, string | undefined>()
  {
    let curParaId: string | undefined
    for (const tok of tokenizeDoc(doc)) {
      if (tok.t === 'open') {
        if (tok.name === 'w:p') curParaId = tok.attrs['w14:paraId']
        else if (tok.name === 'w:commentRangeStart' && tok.attrs['w:id']) anchorByComment.set(tok.attrs['w:id']!, curParaId)
      }
    }
  }

  // 3) 落表（去重）
  let imported = 0
  for (const [fileId, c] of comments) {
    if (store.getCommentByFileId(docId, fileId)) continue
    const paraId = anchorByComment.get(fileId)
    const row = store.addComment(docId, { para_id: paraId, text_snippet: c.text }, fileId)
    store.addReply(docId, row.id, 'user', c.text)
    imported++
  }
  if (imported > 0) console.log(`[office] doc ${docId}: file comments synced=${imported}`)
  return { imported }
}

type Tok = { t: 'open'; name: string; attrs: Record<string, string> } | { t: 'close'; name: string } | { t: 'text' }

function* tokenizeDoc(xml: string): Generator<Tok> {
  let i = 0
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) return
    if (lt > i) yield { t: 'text' }
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt); i = e < 0 ? xml.length : e + 3; continue }
    const gt = xml.indexOf('>', lt)
    if (gt < 0) return
    const tag = xml.slice(lt + 1, gt)
    if (tag.startsWith('/')) { yield { t: 'close', name: tag.slice(1).trim() }; i = gt + 1; continue }
    const m = /^([^\s/>]+)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)$/.exec(tag)
    const attrs: Record<string, string> = {}
    if (m?.[2]) for (const a of m[2].matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!
    yield { t: 'open', name: m?.[1] ?? '', attrs }
    i = gt + 1
  }
}
