import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DocKind, Store, VersionRow, VersionSource } from '../db.ts'

/** 工作区里的权威文件名：模型只改这个文件，其余是脚本与临时产物。 */
export function canonicalFileName(kind: DocKind): string {
  return kind === 'docx' ? 'document.docx' : 'deck.pptx'
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/**
 * 文档文件的版本库：heurion 保存的版本副本是权威副本，dsh 工作区只是执行现场。
 * 回合前把 head 版本写入工作区，回合后按哈希判断是否产生新版本。
 */
export class DocFiles {
  constructor(
    private readonly store: Store,
    private readonly workspacesDir: string,
    private readonly versionsDir: string,
  ) {}

  workspaceDir(docId: string): string {
    const dir = join(this.workspacesDir, docId)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  workspaceFile(docId: string, kind: DocKind): string {
    return join(this.workspaceDir(docId), canonicalFileName(kind))
  }

  versionFile(docId: string, seq: number, kind: DocKind): string {
    return join(this.versionsDir, docId, `${seq}.${kind}`)
  }

  private saveVersion(docId: string, kind: DocKind, bytes: Uint8Array, source: VersionSource, note: string): VersionRow {
    const version = this.store.addVersion(docId, sha256(bytes), source, note)
    const path = this.versionFile(docId, version.seq, kind)
    mkdirSync(join(this.versionsDir, docId), { recursive: true })
    writeFileSync(path, bytes)
    return version
  }

  importUpload(docId: string, kind: DocKind, bytes: Uint8Array): VersionRow {
    return this.saveVersion(docId, kind, bytes, 'upload', '上传')
  }

  /** 回合开始：把 head 版本覆盖写入工作区，返回基准哈希（无版本时为 null）。 */
  materializeHead(docId: string): string | null {
    const doc = this.store.getDoc(docId)
    if (!doc) throw new Error(`doc ${docId} not found`)
    if (doc.head_seq === 0) return null
    const src = this.versionFile(docId, doc.head_seq, doc.kind)
    copyFileSync(src, this.workspaceFile(docId, doc.kind))
    return this.store.getVersion(docId, doc.head_seq)!.sha256
  }

  /** 回合结束：工作区文件变化了就落一个 AI 版本。 */
  snapshotAfterTurn(docId: string, baseSha: string | null, note: string): VersionRow | null {
    const doc = this.store.getDoc(docId)
    if (!doc) throw new Error(`doc ${docId} not found`)
    const path = this.workspaceFile(docId, doc.kind)
    if (!existsSync(path)) return null
    const bytes = readFileSync(path)
    if (sha256(bytes) === baseSha) return null
    return this.saveVersion(docId, doc.kind, bytes, 'ai', note)
  }

  /** 回滚 = 把旧版本复制成新的 head 版本（历史只增不改）。 */
  restore(docId: string, seq: number): VersionRow {
    const doc = this.store.getDoc(docId)
    if (!doc) throw new Error(`doc ${docId} not found`)
    if (!this.store.getVersion(docId, seq)) throw new Error(`version ${seq} not found`)
    const bytes = readFileSync(this.versionFile(docId, seq, doc.kind))
    return this.saveVersion(docId, doc.kind, bytes, 'restore', `回滚到 v${seq}`)
  }

  readVersion(docId: string, seq: number): Uint8Array {
    const doc = this.store.getDoc(docId)
    if (!doc) throw new Error(`doc ${docId} not found`)
    return readFileSync(this.versionFile(docId, seq, doc.kind))
  }
}
