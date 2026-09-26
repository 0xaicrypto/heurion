import fs from 'node:fs'
import path from 'node:path'

/**
 * 原子文件写原语 — 持久化 JSONL/索引整体重写绝不原地覆盖：
 * 同目录临时文件 → fsync → rename（同文件系统 rename 原子），进程在
 * 写入中途崩溃时旧文件保持完整，读者永远看不到半截内容。
 * 临时名带 pid + 序号，避免并发/重入互相覆盖。
 */
let seq = 0

function tmpPathFor(filePath: string): string {
  seq = (seq + 1) % 1_000_000
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}-${seq}`)
}

export function atomicWriteFileSync(filePath: string, data: string | Buffer): void {
  const tmp = tmpPathFor(filePath)
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.renameSync(tmp, filePath)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* 清理 best-effort */ }
    throw err
  }
}

export async function atomicWriteFile(filePath: string, data: string | Buffer): Promise<void> {
  const tmp = tmpPathFor(filePath)
  const handle = await fs.promises.open(tmp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.promises.rename(tmp, filePath)
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => { /* 清理 best-effort */ })
    throw err
  }
}
