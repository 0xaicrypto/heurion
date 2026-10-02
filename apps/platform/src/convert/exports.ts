import type { Documents } from '../model/runtime.ts'
import { withoutPending } from '../ops/suggest.ts'
import { exportDocx } from './docx-export.ts'
import { exportPptx } from './pptx-export.ts'
import { pptxTemplate } from './pptx-template.ts'

/** 导入时的模型（未改动判断的基准）：只有从文件导入的文档才有。 */
function baselineOf(docs: Documents, docId: string) {
  const first = docs.store.listVersions(docId).at(-1)
  return first?.source === 'import' ? docs.versionDoc(docId, first.seq) : null
}

/** 导出 docx：导入的文档以原始文件包为底座、未改动的块原样写回。 */
export function docxFor(docs: Documents, docId: string) {
  const store = docs.store
  const pkg = store.getPackage(docId)
  return exportDocx({
    doc: withoutPending(docs.get(docId)),
    baseline: pkg ? baselineOf(docs, docId) : null,
    pkg,
    src: id => store.getNodeSrc(docId, id),
    citations: store.listCitations(docId),
    comments: store.listComments(docId),
    asset: id => {
      const a = store.getAsset(id)
      return a ? { mime: a.mime, bytes: store.getAssetBytes(id)! } : null
    },
  })
}

/** 导出 pptx：以原始文件包（平台新建的 deck 为模板）为底座、未改动的页与形状原样写回。 */
export function pptxFor(docs: Documents, docId: string) {
  const store = docs.store
  return exportPptx({
    doc: withoutPending(docs.get(docId)),
    baseline: baselineOf(docs, docId),
    pkg: store.getPackage(docId) ?? pptxTemplate(),
    src: id => store.getNodeSrc(docId, id),
    citations: store.listCitations(docId),
    asset: id => {
      const a = store.getAsset(id)
      const bytes = a ? store.getAssetBytes(id) : null
      return a && bytes ? { mime: a.mime, bytes } : null
    },
  })
}
