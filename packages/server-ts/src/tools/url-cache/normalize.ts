/**
 * #858 — 缓存 key 归一化(纯函数)。
 *
 * 以拼接修复后的最终 URL 为基础做内容等价归一:
 *  - scheme+host 小写、去默认端口(80/443)、去 fragment;
 *  - 剔除鉴权/polite 参数(api_key/mailto/email)— 不影响内容,避免 env
 *    变更整批 miss,密钥不进 key;
 *  - 剔除追踪参数(utm 前缀 / fbclid / gclid);
 *  - 其余 query 参数按参数名排序后序列化(排序保证同内容同 key);
 *  - v1 不做 DOI 级归一(同一论文经不同镜像 URL 视为不同条目,#863 二期)。
 */

const AUTH_PARAMS = new Set(['api_key', 'mailto', 'email'])
const TRACKING_RE = /^(?:utm_|fbclid|gclid)/i

export function normalizeCacheKey(raw: string): string {
  try {
    const url = new URL(raw)
    url.hash = ''
    url.hostname = url.hostname.toLowerCase()
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = ''
    }
    const kept: Array<[string, string]> = []
    for (const [k, v] of url.searchParams.entries()) {
      if (AUTH_PARAMS.has(k.toLowerCase())) continue
      if (TRACKING_RE.test(k)) continue
      kept.push([k, v])
    }
    kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    url.search = ''
    for (const [k, v] of kept) url.searchParams.append(k, v)
    return url.toString()
  } catch {
    // 非法 URL 原样返回(调用方自行兜底;externalRequest 构造的 URL 不会走到这)
    return raw
  }
}
