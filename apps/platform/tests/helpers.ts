import { parseBlocks } from '../src/model/markdown.ts'
import { Documents } from '../src/model/runtime.ts'
import { schema } from '../src/model/schema.ts'
import { OpService } from '../src/ops/service.ts'
import { Store } from '../src/store/db.ts'

export function setup(markdown?: string) {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const content = markdown ? schema.node('doc', null, parseBlocks(markdown)) : undefined
  const row = docs.create({ owner: 'u1', title: '测试', content })
  return { store, docs, ops, docId: row.id }
}

/** 顶层块 id 列表。 */
export function ids(docs: Documents, docId: string): string[] {
  const out: string[] = []
  docs.get(docId).forEach(n => out.push(n.attrs.id as string))
  return out
}
