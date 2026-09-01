import fs from 'fs'
import path from 'path'
import prisma from '../common/prisma.js'
import { extractDocumentMarkdownWithImagesFromUpload, type ExtractedPdfImage } from '../lib/document-extractor.js'
import { issueChartToken } from '../common/chart-token.js'
import { writeDocVersion } from './doc-version-writer.js'

/**
 * #774 — doc 工具共享导入面。
 *
 * resolveImportTargets / extractRefText / writeDocBody 原是 edit_document
 * 的私有方法；insert_asset(export) 的"空正文自动导入唯一参考材料"需要
 * 完全相同的行为（提取管线含图片托管与 PDF 公式 OCR），抽为共享 util
 * 供两个工具共用，避免复制粘贴漂移。
 */

/** 当前文档的全部参考材料(label 与原始记录)。 */
export async function resolveImportTargets(userId: string, docId: string): Promise<Array<{ r: any; label: string }>> {
  const refs = await (prisma as any).docReference.findMany({ where: { userId, docId } })
  return (refs || []).map((r: any) => {
    let label = ''
    try { label = JSON.parse(r.sourceNodes || '{}').label || '' } catch { /* ignore */ }
    return { r, label: label || r.snapshot || r.id }
  })
}

/** 提取参考材料正文:文件类走 markdown+图片提取;纯文本引用直接用 snapshot。 */
export async function extractRefText(userId: string, docId: string, ref: any, label: string): Promise<{ text: string; error?: string }> {
  const kind = String(ref.refType || '')
  if (kind !== 'file' && kind !== 'pdf' && kind !== 'docx') {
    return { text: String(ref.snapshot || '') }
  }
  // #730: FileIndex 是真实表 — typed 访问,查不到按文件名扫描磁盘兜底。
  const byIndex = await prisma.fileIndex.findFirst({
    where: { userId, name: String(ref.snapshot || ''), deletedAt: null },
    orderBy: { createdAt: 'desc' },
  }).catch(() => null)
  const fileId = byIndex?.id || findUploadByFileName(userId, String(ref.snapshot || ''))
  if (!fileId) return { text: '', error: `参考材料「${label}」对应的上传文件不存在` }
  // #fix: 导入走 markdown+图片提取 — PDF 恢复标题/段落结构,DOCX 保留
  // mammoth 结构;内嵌图落盘为托管文件并在文档里渲染(取代 [图])。
  const extracted = await extractDocumentMarkdownWithImagesFromUpload(userId, fileId)
  let text = embedDocumentImages(userId, docId, extracted.text, extracted.images)
  // #fix(方案 A):PDF 公式视觉 OCR → LaTeX 追加文末 — PDF 文本层没有
  // 公式语义,视觉模型把公式转 $$...$$,AI 才能理解数学内容。仅导入时
  // 一次(非每轮),失败静默降级。
  if (kind === 'pdf' && text) {
    const { extractFormulasFromPdf } = await import('../lib/pdf-formula.js')
    const formulas = await extractFormulasFromPdf(userId, fileId)
    if (formulas) text += formulas
  }
  if (!text) return { text: '', error: `无法从参考材料「${label}」提取正文` }
  return { text }
}

/** 把正文写入文档(#789: 经 DocVersionWriter — 差异时同帧快照旧 body+deck),返回新正文。 */
export async function writeDocBody(userId: string, docId: string, text: string, snapshotLabel: string): Promise<{ body: string; error?: string }> {
  const result = await writeDocVersion({ userId, docId, body: text, snapshotLabel })
  if (result.error) return { body: '', error: result.error }
  return { body: result.body }
}

// ── #787: 「空正文自动导入唯一参考材料」单点编排 ──────────────────────
//
// 此前该决策(唯一参考→导入 / 无参考报错 / 多参考列清单)在 edit_document
// (range edit)、insert_asset(保真导出 / 编排导出)、documents.router
// (上传即草稿)四处各写一份,错误文案已经分叉。所有调用方改走 ensureDraftBody:
//   - 成功时正文已写入(writeDocBody,快照 label 'AI import'),note 描述
//     自动导入动作,调用方按需拼接;
//   - error 为场景化引导文案(空参考/多参考/提取失败),调用方转工具错误
//     或( upload 场景)静默忽略;
//   - scenario='upload' 服务后台路径:preferLabel 命中的参考直接导入
//     (刚上传的文件就是明确意图),不适用多参考限制,无命中回退第一条。

export type EnsureDraftBodyScenario = 'import_reference' | 'export' | 'organize' | 'upload'

export interface EnsureDraftBodyOptions {
  scenario: EnsureDraftBodyScenario
  /** upload 场景:优先导入的参考材料 label(刚上传的文件名)。 */
  preferLabel?: string
}

const EMPTY_BODY_ERRORS: Record<Exclude<EnsureDraftBodyScenario, 'upload'>, string> = {
  import_reference: '文档正文为空,且没有可导入的参考材料。请先上传参考资料,或内容很短时用 full_text 直接写入。',
  export: '文档正文为空，无法导出。请先撰写内容。',
  organize: 'organize=true 需要你在 tool call 参数里直接提供 slides（deck 内容）。当前草稿为空且无参考材料 — 若对话上下文素材足够（如用户要求"凭空做个 PPT"），请把内容整理成 slides 再次调用；否则请让用户上传参考材料或先撰写正文。',
}

function multiBodyError(scenario: EnsureDraftBodyScenario, available: string): string {
  switch (scenario) {
    case 'import_reference':
      return `文档正文为空,且有多个参考材料(${available})。请先用 import_reference 明确导入其中之一(分步润色的前置步骤),或内容很短时用 full_text 直接写入。`
    case 'export':
      return `文档正文为空,且有多个参考材料(${available})。请先用 edit_document 的 import_reference 明确导入其中之一,再导出。`
    case 'organize':
      return `文档正文为空,且有多个参考材料(${available})。请先用 edit_document 的 import_reference 明确导入其中之一,再走编排导出。`
    default:
      return '' // upload 为静默后台路径,不产出面向模型的引导
  }
}

export async function ensureDraftBody(
  userId: string,
  docId: string,
  opts: EnsureDraftBodyOptions,
): Promise<{ body: string; note?: string; error?: string }> {
  const existing = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
  if (!existing) return { body: '', error: `Document not found: ${docId}` }
  const currentBody = String(existing.body || '')
  if (currentBody.trim()) return { body: currentBody }

  const targets = await resolveImportTargets(userId, docId)

  let hit: { r: any; label: string } | undefined
  if (opts.scenario === 'upload') {
    hit = (opts.preferLabel ? targets.find((t) => t.label === opts.preferLabel) : undefined) || targets[0]
    if (!hit) return { body: currentBody, error: '文档正文为空，且没有可导入的参考材料。' }
  } else if (targets.length === 1) {
    hit = targets[0]
  } else {
    const available = targets.map((t) => t.label).slice(0, 5).join('、')
    return {
      body: currentBody,
      error: targets.length === 0 ? EMPTY_BODY_ERRORS[opts.scenario] : multiBodyError(opts.scenario, available),
    }
  }

  const { text, error } = await extractRefText(userId, docId, hit.r, hit.label)
  if (error) return { body: currentBody, error }
  if (!text) return { body: currentBody, error: `参考材料「${hit.label}」提取结果为空` }
  const { body, error: writeError } = await writeDocBody(userId, docId, text, 'AI import')
  if (writeError) return { body: currentBody, error: writeError }
  return { body, note: `已自动导入参考材料「${hit.label}」` }
}

/** FileIndex 表缺失时的兜底:扫描上传目录,按文件名(去 fileId 前缀)定位。 */
function findUploadByFileName(userId: string, name: string): string | null {
  if (!name) return null
  const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
  if (!fs.existsSync(dir)) return null
  for (const f of fs.readdirSync(dir)) {
    const derived = f.split('_').slice(1).join('_') || f
    if (derived === name) return f
  }
  return null
}

/**
 * #fix: 内嵌图 → 文档托管图片。图片落盘为 uploads/img_<docId>_<n>.<ext>,
 * 签发 chart token(绑定文件+所有者,<img> 无鉴权头也能加载),生成
 * ![图 N](/api/v1/files/download/...?token=...) markdown。
 * 替换顺序:
 *   1) DOCX 的 [图]/\[图\] 占位符按序替换;
 *   2) PDF 按分页标记 <!-- page:N --> 插入该页的图(提取带页码,
 *      位置准确 — 此前全按 Figure 标题行,正文引用 "Figure 1)" 会
 *      抢走图 1 的位置);
 *   3) 剩余图片按严格 "Figure N:" / "图 N:" 标题行就近插入;
 *   4) 仍未插入的追加到文末 "## 图" 段;清理未消费的分页标记。
 */
function embedDocumentImages(userId: string, docId: string, text: string, images: ExtractedPdfImage[]): string {
  if (!images.length) {
    // 无图也要清理分页标记(它们只服务于图片定位)。
    return text.replace(/<!-- page:\d+ -->/g, '')
  }

  const extByMime: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/bmp': 'bmp',
  }
  const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
  fs.mkdirSync(dir, { recursive: true })

  const urls = images.map((img, i) => {
    const ext = extByMime[img.mime] || 'png'
    const fileId = `img_${docId}_${i + 1}.${ext}`
    fs.writeFileSync(path.join(dir, fileId), Buffer.from(img.dataBase64, 'base64'))
    const token = issueChartToken(fileId, userId)
    return `/api/v1/files/download/${fileId}?token=${token}`
  })

  let body = text
  let used = 0
  // 1) DOCX 占位符 [图] / \[图\](turndown 转义方括号)按序替换。
  body = body.replace(/\\?\[图\\?\]/g, () => {
    if (used < urls.length) {
      const n = used + 1
      used++
      return `![图 ${n}](${urls[n - 1]})`
    }
    return '[图]'
  })

  // 2) PDF 分页标记:该页的图插入到 <!-- page:N --> 之后。
  if (used < urls.length) {
    const byPage = new Map<number, string[]>()
    for (let i = used; i < images.length; i++) {
      const p = images[i].page || 1
      const list = byPage.get(p) || []
      list.push(`![图 ${i + 1}](${urls[i]})`)
      byPage.set(p, list)
    }
    body = body.replace(/<!-- page:(\d+) -->/g, (marker, p: string) => {
      const imgs = byPage.get(parseInt(p, 10)) || []
      if (imgs.length === 0) return ''
      used += imgs.length
      return `${imgs.join('\n\n')}`
    })
  }

  // 3) 剩余图片按严格 "Figure N:" / "图 N:" 标题行就近插入。
  if (used < urls.length) {
    const lines = body.split('\n')
    const outLines: string[] = []
    for (const line of lines) {
      outLines.push(line)
      if (used < urls.length && /^\s*(?:Figure|Fig\.?|图)\s*\d+\s*[:.．]/i.test(line)) {
        used++
        outLines.push(`![图 ${used}](${urls[used - 1]})`)
      }
    }
    body = outLines.join('\n')
  }

  // 4) 仍未插入的追加到文末。
  if (used < urls.length) {
    const leftover = urls.slice(used).map((u, i) => `![图 ${used + 1 + i}](${u})`).join('\n\n')
    body = `${body}\n\n## 图\n${leftover}`
  }
  return body
}
