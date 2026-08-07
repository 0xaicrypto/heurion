import prisma from '../../common/prisma.js'

/**
 * #283/#284: email verification codes — 6 digits, 10 min expiry, 60s
 * resend throttle, 5 attempts, single-use. Delivery via Resend when
 * RESEND_API_KEY is configured; otherwise the code is logged (dev mode).
 */

const CODE_TTL_MS = 10 * 60 * 1000
const RESEND_THROTTLE_MS = 60 * 1000
const MAX_ATTEMPTS = 5
// #344: per-IP guard — at most 5 send-code calls per 10 minutes per IP,
// independent of target, so an attacker cannot spray many mailboxes.
const IP_WINDOW_MS = 10 * 60 * 1000
const IP_MAX_SENDS = 5
const PURPOSES = ['register', 'bind', 'reset'] as const
export type VerificationPurpose = (typeof PURPOSES)[number]

function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase()
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

/** Generate a 6-digit code. */
export function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000))
}

async function deliverEmail(email: string, code: string, purpose: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.EMAIL_FROM || 'Heurion <no-reply@heurion.org>'
  const subject = purpose === 'reset'
    ? '重置密码验证码'
    : purpose === 'register'
      ? '注册验证码'
      : '绑定邮箱验证码'
  const body = `你的验证码是：${code}（10 分钟内有效）。`
  if (apiKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to: [email], subject, text: body }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Resend failed: ${res.status} ${text.slice(0, 120)}`)
    }
  } else {
    // Dev mode: no provider configured — log the code instead of failing.
    console.log(`[AUTH] verification code for ${email} (${purpose}): ${code}`)
  }
}

/** Send a code (throttled). Throws on invalid input / throttle / send failure. */
export async function sendVerificationCode(email: string, purpose: VerificationPurpose, ip?: string): Promise<{ ok: true; expires_in: number }> {
  const target = normalizeEmail(email)
  if (!isValidEmail(target)) throw new Error('Invalid email')
  if (!PURPOSES.includes(purpose)) throw new Error('Invalid purpose')

  const now = Date.now()
  // Throttle: the most recent code for this target+purpose must be old enough.
  const recent = await (prisma as any).verificationCode.findFirst({
    where: { target, purpose, usedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  if (recent && now - new Date(recent.createdAt).getTime() < RESEND_THROTTLE_MS) {
    throw new Error('请稍后再试（60 秒内只能发送一次）')
  }

  // #344: per-IP cap — reject when this IP sent too many codes recently.
  if (ip) {
    const recentByIp = await (prisma as any).verificationCode.count({
      where: {
        ip,
        createdAt: { gte: new Date(now - IP_WINDOW_MS).toISOString() },
      },
    })
    if (recentByIp >= IP_MAX_SENDS) {
      throw new Error('发送过于频繁，请稍后再试')
    }
  }

  const code = generateCode()
  await (prisma as any).verificationCode.create({
    data: {
      target,
      code,
      purpose,
      expiresAt: new Date(now + CODE_TTL_MS).toISOString(),
      createdAt: new Date(now).toISOString(),
      ip: ip || null,
    },
  })
  await deliverEmail(target, code, purpose)
  return { ok: true, expires_in: CODE_TTL_MS / 1000 }
}

/**
 * Verify a code — 5 attempts, single-use, expiry. On success marks it used.
 * #343: the lookup must NOT filter by code — wrong codes would never match
 * a row, so attempts never counted. Now we resolve the latest unused row
 * for target+purpose and compare the code against it.
 */
export async function verifyCode(email: string, code: string, purpose: VerificationPurpose): Promise<boolean> {
  const target = normalizeEmail(email)
  const now = Date.now()
  const row = await (prisma as any).verificationCode.findFirst({
    where: { target, purpose, usedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  if (!row) return false
  if (now > new Date(row.expiresAt).getTime()) return false
  if (row.attempts >= MAX_ATTEMPTS) return false

  if (String(row.code).trim() !== String(code).trim()) {
    await (prisma as any).verificationCode.update({
      where: { id: row.id },
      data: { attempts: { increment: 1 } },
    })
    return false
  }

  await (prisma as any).verificationCode.update({
    where: { id: row.id },
    data: { usedAt: new Date(now).toISOString() },
  })
  return true
}
