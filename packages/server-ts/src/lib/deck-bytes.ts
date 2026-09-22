/**
 * #1101（pptx 字节单一标准）— deck 工件存储 + DeckWire 投影重建。
 *
 * 存储契约（docs/design/DECK_PPTX_SINGLE_STANDARD.md §3）：
 *   Doc.deckArtifactId → FileIndex 工件（真实 pptx 字节）   ← 唯一持久真相源
 *   Doc.deck           → DeckWire 投影缓存（pptx-extractor 重建，可随时清空重建）
 *
 * 写路径（putDeckArtifact）：
 *   字节落 FileIndex（sha256 去重）→ parsePptx + pptxSlidesToDeck 重建投影 →
 *   writeDocVersion 单点落库（deck 侧 baseDeck 乐观锁）→ 条件更新
 *   deckArtifactId。投影过期规则：工件比 Doc 行新 = 投影写未发生 → 按未
 *   投影处理（blockProjection 先例语义，#989）。
 *   复审轮 1（Fix 4+5）：工件行/物理文件落盘后任何一步失败（投影异常/
 *   writeDocVersion 冲突/指针 0 行）→ rollbackArtifactUpload 补偿（只删本次
 *   创建的行+文件，去重复用的行不动）→ 冲突/错误上返调用方映射 409/404，
 *   不再留孤儿工件、指针 0 行不再假成功。
 *
 * 分层说明：lib 层直写 FileIndex（复刻 files.service claimFileIndex 最小
 * 认领逻辑，不 import modules/*，分层 #672/#940）— deck 工件不走
 * finalizeUpload 管线（不进知识索引/图谱，它不是知识文档而是编辑真相源）。
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import prisma from '../common/prisma.js'
import { uploadsBaseDir, safeUploadPath } from './upload-path.js'
import { parsePptx, pptxSlidesToDeck, PPTX_MIME_TYPE } from './pptx-extractor.js'
import { writeDocVersion } from '../tools/doc-version-writer.js'
import { SCHEMA_VERSION } from '@heurion/contracts'
import { makeLogger } from '../common/logger.js'

const log = makeLogger('deck-bytes')

/** 单工件体积上限（真实 deck 十几 KB~几 MB，余量给图片密集产物）。 */
export const MAX_DECK_BYTES = 50 * 1024 * 1024

/** 工件文件 id 前缀 — 存储域判别键（uploads 列表域分离同 chart_/img_ 先例）。 */
export const DECK_FILE_ID_PREFIX = 'deck-'

export class DeckBytesError extends Error {
  constructor(message: string, readonly status: 'not-found' | 'conflict' | 'invalid' = 'invalid') {
    super(message)
  }
}

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/* ── pptx-viewer-core 懒加载（引擎较重，避免常驻启动面） ───────────── */

type CoreModule = typeof import('pptx-viewer-core')
let corePromise: Promise<CoreModule> | null = null

function loadCore(): Promise<CoreModule> {
  corePromise ??= import('pptx-viewer-core')
  return corePromise
}

/* ── FileIndex 工件写/读（files.service claimFileIndex 的最小复刻） ── */

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as any).code === 'P2002'
}

/** deck 工件 id：`deck-<docId>-<ts>.pptx`（id 内嵌时间戳 — 内容变则 id 变）。 */
function newDeckFileId(docId: string): string {
  return `${DECK_FILE_ID_PREFIX}${docId}-${Date.now()}.pptx`
}

/**
 * pptx 字节 → FileIndex 工件（uploads 物理文件 + file_index 行）。
 * sha256 去重：同用户存活行 + 盘上文件存在 → 复用（same bytes = same file，
 * 与上传 dedup 同语义）；并发 P2002 → 重读胜者收场。刻意不走
 * finalizeUpload：无 patientHash/管线/DocumentNode（见文件头分层说明）。
 */
async function storeDeckFile(userId: string, docId: string, bytes: Buffer): Promise<{ artifactId: string; dedup: boolean }> {
  const sha256 = sha256Hex(bytes)
  const dir = uploadsBaseDir(userId)

  const existing = await prisma.fileIndex.findFirst({ where: { userId, sha256 } })
  if (existing && !existing.deletedAt) {
    try {
      fs.accessSync(path.join(dir, existing.id))
      return { artifactId: existing.id, dedup: true }
    } catch {
      // 索引指向已被删/改名的物理文件 → 按无去重处理，走下方认领。
    }
  }

  const fileId = newDeckFileId(docId)
  const now = new Date().toISOString()
  const createData = {
    id: fileId,
    userId,
    sha256,
    name: fileId,
    mime: PPTX_MIME_TYPE,
    sizeBytes: bytes.length,
    patientHash: null,
    createdAt: now,
    updatedAt: now,
  }
  fs.mkdirSync(dir, { recursive: true })
  try {
    fs.writeFileSync(path.join(dir, fileId), bytes)
    await prisma.fileIndex.create({ data: createData })
    return { artifactId: fileId, dedup: false }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    // 并发写入同字节赢了认领（(userId,sha256) 唯一）→ 清理我方文件，复用胜者。
    const winner = await prisma.fileIndex.findFirst({ where: { userId, sha256 }, orderBy: { createdAt: 'asc' } })
    fs.rmSync(path.join(dir, fileId), { force: true })
    if (winner && !winner.deletedAt) return { artifactId: winner.id, dedup: true }
    // 胜者是软删/脏行 → 删行重建（认领收场，与 claimFileIndex 同款）。
    await prisma.fileIndex.deleteMany({ where: { id: winner ? winner.id : '', userId } })
    fs.writeFileSync(path.join(dir, fileId), bytes)
    await prisma.fileIndex.create({ data: createData })
    return { artifactId: fileId, dedup: false }
  }
}

/* ── 投影重建（pptx-extractor 单一实现） ─────────────────────────── */

/** DeckWire 投影对象（pptxSlidesToDeck 返回形状，contracts 契约模型）。 */
export type DeckWireProjection = NonNullable<ReturnType<typeof pptxSlidesToDeck>>

/**
 * pptx 字节 → DeckWire 投影对象。解析失败/无页面 → null（设计 §3.1 允许
 * 投影缺省 — 真相源是字节本身，读侧按未投影处理）。
 */
export function rebuildDeckProjectionObject(bytes: Buffer, title?: string): unknown {
  const parsed = parsePptx(bytes)
  if (!parsed.ok) {
    log.info('deck projection rebuild skipped (unparseable bytes)', { reason: (parsed.error || 'unknown').slice(0, 120) })
    return null
  }
  return pptxSlidesToDeck(parsed.slides, parsed.images, title || 'Presentation', SCHEMA_VERSION)
}

/** 投影 JSON 字符串（null = 无投影）。 */
export function rebuildDeckProjection(bytes: Buffer, title?: string): string | null {
  const deck = rebuildDeckProjectionObject(bytes, title)
  return deck ? JSON.stringify(deck) : null
}

/**
 * 投影新鲜度（mtime/version 比较 — blockProjection「绝不信任过期投影」
 * 先例的 deck 侧等价物）：工件比 Doc 行新 = 工件写入后投影写未发生
 * （中断/历史路径）→ 'stale'。工件早于或同刻于 Doc 行 → 'fresh'
 * （putDeckArtifact 写序：工件先、投影后）。
 */
export function deckProjectionStaleness(
  doc: { updatedAt: string; deck: string | null } | null,
  artifact: { id: string; updatedAt: string } | null,
): 'fresh' | 'stale' | 'missing-artifact' {
  if (!artifact) return 'missing-artifact'
  if (!doc || !doc.deck) return 'stale'
  return new Date(artifact.updatedAt) > new Date(doc.updatedAt) ? 'stale' : 'fresh'
}

/* ── DeckWire → pptx 字节（迁移/回退序列化器） ───────────────────── */

/** DeckWire 块的宽松形状（contracts contentBlockSchema 的 wire 子集）。 */
interface LooseDeckBlock {
  type?: unknown
  text?: unknown
  style?: unknown
  ref?: unknown
  data?: unknown
  caption?: unknown
  spec?: unknown
}

/** contracts deckThemeSchema → PresentationThemeInput（保守双色板）。 */
function mapDeckTheme(theme: unknown): { name?: string; colors?: Record<string, string>; fonts?: Record<string, string> } | undefined {
  if (theme === 'warm-paper') {
    // DESIGN_SYSTEM_v2 Apothecary Green + 暖色纸面方向（#944/#957 口径）。
    return {
      name: 'Warm Paper',
      colors: {
        dk1: '#33261D', lt1: '#FBF7F0', dk2: '#5C4632', lt2: '#EFE6D8',
        accent1: '#4F6F52', accent2: '#C8A15A', accent3: '#A6553F', accent4: '#7A6A56',
      },
      fonts: { majorFont: 'Inter', minorFont: 'Inter' },
    }
  }
  return undefined // clinical → 引擎缺省主题
}

/** DeckWire image 块 → 可用的图片 source（data URL / http ref），不可用 → null。 */
function imageSourceOf(block: LooseDeckBlock): string | null {
  const data = typeof block.data === 'string' ? block.data : ''
  if (data.startsWith('data:')) return data
  if (data) return `data:image/png;base64,${data}`
  const ref = typeof block.ref === 'string' ? block.ref : ''
  if (/^https?:\/\//i.test(ref)) return ref
  return null // asset:// 无法服务端解析 / 无来源 → 跳过
}

/**
 * DeckWire JSON → pptx 字节（pptx-viewer-core Presentation builder）。
 *
 * 定位：**迁移/回退序列化器** — 存量 DeckWire（无工件）一次性转字节
 * （scripts/migrate-deck-bytes.ts），日常真相源永远是工件本身。不是生成
 * 管线（worker pptxgenjs generatePptx 管线保持，设计 §8）。
 *
 * 容错（未知块不丢内容、不静默崩溃）：单块映射失败 → `[不支持的内容块]`
 * 子弹兜底；块数 50 上限（契约 presentationSlideSchema 同口径）。
 */
export async function serializeDeckWireToPptx(deckWire: unknown): Promise<Buffer> {
  const deck = (deckWire ?? null) as { title?: unknown; theme?: unknown; slides?: unknown } | null
  const slides = Array.isArray(deck?.slides) ? (deck!.slides as unknown[]) : []
  if (slides.length === 0) throw new DeckBytesError('DeckWire 无 slides，无法序列化 pptx 字节')

  const { Presentation } = await loadCore()
  const pres = await Presentation.create({
    title: String(deck?.title || 'Presentation').slice(0, 500),
    theme: mapDeckTheme(deck?.theme) as never,
  })
  try {
    for (let i = 0; i < Math.min(slides.length, 30); i += 1) {
      const slide = (slides[i] ?? {}) as { title?: unknown; notes?: unknown; content?: unknown }
      const builder = pres.addSlide()
      const slideTitle = String(slide.title || `第 ${i + 1} 页`).slice(0, 500)
      builder.addText(slideTitle, { x: 60, y: 40, width: 1160, height: 90, fontSize: 30, bold: true })

      const blocks = Array.isArray(slide.content) ? (slide.content as unknown[]) : []
      const bullets: string[] = []
      let imageAdded = false

      for (const raw of blocks.slice(0, 50)) {
        const block = (raw ?? {}) as LooseDeckBlock
        try {
          switch (block.type) {
            case 'paragraph': {
              const text = String(block.text ?? '').slice(0, 2000)
              if (text) bullets.push(text)
              break
            }
            case 'table': {
              const tableData = JSON.parse(String(block.data ?? '{}')) as { rows?: unknown }
              const rows = Array.isArray(tableData.rows) ? tableData.rows : []
              if (rows.length > 0) {
                builder.addTable({
                  rows: rows.slice(0, 200).map((row) => ({
                    cells: (Array.isArray(row) ? row : [String(row ?? '')]).slice(0, 30).map((cell) => ({
                      text: String(cell ?? '').slice(0, 2000),
                    })),
                  })),
                }, { x: 60, y: 160, width: 1160 })
              }
              break
            }
            case 'chart': {
              const spec = (block.spec ?? {}) as {
                chart_type?: unknown
                data?: Array<{ label?: unknown; value?: unknown }>
                title?: unknown
              }
              const data = Array.isArray(spec.data) ? spec.data : []
              if (data.length > 0) {
                const chartType = spec.chart_type === 'line' || spec.chart_type === 'dose_curve' ? 'line' : 'bar'
                builder.addChart(chartType, {
                  categories: data.map((d) => String(d?.label ?? '').slice(0, 200)),
                  series: [{ name: String(spec.title || '数据').slice(0, 100), values: data.map((d) => Number(d?.value ?? 0)) }],
                  ...(spec.title ? { title: String(spec.title).slice(0, 500) } : {}),
                }, { x: 60, y: 160, width: 1160, height: 480 })
              }
              break
            }
            case 'image': {
              const source = imageSourceOf(block)
              if (source && !imageAdded) {
                builder.addImage(source, { x: 60, y: 160, width: 640, height: 480 })
                imageAdded = true
              } else {
                bullets.push('[不支持的内容块]')
              }
              break
            }
            default:
              // figure / 未知类型 — 服务端不重渲（mermaid/latex 属 figures 管道）。
              bullets.push('[不支持的内容块]')
          }
        } catch (err) {
          log.warn('deck wire block serialization degraded', { type: String(block.type), reason: (err as Error).message.slice(0, 120) })
          bullets.push('[不支持的内容块]')
        }
      }

      if (bullets.length > 0) {
        builder.addText(bullets.join('\n'), { x: 60, y: 150, width: 1160, height: 500, fontSize: 18 })
      }

      const notes = String(slide.notes ?? '')
      if (notes) builder.setNotes(notes.slice(0, 5000))
      builder.build()
    }
    return Buffer.from(await pres.save())
  } finally {
    pres.handler.dispose()
  }
}

/* ── 工件读写 ──────────────────────────────────────────────────── */

export interface PutDeckArtifactInput {
  userId: string
  docId: string
  bytes: Buffer
  /** 调用方计算新字节时所基于的旧投影快照（Doc.deck 原始存储串，null = 无）—
   * writeDocVersion 的「调用方读 → writer 读」窗口乐观锁（与 baseBody 同强度）。 */
  baseDeck?: string | null
  /** 缺省 'human'（HTTP 保存路径）；AI 工具路径显式传 'ai'。 */
  writeSource?: 'ai' | 'human'
  /** 快照标签（writeDocVersion 单点）；缺省 'deck bytes'。 */
  snapshotLabel?: string
}

export interface PutDeckArtifactResult {
  artifactId: string
  /** 版本戳 = artifactId（内嵌 ts：内容变则 id 变；去重命中则不变 — 字节级
   * 无变化不产生新版本、不触发冲突）。X-Deck-Base 协议值。 */
  version: string
  /** deck 投影是否被本次调用实际改写。 */
  changed: boolean
  /** 重建的 DeckWire 投影 JSON（解析失败 → null）。 */
  projection: string | null
  /** 写回单点冲突（baseDeck 失配/文档不存在）— 调用方映射 409/404。 */
  conflict?: boolean
  error?: string
}

/* ── 上传补偿（#1101 复审轮 1 Fix 4+5）────────────────────────────── */

/**
 * putDeckArtifact 失败回滚（补偿，非事务）：删掉**本次调用创建**的 FileIndex
 * 行 + unlink 本次落盘的物理文件（best-effort，逐项 try/catch 只记 warn）。
 *
 * 修复的孤儿文件问题：原实现中投影重建/writeDocVersion/指针更新任一失败
 * 或冲突时直接早退，已落库的 FileIndex 行 + uploads 物理文件永久悬挂 —
 * 无任何 Doc 指针指向它们，却占存储且（同 sha 去重语义下）可能被后续
 * 上传误复用。回滚只针对「本次创建」的行（createdHere=true）：sha256 去重
 * 复用的既有行是别人的资产，绝不能删。
 *
 * 不补偿（刻意）：writeDocVersion 已提交的快照/投影变更在指针更新失败时
 * 保留 — 投影是可重建缓存（设计 §3.1），真相源未推进即无一致性破坏；
 * 并发窗口内另一写者可能已合法接管，删行反而会悬空对方的指针。
 */
async function rollbackArtifactUpload(args: { userId: string; artifactId: string; createdHere: boolean }): Promise<void> {
  if (!args.createdHere) return
  // #1101 复审轮 2（并发指认保护）: 删除前复查 — 任何 doc 仍把
  // Doc.deckArtifactId 指向该工件 → 不删。并发场景：A 创建工件行 R →
  // B（相同字节）sha256 去重命中 R 并成功指认 → A 的 writeDocVersion 因
  // baseline 被改而冲突走回滚 → 无条件删 R 会连带删掉 B 刚指向的工件
  // （B 报成功、读回 null）。事务内复查+删除最小化 TOCTOU 窗口（SQLite
  // connection_limit=1 下写本就串行，复查是双保险）。
  try {
    const refs = await prisma.doc.count({ where: { deckArtifactId: args.artifactId } })
    if (refs > 0) {
      log.warn('deck artifact rollback: skipped — artifact still referenced by concurrent doc pointer', {
        artifactId: args.artifactId, refs,
      })
      return
    }
    await prisma.$transaction(async (tx) => {
      const c = await (tx as typeof prisma).doc.count({ where: { deckArtifactId: args.artifactId } })
      if (c > 0) return
      await (tx as typeof prisma).fileIndex.delete({ where: { id: args.artifactId } })
    })
  } catch (err) {
    log.warn('deck artifact rollback: file_index delete failed (orphan row left)', {
      artifactId: args.artifactId, reason: (err as Error).message.slice(0, 120),
    })
  }
  try {
    const filepath = safeUploadPath(args.userId, args.artifactId)
    if (filepath) fs.rmSync(filepath, { force: true })
  } catch (err) {
    log.warn('deck artifact rollback: physical file unlink failed (orphan file left)', {
      artifactId: args.artifactId, reason: (err as Error).message.slice(0, 120),
    })
  }
}

/**
 * pptx 字节 → FileIndex 工件 + 投影重建 + writeDocVersion + 指针更新。
 * 归属校验由调用方负责（HTTP 归属读 / 工具 doc 会话门控）；本函数内
 * writeDocVersion 仍带 userId 条件（二道防线），冲突/文档缺失经 result
 * 返回（调用方映射 409/404），不混用异常通道。
 *
 * #1101 复审轮 1（Fix 4+5）原子性协议：工件行/物理文件（步骤①）之后任何
 * 一步失败（投影异常/writeDocVersion 冲突或错误/指针 updateMany 0 行）→
 * rollbackArtifactUpload 补偿（仅删本次创建的行 + 文件）→ 向上返回冲突/
 * 错误，不再留孤儿、不再假成功。
 */
export async function putDeckArtifact(input: PutDeckArtifactInput): Promise<PutDeckArtifactResult> {
  const { userId, docId, bytes } = input
  if (!bytes || bytes.length === 0) throw new DeckBytesError('deck bytes 为空，拒绝落工件')
  if (bytes.length > MAX_DECK_BYTES) {
    throw new DeckBytesError(`deck bytes 超过 ${Math.round(MAX_DECK_BYTES / 1024 / 1024)}MB 上限`, 'invalid')
  }

  const doc = await prisma.doc.findFirst({ where: { id: docId, userId } })
  if (!doc) {
    return { artifactId: '', version: '', changed: false, projection: null, conflict: true, error: `Document not found: ${docId}` }
  }
  const prevDeckRaw = doc.deck ?? null

  // 1) 字节落 FileIndex 工件（唯一持久真相源）。
  const stored = await storeDeckFile(userId, docId, bytes)
  const { artifactId, dedup } = stored
  // createdHere=false（sha256 去重复用既有行）→ 回滚绝不删别人的行/文件。
  const rollback = (): Promise<void> => rollbackArtifactUpload({ userId, artifactId, createdHere: !dedup })

  // 2) 投影重建（extractor 单一实现；标题跟随文档）。重建函数内部对不可解析
  //    字节已容错（返回 null，设计 §3.1 允许投影缺省）— 走不到 throw；此处
  //    仍包一层：任何意外异常同样补偿回滚（工件已落盘 = 已产生副作用）。
  let projectionObject: unknown
  try {
    projectionObject = rebuildDeckProjectionObject(bytes, doc.title)
    // 3) writeDocVersion 单点（同帧快照 + baseDeck 乐观锁）。字节无法解析时
    //    不触碰 deck 列 — 工件已落盘（真相源成立），投影缺省可重建。
    if (projectionObject) {
      const projection = JSON.stringify(projectionObject)
      const written = await writeDocVersion({
        userId,
        docId,
        deck: projectionObject as Record<string, unknown>,
        // 调用方显式基线优先（最宽的「调用方读 → writer 读」窗口保护）；
        // 未提供时回退本函数读值（仍保护「本函数读 → writer 读」窗口）。
        baseDeck: input.baseDeck !== undefined ? input.baseDeck : prevDeckRaw,
        snapshotLabel: input.snapshotLabel || 'deck bytes',
        writeSource: input.writeSource ?? 'human',
      })
      if (written.error) {
        // Fix 4/5: 冲突/错误 → 补偿回滚本次创建的工件（不留孤儿）再返回。
        await rollback()
        return {
          artifactId: '', version: '', changed: false, projection: null,
          conflict: Boolean(written.conflict), error: written.error,
        }
      }

      // 4) deckArtifactId 指针 — 存储层关注点，writeDocVersion 形状之外的条件
      //    更新：where 带写回后的 body+deck 值（写回单点刚确认过的行态），并发
      //    写者推进行后本写自动落空（0 行）。Fix 4/5：0 行 = 指针未落 → 报告
      //    成功是错的（真相源字节与 Doc 脱钩）→ 按冲突收场：回滚 + 返回冲突
      //    （调用方映射 409，模型/前端重读重试）。幂等：指针已相等时跳过。
      if (doc.deckArtifactId !== artifactId) {
        const res = await prisma.doc.updateMany({
          where: {
            id: docId,
            userId,
            body: String(written.body),
            deck: projection,
          },
          data: { deckArtifactId: artifactId },
        }).catch(() => null)
        if (!res || res.count === 0) {
          log.warn('deck artifact pointer write lost (row moved under us) — rolling back', { docId, artifactId })
          await rollback()
          return {
            artifactId: '', version: '', changed: false, projection: null,
            conflict: true,
            error: 'deck 工件写入与并发修改冲突（指针未落库），请重读文档后重试',
          }
        }
      }

      return {
        artifactId,
        version: artifactId,
        changed: written.deckChanged,
        projection,
      }
    }

    // 投影缺省（字节不可解析）— 工件保留（真相源成立），指针条件更新按
    // 调用前读值守卫（写回单点未触碰行，无写回单点确认过的行态可用）。
    if (doc.deckArtifactId !== artifactId) {
      const res = await prisma.doc.updateMany({
        where: { id: docId, userId, body: String(doc.body), deck: prevDeckRaw },
        data: { deckArtifactId: artifactId },
      }).catch(() => null)
      if (!res || res.count === 0) {
        log.warn('deck artifact pointer write lost (row moved under us) — rolling back', { docId, artifactId })
        await rollback()
        return {
          artifactId: '', version: '', changed: false, projection: null,
          conflict: true,
          error: 'deck 工件写入与并发修改冲突（指针未落库），请重读文档后重试',
        }
      }
    }

    return {
      artifactId,
      version: artifactId,
      changed: doc.deckArtifactId !== artifactId,
      projection: null,
    }
  } catch (err) {
    // 投影重建/writeDocVersion 意外异常 — 已有工件副作用 → 补偿后上抛。
    await rollback()
    throw err
  }
}

export interface DeckArtifactContent {
  artifactId: string
  bytes: Buffer
  /** 版本戳 = artifactId（X-Deck-Base 乐观协议值）。 */
  version: string
  mime: string
  updatedAt: string
}

/**
 * 读 deck 工件字节：Doc.deckArtifactId → FileIndex 行（存活）→ uploads 物理
 * 文件。任一环缺失（无指针/行被软删/盘上文件消失）→ null，调用方按 404
 * 处理（不区分「从未有工件」与「工件已失效」，反枚举同语义）。
 */
export async function getDeckArtifact(docId: string): Promise<DeckArtifactContent | null> {
  const doc = await prisma.doc.findFirst({ where: { id: docId } })
  if (!doc?.deckArtifactId) return null
  const file = await prisma.fileIndex.findFirst({
    where: { id: doc.deckArtifactId, userId: doc.userId, deletedAt: null },
  })
  if (!file) return null
  const filepath = safeUploadPath(doc.userId, file.id)
  if (!filepath || !fs.existsSync(filepath)) return null
  return {
    artifactId: file.id,
    bytes: fs.readFileSync(filepath),
    version: file.id,
    mime: file.mime || PPTX_MIME_TYPE,
    updatedAt: file.updatedAt,
  }
}
