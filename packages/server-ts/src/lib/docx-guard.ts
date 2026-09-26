/**
 * #1074-4/#1129 — DOCX zip 炸弹预扫守卫（从 document-extractor 拆出，
 * P2 大文件棘轮；文本路径与 vision 图片路径共用同一入口检查）。
 */
import { assertZipBombSafe } from './zip-reader.js'

/** 解压后总字节上限（声明量 + 逐条有界解压双重防护）。 */
export const DOCX_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
export const DOCX_MAX_ZIP_ENTRIES = 2000

export function assertDocxArchiveSafe(buffer: Buffer): void {
  try {
    assertZipBombSafe(buffer, { maxEntries: DOCX_MAX_ZIP_ENTRIES, maxTotalUncompressed: DOCX_MAX_UNCOMPRESSED_BYTES })
  } catch (err) {
    throw new Error(`DOCX archive rejected: ${(err as Error).message}`)
  }
}
