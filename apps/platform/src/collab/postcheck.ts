import { EventEmitter } from 'node:events'
import { indexById } from '../model/ids.ts'
import { plainText } from '../model/markdown.ts'
import type { CommitEvent, Documents } from '../model/runtime.ts'
import { manualCitation } from '../ops/citation-check.ts'

export interface Notice { doc_id: string; node_id: string; code: string; message: string }

/**
 * 人类编辑的事后检查（PLATFORM.md §5.3）：不拒绝写入，只提示。
 * 目前检查手写引用（DOI / PMID / 参考文献条目）——正式引用应经文献检索登记。
 */
export class PostCheck extends EventEmitter<{ notice: [Notice] }> {
  constructor(private readonly docs: Documents) {
    super()
    docs.on('commit', e => this.check(e))
  }

  private check(e: CommitEvent): void {
    if (e.actor !== 'user') return
    const touched = e.changes.filter(c => c.kind !== 'removed').map(c => c.node_id)
    if (touched.length === 0) return
    const index = indexById(this.docs.get(e.docId))
    for (const id of touched) {
      const node = index.get(id)?.node
      if (!node?.isTextblock) continue
      const text = plainText(node).replace(/\[@c:[a-z0-9]+\]/g, '')
      if (manualCitation(text)) {
        this.emit('notice', {
          doc_id: e.docId, node_id: id, code: 'manual_citation',
          message: '这里像是手写的参考文献或 DOI。正式引用请让 Heurion 检索并登记（编号与参考文献表会自动生成），手写引用不会进入参考文献表。',
        })
      }
    }
  }
}
