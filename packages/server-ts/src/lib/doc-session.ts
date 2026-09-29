/** #1146 循环依赖:doc- 会话 id 解析下沉 lib(叶子) — 工具与 modules 都
 * 从这里取,不再经 tools/tool-registry 反向依赖。 */
/**
 * #905: doc- 会话的 docId 解析与格式校验 — sessionId 形如 `doc-<docId>`,
 * docId 必须匹配 documents.router 的生成格式(`doc_` + 16 hex,uid() =
 * crypto.randomBytes(8).toString('hex'))。不匹配的会话(伪造/遗留格式)
 * 按 general 场景处理:不暴露 doc 工具、不注入 document_context、工具层
 * 拒绝执行 — 杜绝用任意 sessionId 前缀拼出 docId 的盲取。
 */
const DOC_SESSION_DOC_ID_RE = /^doc_[a-f0-9]{16}$/

export function parseDocSessionId(sessionId: string | null | undefined): string | null {
  if (!sessionId || !sessionId.startsWith('doc-')) return null
  const docId = sessionId.slice(4)
  return DOC_SESSION_DOC_ID_RE.test(docId) ? docId : null
}
