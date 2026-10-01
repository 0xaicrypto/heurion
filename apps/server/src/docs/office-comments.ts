import { strFromU8, unzipSync } from 'fflate'
import type { Store } from '../db.ts'

/**
 * 编辑器文件内评论同步（S4/S5+）：
 *
 * 用户在 Collabora 里"选中即评论"，评论落在文件里——
 * - docx：word/comments.xml + document.xml 里的 commentRangeStart/End（锚点 = 所在段落 w14:paraId）
 * - pptx：ppt/comments/comment*.xml（legacy p:cm）或 ppt/threadedComments/（PowerPoint 新格式）
 *          （锚点 = 页 id slide part 路径；LO 回写后按页号对应）
 *
 * 同步进评论表，按 file_comment_id 去重；AI 回复只写线程（reply_comment）不回写
 * OOXML 评论（避免双源）。
 *
 * **@heurion 自动触发**：评论文本里 @heurion = 直接召唤 AI（评论即指令）。
 * wantsAi() 给自动触发队列用；防循环约定见 docs/DESIGN.md §4.4。
 */

/** 评论召唤 AI 的触发词：@heurion（大小写/全半角不敏感）。 */
export function wantsAi(text: string): boolean {
  return /@\s*heurion/i.test(text)
}

export interface SyncResult {
  imported: number
  /** 本次新导入的评论 id（供 @heurion 自动触发扫描）。 */
  commentIds: string[]
}

export function syncFileComments(store: Store, docId: string, bytes: Uint8Array): SyncResult {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, { filter: f =>
      f.name === 'word/document.xml' ||
      f.name === 'word/comments.xml' ||
      /^ppt\/comments\/comment\d*\.xml$/.test(f.name) ||
      /^ppt\/threadedComments\/threadedComment\d*\.xml$/.test(f.name),
    })
  } catch {
    return { imported: 0, commentIds: [] }
  }
  if (files['word/comments.xml']) return syncDocxComments(store, docId, files)
  return syncPptxComments(store, docId, files)
}

// —— docx ——

function syncDocxComments(store: Store, docId: string, files: Record<string, Uint8Array>): SyncResult {
  const xml = strFromU8(files['word/comments.xml']!)
  const comments = new Map<string, string>()
  for (const m of xml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const id = /\bw:id="([^"]+)"/.exec(m[1] ?? '')?.[1]
    const text = [...(m[2] ?? '').matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(x => x[1]).join('').trim()
    if (id && text) comments.set(id, text)
  }
  if (comments.size === 0) return { imported: 0, commentIds: [] }

  // document.xml 状态机：commentRangeStart/End 是**自闭合元素**（带 attrs 的 open token）。
  // 范围文字 = 文档里被评论的内容（锚点片段）；评论内容 = 用户指令（进回复）。
  const doc = strFromU8(files['word/document.xml'] ?? new Uint8Array())
  const anchorByComment = new Map<string, string | undefined>()
  const rangeText = new Map<string, string[]>()
  {
    let curParaId: string | undefined
    let openRange: string | null = null
    let tDepth = 0
    for (const tok of tokenizeDoc(doc)) {
      if (tok.t === 'text') {
        if (tDepth > 0 && openRange !== null) {
          const buf = rangeText.get(openRange) ?? []
          buf.push(decodeXmlEntities(tok.raw))
          rangeText.set(openRange, buf)
        }
        continue
      }
      if (tok.t === 'open') {
        if (tok.name === 'w:p') curParaId = tok.attrs['w14:paraId']
        else if (tok.name === 'w:t') { if (tok.self) continue; tDepth++ }
        else if (tok.name === 'w:commentRangeStart' && tok.attrs['w:id']) {
          anchorByComment.set(tok.attrs['w:id']!, curParaId)
          openRange = tok.attrs['w:id']!
        } else if (tok.name === 'w:commentRangeEnd' && tok.attrs['w:id'] && openRange === tok.attrs['w:id']) {
          openRange = null
        }
      }
    }
  }

  const out: SyncResult = { imported: 0, commentIds: [] }
  for (const [fileId, text] of comments) {
    if (store.getCommentByFileId(docId, fileId)) continue
    const range = (rangeText.get(fileId) ?? []).join('').trim()
    const row = store.addComment(docId, {
      para_id: anchorByComment.get(fileId),
      text_snippet: range || text, // 范围文字优先；无范围（整段批注）退化为评论文字
    }, fileId)
    store.addReply(docId, row.id, 'user', text)
    out.imported++
    out.commentIds.push(row.id)
  }
  if (out.imported > 0) console.log(`[office] doc ${docId}: file comments synced=${out.imported}`)
  return out
}

// —— pptx ——

/** 从文件名/关系提取页号：comment1.xml / threadedComment2.xml → slide2.xml。 */
function slidePartOf(name: string, kind: 'comments' | 'threaded'): string | null {
  const num = /(\d+)\.xml$/.exec(name)?.[1]
  return num ? `ppt/slides/slide${num}.xml` : null
}

function syncPptxComments(store: Store, docId: string, files: Record<string, Uint8Array>): SyncResult {
  const out: SyncResult = { imported: 0, commentIds: [] }
  // legacy：ppt/comments/commentN.xml —— p:cm（authorId 查 ppt/authors.xml；POC 直接用 author 名字段）
  for (const [name, data] of Object.entries(files)) {
    if (!/^ppt\/comments\/comment\d*\.xml$/.test(name)) continue
    const slideId = slidePartOf(name, 'comments')
    const xml = strFromU8(data)
    for (const m of xml.matchAll(/<p:cm\b([^>]*)>([\s\S]*?)<\/p:cm>/g)) {
      const author = /\bauthor="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? '用户'
      const text = [...(m[2] ?? '').matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map(x => x[1]).join('').trim()
      if (!text) continue
      // 去重键用 p:cm 自身的 id 属性（跨保存稳定）
      const cmId = /\bid="(\d+)"/.exec(m[1] ?? '')?.[1] ?? text.slice(0, 32)
      const fileId = `${name}#${cmId}#${author}`
      if (store.getCommentByFileId(docId, fileId)) continue
      const row = store.addComment(docId, { slide_id: slideId ?? undefined, text_snippet: text }, fileId)
      store.addReply(docId, row.id, 'user', text)
      out.imported++
      out.commentIds.push(row.id)
    }
  }
  // PowerPoint 新格式：ppt/threadedComments/threadedCommentN.xml —— pTC（comments/comment 有 text）
  for (const [name, data] of Object.entries(files)) {
    if (!/^ppt\/threadedComments\/threadedComment\d*\.xml$/.test(name)) continue
    const slideId = slidePartOf(name, 'threaded')
    const xml = strFromU8(data)
    for (const m of xml.matchAll(/<p1912:comment\b([^>]*)>([\s\S]*?)<\/p1912:comment>/g)) {
      const author = /\bauthor="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? '用户'
      const text = [...(m[2] ?? '').matchAll(/<p1912:text>([\s\S]*?)<\/p1912:text>/g)].map(x => x[1]).join('').trim()
      if (!text) continue
      const fileId = `tc:${name}#${author}#${text.slice(0, 32)}`
      if (store.getCommentByFileId(docId, fileId)) continue
      const row = store.addComment(docId, { slide_id: slideId ?? undefined, text_snippet: text }, fileId)
      store.addReply(docId, row.id, 'user', text)
      out.imported++
      out.commentIds.push(row.id)
    }
  }
  if (out.imported > 0) console.log(`[office] doc ${docId}: pptx file comments synced=${out.imported}`)
  return out
}

// —— 极简 XML 遍历（docx 锚点提取用） ——

const decodeXmlEntities = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')

type Tok = { t: 'open'; name: string; attrs: Record<string, string>; self: boolean } | { t: 'close'; name: string } | { t: 'text'; raw: string }

function* tokenizeDoc(xml: string): Generator<Tok> {
  let i = 0
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) return
    if (lt > i) yield { t: 'text', raw: xml.slice(i, lt) }
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt); i = e < 0 ? xml.length : e + 3; continue }
    const gt = xml.indexOf('>', lt)
    if (gt < 0) return
    const tag = xml.slice(lt + 1, gt)
    if (tag.startsWith('/')) { yield { t: 'close', name: tag.slice(1).trim() }; i = gt + 1; continue }
    const m = /^([^\s/>]+)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)$/.exec(tag)
    const attrs: Record<string, string> = {}
    if (m?.[2]) for (const a of m[2].matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!
    yield { t: 'open', name: m?.[1] ?? '', attrs, self: m?.[3] === '/' }
    i = gt + 1
  }
}
