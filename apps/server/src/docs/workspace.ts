import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DocKind, Store, VersionRow, VersionSource } from '../db.ts'
import { auditCommentAnchors } from './comments.ts'
import { buildProjection, computeIdSurvival, ensureDocxParaIds } from './office.ts'

/** 工作区里的权威文件名：模型只改这个文件，其余是脚本与临时产物。 */
export function canonicalFileName(kind: DocKind): string {
  return kind === 'docx' ? 'document.docx' : 'deck.pptx'
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/**
 * 文档文件的版本库：heurion 保存的版本副本是权威副本，dsh 工作区只是执行现场。
 * 回合前把 head 版本写入工作区，回合后按哈希判断是否产生新版本。
 * 每次落版同步导入投影（S1）：docx 先补 paraId（id 存进权威文件），再解析投影；
 * 与上一版投影对比得 id 存活率，写进版本 meta。
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

  private saveVersion(docId: string, kind: DocKind, rawBytes: Uint8Array, source: VersionSource, note: string): VersionRow {
    // docx：id 手术后再落版 —— 权威文件自带持久 id（DESIGN.md §4.1）。
    const withIds = kind === 'docx' ? ensureDocxParaIds(rawBytes) : { bytes: rawBytes, stats: null }
    if (withIds.stats && (withIds.stats.assigned > 0 || withIds.stats.reassigned > 0)) {
      console.log(`[office] doc ${docId}: paraId assigned=${withIds.stats.assigned} reassigned=${withIds.stats.reassigned}`)
    }
    const bytes = withIds.bytes

    // id 存活率：与落版前的 head 投影对比（对照 = 被覆盖掉的那一版）。
    const prev = this.store.getDoc(docId)
    const prevProjection = prev && prev.head_seq > 0 ? this.store.getProjection(docId, prev.head_seq)?.projection : undefined
    const projection = buildProjection(kind, bytes)
    const survival = computeIdSurvival(prevProjection, projection)

    const version = this.store.addVersion(docId, sha256(bytes), source, note,
      survival === null ? undefined : { id_survival: survival })
    const path = this.versionFile(docId, version.seq, kind)
    mkdirSync(join(this.versionsDir, docId), { recursive: true })
    writeFileSync(path, bytes)
    this.store.setProjection(docId, version.seq, projection)
    // 锚点漂移审计：每次落版后重跑（upload / AI / restore 同一入口，S2）。
    auditCommentAnchors(this.store, docId, version.seq, projection)
    return version
  }

  importUpload(docId: string, kind: DocKind, bytes: Uint8Array): VersionRow {
    // 上传（含用 Word/PowerPoint 改完再传回）= 一次用户保存：落新版本 + 重新导入投影。
    return this.saveVersion(docId, kind, bytes, 'upload', '上传')
  }

  /** 编辑面（WOPI PutFile）保存：用户手动编辑落一个 user 版本。 */
  saveUserSave(docId: string, bytes: Uint8Array, note: string): VersionRow {
    const doc = this.store.getDoc(docId)
    if (!doc) throw new Error(`doc ${docId} not found`)
    return this.saveVersion(docId, doc.kind, bytes, 'user', note)
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

  /**
   * 回合前清理工作区辅助脚本：防止模型重跑上一轮留下的 build_*.py 把文件整篇重新生成。
   * 只清根目录脚本与日志；保留 .venv（PIP_NO_INDEX 下装不回来）与权威文件。
   */
  cleanWorkspaceScripts(docId: string): void {
    const dir = this.workspaceDir(docId)
    for (const name of readdirSync(dir)) {
      if (/\.(py|sh|log)$/i.test(name)) rmSync(join(dir, name), { force: true })
    }
  }
}
