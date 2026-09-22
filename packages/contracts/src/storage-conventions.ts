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
