import zlib from 'zlib'

/**
 * #777 — 零依赖 ZIP 读取器（pptx = zip + XML）。
 *
 * 动机：server-ts 无 zip 依赖（jszip 只是 worker 侧传递依赖），pptx 解析
 * 只需要"按名称读条目"这一种能力。直接解析中央目录（End of Central
 * Directory → Central Directory → Local Header）+ zlib.inflateRawSync，
 * 天然实现安全约束：
 *   - 条目数上限 / 解压后总大小上限（zip 炸弹防护 — 超限直接抛错，
 *     不做流式解压就不会物化超大输出）；
 *   - 加密 zip（gp flag bit 0）识别 → 可读报错；
 *   - 只按需解压选中的条目。
 * 不支持 ZIP64（>4GB / >65535 条目）— 上传预检已限制文件 ≤150MB，pptx
 * 条目数远小于上限；遇到即抛错（与损坏同路处理）。
 */

export interface ZipEntry {
  name: string
  data: Buffer
}

export interface ZipReadOptions {
  /** 条目数上限（zip 炸弹防护）。 */
  maxEntries?: number
  /** 解压后总大小上限（bytes）。 */
  maxTotalUncompressed?: number
  /** 只读取命中过滤器的条目（先查名再解压）。 */
  filter?: (name: string) => boolean
}

export class ZipReadError extends Error {}

function findEocd(buf: Buffer): number {
  // EOCD 最少 22 字节，注释最长 65535 — 从尾部向前扫。
  const minStart = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return i
  }
  throw new ZipReadError('not a zip archive (no end-of-central-directory record)')
}

export function readZipEntries(buf: Buffer, options: ZipReadOptions = {}): ZipEntry[] {
  const maxEntries = options.maxEntries ?? 5000
  const maxTotal = options.maxTotalUncompressed ?? 300 * 1024 * 1024

  const eocd = findEocd(buf)
  const totalEntries = buf.readUInt16LE(eocd + 10)
  let cdOffset = buf.readUInt32LE(eocd + 16)
  // 注释/多段偏移 quirks:EOCD 里 cd offset 为 0xFFFFFFFF 即 ZIP64 — 不支持。
  if (cdOffset === 0xffffffff) throw new ZipReadError('zip64 archives are not supported')
  if (totalEntries === 0xffff) throw new ZipReadError('zip64 archives are not supported')
  if (totalEntries > maxEntries) throw new ZipReadError(`zip has too many entries (${totalEntries} > ${maxEntries})`)

  const out: ZipEntry[] = []
  let totalUncompressed = 0
  for (let i = 0; i < totalEntries; i++) {
    if (cdOffset + 46 > buf.length || buf.readUInt32LE(cdOffset) !== 0x02014b50) {
      throw new ZipReadError('corrupt central directory')
    }
    const gpFlags = buf.readUInt16LE(cdOffset + 8)
    const method = buf.readUInt16LE(cdOffset + 10)
    const compressedSize = buf.readUInt32LE(cdOffset + 20)
    const uncompressedSize = buf.readUInt32LE(cdOffset + 24)
    const nameLen = buf.readUInt16LE(cdOffset + 28)
    const extraLen = buf.readUInt16LE(cdOffset + 30)
    const commentLen = buf.readUInt16LE(cdOffset + 32)
    const localOffset = buf.readUInt32LE(cdOffset + 42)
    const name = buf.slice(cdOffset + 46, cdOffset + 46 + nameLen).toString('utf-8')

    const nextCd = cdOffset + 46 + nameLen + extraLen + commentLen

    const wanted = options.filter ? options.filter(name) : true
    if (wanted) {
      // eslint-disable-next-line no-bitwise
      if (gpFlags & 0x1) throw new ZipReadError(`entry "${name}" is encrypted (加密压缩包不受支持 — 请解除密码后重新上传)`)
      if (method !== 0 && method !== 8) throw new ZipReadError(`entry "${name}" uses unsupported compression method ${method}`)
      // 本地头长度可能与中央目录不同 — 数据偏移必须用本地头自己的字段。
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new ZipReadError(`corrupt local header for "${name}"`)
      }
      const localNameLen = buf.readUInt16LE(localOffset + 26)
      const localExtraLen = buf.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLen + localExtraLen
      const dataEnd = dataStart + compressedSize
      if (dataEnd > buf.length) throw new ZipReadError(`entry "${name}" exceeds file bounds`)
      totalUncompressed += uncompressedSize
      if (totalUncompressed > maxTotal) {
        throw new ZipReadError(`zip expands beyond ${Math.round(maxTotal / 1024 / 1024)}MB (zip bomb protection)`)
      }
      const compressed = buf.slice(dataStart, dataEnd)
      const data = method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed)
      out.push({ name, data })
    }
    cdOffset = nextCd
  }
  return out
}
