/**
 * #752-qa: LLM 润色输出净化 — 模型常把元评论混进正文
 * ("## Polished Text" 标题、"Key Changes" 修改说明、"Let me know…"
 * 收尾语、偶发字面 "undefined"),这些都不能写进用户文档。
 * 纯函数,单测覆盖各形态。
 */
export function sanitizePolishOutput(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').trim()
  if (!text) return ''

  // 1) 偶发字面 "undefined"/"null" 前缀(序列化边界事故残留)
  text = text.replace(/^(undefined|null)\s*(?:\n+|$)/, '')

  // 2) 剥离 "Polished Text/润色后/润色结果" 式自加标题(独立行,可有 #/* 装饰)
  text = text.replace(/^\s*(?:#{1,6}\s*|[*_>\-\s]*)polished\s*text(?:\s*[*_]*)?\s*\n+/i, '')
  text = text.replace(/^\s*(?:#{1,6}\s*|[*_>\-\s]*)(?:润色(?:后|结果)?(?:文本|稿)?|修改后(?:的)?(?:文本|稿)?)\s*(?:[*_]*)?\s*\n+/i, '')

  // 3) 从 "Key Changes/Changes/修改说明/主要修改…" 元评论节开始整体截断。
  //    关键词后用前瞻而非 \b — CJK 与 \n 之间不存在 \b,\b 会让中文标记
  //    永不匹配;"changed the protocol" 这类正文行因后随字母被前瞻拒绝。
  const metaMarker = /^\s*(?:#{1,6}\s*|[*_>\-\s*]*(?:\d+[.)]\s*)?)(key\s*changes?|changes?(?:\s*(?:&|and)\s*(?:fixes|improvements))?|修改(?:说明|摘要|内容)?|主要修改|变更说明|note[s]?\s*on\s*changes)(?=\s*(?:[:：]|[-–—*]\s|\n|$)).*$/im
  const metaIdx = text.search(metaMarker)
  if (metaIdx > 0) text = text.slice(0, metaIdx)

  // 4) 剥离 "Let me know…/如需…请告诉我/希望这…" 收尾语(整句)
  text = text.replace(/\n+\s*(?:—\s*)?(?:Let me know[^.]*\.?|Feel free to[^.]*\.?|I hope this[^.]*\.?|如(?:果)?(?:你)?(?:需要|希望)[^。！？]*[。！?]?|请?(?:随时)?告诉[^。！？]*[。！?]?|希望(?:这|以上)[^。！？]*[。！?]?|如果需要[^。！？]*[。！?]?)\s*$/i, '')

  // 5) XSS 面:TipTap Link 会保留 href — 剥离 javascript:/data: 协议链接
  text = text.replace(/\[([^\]]*)\]\(\s*(?:javascript|data)\s*:[^)]*\)/gi, '$1')

  return text.trim()
}
