/**
 * #882 — 内容指纹(并发保存保护用)。Web Crypto 的 SHA-1(浏览器安全上下文
 * 可用);服务端 PUT /docs 以 base_sha 与当前正文指纹比对,不匹配 → 409。
 */
export async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-1', data)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}
