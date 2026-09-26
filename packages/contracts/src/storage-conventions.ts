/**
 * 存储域命名约定 — server/worker 跨包共享的单源常量。
 *
 * 工件文件 id 前缀是「存储域判别键」（uploads 列表域分离，chart_/img_ 同
 * 先例），消费方不只 server-ts：worker 的 TTL 清理（#1108）靠同一前缀
 * 保护 deck 工件。常量收进 contracts 后，server 改前缀时 worker 的保护
 * 自动跟随，不再出现「注释点名权威常量、代码硬编码字符串」的双份漂移。
 */

/** deck 工件文件 id 前缀（`deck-<docId>-<ts>.pptx`）— 存储域判别键
 *  （uploads 列表域分离同 chart_/img_ 先例）。工件 id 被
 *  Doc.deckArtifactId 永久引用；worker 清理默认保护
 *  （DEFAULT_PROTECTED_PREFIXES 引用此值，cleanup.ts 单源 import）。 */
export const DECK_FILE_ID_PREFIX = 'deck-'

/**
 * #1128: 文件下载 URL token 归一化 — 正文里的下载链接在读取时按次重签
 * `?token=<exp.sig>`（server chart-token.refreshFileUrls 只改写响应、不落库）。
 * 同一正文不同次读取字节不同；base_sha 并发指纹与 bodyChanged 判定必须先过
 * 本归一化（剥 token + 旧版 `/files/:id/download` 形状统一到 canonical 无
 * token 形式），否则「展示层 token 差异」会被误判为并发修改 → 保存冲突
 * 横幅死循环。server（写库/比对）与 web（计算 base_sha）共用同一实现，防
 * 双份正则漂移（该 bug 本身即双份口径不一致的产物）。
 */
export function normalizeFileDownloadTokens(text: string): string {
  return text
    .replace(/\/api\/v1\/files\/download\/([\w.-]+)(?:\?token=[^\s)"'\\]*)?/g, '/api/v1/files/download/$1')
    .replace(/\/api\/v1\/files\/(?!download\/|preview-page\/)([\w.-]+)\/download(?:\?token=[^\s)"'\\]*)?/g, '/api/v1/files/download/$1')
}
