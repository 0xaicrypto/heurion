/**
 * 发信（验证码）。配置 RESEND_API_KEY 时经 Resend 发送（同 1.0）；未配置时：开发环境把内容打到日志、
 * 生产环境报「邮件服务未配置」（不能在生产日志里留验证码）。
 */
export interface Mailer {
  /** 配了真实发信服务。 */
  readonly configured: boolean
  /** 能发（配了服务，或开发环境打日志）。 */
  readonly available: boolean
  send(to: string, subject: string, text: string): Promise<void>
}

export class MailerError extends Error {}

export function createMailer(opts: { resendApiKey?: string; from?: string; production: boolean; log?: (line: string) => void }): Mailer {
  const from = opts.from || 'Heurion <no-reply@heurion.org>'
  if (opts.resendApiKey) {
    return {
      configured: true,
      available: true,
      async send(to, subject, text) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.resendApiKey}` },
          body: JSON.stringify({ from, to: [to], subject, text }),
        })
        if (!res.ok) throw new MailerError(`邮件发送失败（${res.status}）`)
      },
    }
  }
  const log = opts.log ?? (line => console.log(line))
  return {
    configured: false,
    available: !opts.production,
    async send(to, subject, text) {
      if (opts.production) throw new MailerError('邮件服务未配置')
      log(`[邮件·开发模式未真正发送] 收件人 ${to}｜${subject}｜${text}`)
    },
  }
}
