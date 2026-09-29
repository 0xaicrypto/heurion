/**
 * #1134 — 审阅/注入的正文比较与显示 token 复用。
 *
 * 库内正文是无 token 规范形态（#1128 落库剥离），读取/写回推送时服务端
 * 重签新 token。前端本地正文持有的是旧 token：直接逐字节 diff 会把每条
 * 下载链接都显示成改动。进入审阅前用本地同 fileId 的 token 替换 incoming
 * 的 token —— 链接字节一致，diff 只呈现真实内容变化；本地没有的新文件
 * （AI 生成图）保留 incoming token 供渲染。
 */
export function reuseLocalFileTokens(localBody: string, incomingBody: string): string {
  const localTokens = new Map<string, string>()
  for (const m of localBody.matchAll(/\/api\/v1\/files\/download\/([\w.-]+)\?token=([^\s)"'\\]*)/g)) {
    localTokens.set(m[1], m[2])
  }
  if (localTokens.size === 0) return incomingBody
  return incomingBody.replace(
    /\/api\/v1\/files\/download\/([\w.-]+)(?:\?token=[^\s)"'\\]*)?/g,
    (full, id: string) => {
      const token = localTokens.get(id)
      return token ? `/api/v1/files/download/${id}?token=${token}` : full
    },
  )
}
