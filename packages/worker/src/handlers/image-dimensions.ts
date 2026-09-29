/**
 * #1148 — 图片像素尺寸解析（PNG/JPEG/GIF/BMP 头；WebP/SVG 返回 null）。
 * docx 导出此前固定 240×120 拉伸所有图片（比例失真）；调用方按原图比例
 * 缩放到上限框内，未知尺寸回退旧行为。
 */

export interface ImageDimensions {
  width: number
  height: number
}

/** PNG: IHDR 宽高（大端 u32 @16/@20）。 */
function pngDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** GIF: 逻辑屏幕宽高（小端 u16 @6/@8）。 */
function gifDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 10) return null
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
}

/** BMP: 像素宽高（小端 i32 @18/@22，可为负即自上而下）。 */
function bmpDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 26) return null
  const width = Math.abs(buf.readInt32LE(18))
  const height = Math.abs(buf.readInt32LE(22))
  return { width, height }
}

/** JPEG: 扫 SOF0-3/5-7/9-11 段（排除 DHT/DAC 等），高 @+5 宽 @+7。 */
function jpegDimensions(buf: Buffer): ImageDimensions | null {
  let i = 2 // 跳过 SOI
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const marker = buf[i + 1]
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue }
    const len = buf.readUInt16BE(i + 2)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (i + 9 >= buf.length) return null
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    if (len < 2) return null
    i += 2 + len
  }
  return null
}

/** magic bytes → 像素尺寸；无法解析（WebP/SVG/畸形）返回 null。 */
export function imageDimensionsOf(buf: Buffer): ImageDimensions | null {
  if (buf.length < 4) return null
  if (buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return pngDimensions(buf)
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return jpegDimensions(buf)
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return gifDimensions(buf)
  if (buf[0] === 0x42 && buf[1] === 0x4d) return bmpDimensions(buf)
  return null
}

/** #1148: 等比缩放进 maxW×maxH 框（保留宽高比）；未知尺寸回退 240×120。
 *  放大小图到框内（与旧行为一致的可见尺寸），比例不拉伸。 */
export function fitImageBox(
  dims: ImageDimensions | null,
  maxW = 480,
  maxH = 360,
): { width: number; height: number } {
  if (!dims || dims.width <= 0 || dims.height <= 0) return { width: 240, height: 120 }
  const scale = Math.min(maxW / dims.width, maxH / dims.height)
  return {
    width: Math.max(8, Math.round(dims.width * scale)),
    height: Math.max(8, Math.round(dims.height * scale)),
  }
}
