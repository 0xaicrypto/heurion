/**
 * #553 — 上传路径安全:fileId 来自客户端(multipart filename / 请求体),
 * 直接 path.join 存在任意文件读取/写入(路径穿越)。所有 upload 目录
 * 读写必须经 safeUploadPath / sanitizeFilename。
 */
import path from 'path'

/**
 * #922 重复实现收敛 — TWIN_BASE_DIR 根目录的唯一读取点。此前 ~25 处调用点
 * 各自 `path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', …)`,env 名或
 * 默认值一旦调整必然漏改。全部经 twinsRoot / twinsBaseDir / uploadsBaseDir
 * 衍生,默认值拼接结果逐点等价(对照脚本已验证:未设/空串/绝对/相对路径)。
 */
export function twinsRoot(): string {
  return process.env.TWIN_BASE_DIR || '.nexus/twins'
}

/** 用户 twin 目录(事件日志/记忆索引/截断输出等直接落在用户根下)。 */
export function twinsBaseDir(userId: string): string {
  return path.join(twinsRoot(), userId)
}

export function uploadsBaseDir(userId: string): string {
  return path.join(twinsBaseDir(userId), 'uploads')
}

/**
 * 将 fileId 安全解析为 uploads 目录内路径;含路径穿越/分隔符/绝对路径
 * 的 fileId 返回 null(调用方按缺失处理)。
 */
export function safeUploadPath(userId: string, fileId: string): string | null {
  if (!fileId) return null
  if (fileId.includes('..') || fileId.includes('/') || fileId.includes('\\') || path.isAbsolute(fileId)) {
    return null
  }
  return path.join(uploadsBaseDir(userId), fileId)
}

/** 净化 multipart 文件名:仅保留 basename、去控制字符,禁止路径分隔。 */
export function sanitizeFilename(name: string | undefined): string {
  if (!name) return 'file'
  const base = path.basename(name.replace(/\\/g, '/'))
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned || 'file'
}
