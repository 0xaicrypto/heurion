import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { DocKind, Store, VersionMeta, VersionRow, VersionSource } from '../db.ts'
import { auditCommentAnchors } from './comments.ts'
import { syncFileComments } from './office-comments.ts'
import { buildProjection, computeIdSurvival, diffProjectionOps, ensureDocxParaIds, reconcileDocxIds, reconcilePptxIds } from './office.ts'

/** 工作区里的权威文件名：模型只改这个文件，其余是脚本与临时产物。 */
export function canonicalFileName(kind: DocKind): string {
  return kind === 'docx' ? 'document.docx' : 'deck.pptx'
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/**
 * 内容指纹：投影的**无 id 规范形**（kind+text 序列）哈希。
 * 幂等判断用它而不是文件字节/文档 XML——同一份内容会以不同字节形态出现
 * （编辑保存的 paraId 规范化、模型重存、zip 压缩差异）；kind/text 不随
 * ensure/reconcile 手术变化，编辑才变化。
 */
function contentFingerprint(kind: DocKind, bytes: Uint8Array): string | null {
  try {
    const p = buildProjection(kind, bytes)
    const canon: unknown[] = (p.nodes ?? []).map(n => [n.kind, n.text])
    for (const s of p.slides ?? []) {
      canon.push(['slide', s.id])
      for (const n of s.shapes) canon.push([n.kind, n.text, n.id])
    }
    if ((p.nodes ?? []).length === 0 && (p.slides ?? []).length === 0) return null
    return sha256(Buffer.from(JSON.stringify(canon)))
  } catch {
    return null // 非法 zip：指纹不可得（调用方按"未变/坏字节"处理）
  }
}

/**
 * 文档文件的版本库：heurion 保存的版本副本是权威副本，dsh 工作区只是执行现场。
 * 回合前把 head 版本写入工作区，回合后按哈希判断是否产生新版本。
 * 每次落版同步导入投影（S1）：docx 先补 paraId（id 存进权威文件），再解析投影；
 * 与上一版投影对比得 id 存活率，写进版本 meta。
 */
export class DocFiles {
  /** 编辑器文件内评论同步完成（user/upload 落版时）——@heurion 自动触发扫描挂这里。 */
  onFileCommentsSynced: (docId: string, commentIds: string[]) => void = () => {}

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

  private saveVersion(docId: string, kind: DocKind, rawBytes: Uint8Array, source: VersionSource, note: string, extraMeta?: VersionMeta): VersionRow {
    // docx：id 手术后再落版 —— 权威文件自带持久 id（DESIGN.md §4.1）。
    const ensured = kind === 'docx' ? ensureDocxParaIds(rawBytes) : { bytes: rawBytes, stats: null }
    if (ensured.stats && (ensured.stats.assigned > 0 || ensured.stats.reassigned > 0)) {
      console.log(`[office] doc ${docId}: paraId assigned=${ensured.stats.assigned} reassigned=${ensured.stats.reassigned}`)
    }

    // id 对齐重建（S4）：Collabora / LibreOffice 回写会把全部 id 重新生成 ——
    // 用文本对齐把「文本未变」的段落/形状恢复成上一版 id，评论锚点才跨编辑器存活。
    const doc = this.store.getDoc(docId)
    const prevProjection = doc && doc.head_seq > 0 ? this.store.getProjection(docId, doc.head_seq)?.projection : undefined
    const reconciled = kind === 'docx'
      ? reconcileDocxIds(prevProjection, ensured.bytes)
      : reconcilePptxIds(prevProjection, ensured.bytes)
    if (reconciled.remapped > 0) console.log(`[office] doc ${docId}: id remapped=${reconciled.remapped}`)
    const bytes = reconciled.bytes

    const projection = buildProjection(kind, bytes)
    const survival = computeIdSurvival(prevProjection, projection)

    // 用户保存提取节点变更摘要（S5 合并输入）；AI/回滚不产 user_ops。
    const userOps = source === 'user' ? diffProjectionOps(prevProjection, projection) : null
    const meta = { ...(survival === null ? {} : { id_survival: survival }), ...(userOps ? { user_ops: userOps } : {}), ...(extraMeta ?? {}) }

    const version = this.store.addVersion(docId, sha256(bytes), source, note,
      Object.keys(meta).length ? meta : undefined)
    const path = this.versionFile(docId, version.seq, kind)
    mkdirSync(join(this.versionsDir, docId), { recursive: true })
    writeFileSync(path, bytes)
    this.store.setProjection(docId, version.seq, projection)
    // 锚点漂移审计：每次落版后重跑（upload / user / AI / restore 同一入口，S2）。
    auditCommentAnchors(this.store, docId, version.seq, projection)
    // 编辑器文件内评论 → 评论表（docx/pptx 通用）；
    // user 主动落版后一律交给自动触发扫描（scan 自带水位去重；
    // 去重保存也扫——覆盖「旧线程补 @heurion」的死角；AI 自身保存不触发，防自召唤循环）。
    if (source === 'user' || source === 'upload') {
      this.onFileCommentsSynced(docId, syncFileComments(this.store, docId, bytes).commentIds)
    }
    return version
  }

  importUpload(docId: string, kind: DocKind, bytes: Uint8Array): VersionRow {
    // 上传（含用 Word/PowerPoint 改完再传回）= 一次用户保存：落新版本 + 重新导入投影。
    return this.saveVersion(docId, kind, bytes, 'upload', '上传')
  }

  /**
   * 编辑面（WOPI PutFile）保存。幂等：内容与 head 相同时不落空版本，
   * 但**评论同步与 @heurion 扫描照跑**（评论添加本身不改变正文，用户可能
   * 只加评论就 Ctrl+S —— 触发链路不能依赖「内容变了」）。
   */
  saveUserSave(docId: string, bytes: Uint8Array, note: string): { version: VersionRow | null; synced: boolean } {
    const doc = this.store.getDoc(docId)
    if (!doc) throw new Error(`doc ${docId} not found`)
    const changed = contentFingerprint(doc.kind, bytes) !== (doc.head_seq > 0 ? contentFingerprint(doc.kind, this.readVersion(docId, doc.head_seq)) : null)
    const version = changed ? this.saveVersion(docId, doc.kind, bytes, 'user', note) : null
    const ids = syncFileComments(this.store, docId, bytes).commentIds
    this.onFileCommentsSynced(docId, ids)
    return { version, synced: true }
  }

  /** 回合结束发现 head 是中间快照且字节一致 → 转正：去 intermediate 标记、换真实 note。 */
  finalizeIntermediate(docId: string, note: string): VersionRow | null {
    const doc = this.store.getDoc(docId)
    if (!doc || doc.head_seq === 0) return null
    const head = this.store.getVersion(docId, doc.head_seq)!
    if (!head.meta?.intermediate) return null
    const meta = { ...head.meta }
    delete meta.intermediate
    this.store.updateVersion(docId, doc.head_seq, note, meta)
    return this.store.getVersion(docId, doc.head_seq)!
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
    const fp = contentFingerprint(doc.kind, bytes)
    if (fp === null) return null // 损坏/半成品字节：不落（结构检查由 dsh office 技能负责）
    // 幂等：与当前 head 相同（中间快照已把它落过）→ 不重复落版。
    if (doc.head_seq > 0 && fp === contentFingerprint(doc.kind, this.readVersion(docId, doc.head_seq))) return null
    if (baseSha !== null && sha256(bytes) === baseSha) return null
    return this.saveVersion(docId, doc.kind, bytes, 'ai', note)
  }

  /**
   * 回合进行中的进度快照（边改边看）：工作区出现「zip 有效 + 与 head 不同」的
   * 中间状态就落一个中间版本 → LastModifiedTime 变化 → 编辑器自动刷新。
   * 由 TurnService 节流调用；中间版 meta.intermediate=true，UI 折叠显示。
   */
  snapshotIntermediate(docId: string): VersionRow | null {
    const doc = this.store.getDoc(docId)
    if (!doc) throw new Error(`doc ${docId} not found`)
    const path = this.workspaceFile(docId, doc.kind)
    if (!existsSync(path)) return null
    const bytes = readFileSync(path)
    const fp = contentFingerprint(doc.kind, bytes)
    if (fp === null) return null // 半成品/损坏 zip：不落，等下个周期
    if (doc.head_seq > 0 && fp === contentFingerprint(doc.kind, this.readVersion(docId, doc.head_seq))) return null
    return this.saveVersion(docId, doc.kind, bytes, 'ai', 'AI 编辑中…（进行中快照）', { intermediate: true })
  }

  /** S5：三方合并后的 AI 版本直接落库（字节已合并好，不依赖工作区）。 */
  landMerged(docId: string, bytes: Uint8Array, note: string): VersionRow {
    const doc = this.store.getDoc(docId)
    if (!doc) throw new Error(`doc ${docId} not found`)
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
