/**
 * 防机器人：工作量证明（服务端见 src/auth/bot-guard.ts）。
 * 主应用（account.ts）与知家（phr.ts）的登录 / 注册共用这一份。
 */

export interface Challenge { challenge: string; salt: string; maxnumber: number; signature: string }
export interface PowSolution { challenge: string; salt: string; number: number; signature: string }

const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map(h => parseInt(h, 16)))

/** 领题并穷举 n 使 SHA-256(salt + n) = challenge（Web Crypto，异步逐个算，不卡页面）。 */
export async function solvePow(): Promise<{ solution: PowSolution; fetchedAt: number }> {
  const fetchedAt = Date.now()
  const c = await fetch('/api/auth/challenge', { cache: 'no-store' }).then(r => r.json()) as Challenge
  const target = hexBytes(c.challenge)
  const enc = new TextEncoder()
  for (let n = 0; n <= c.maxnumber; n++) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(c.salt + n)))
    let same = true
    for (let i = 0; i < 32 && same; i++) same = digest[i] === target[i]
    if (same) return { solution: { challenge: c.challenge, salt: c.salt, number: n, signature: c.signature }, fetchedAt }
  }
  throw new Error('人机校验失败，请刷新页面')
}

/** 服务端要求领题后至少 1.5 秒才提交（拦脚本）：不足时补足等待。 */
export async function powDelay(fetchedAt: number): Promise<void> {
  const wait = fetchedAt + 1700 - Date.now()
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
}
