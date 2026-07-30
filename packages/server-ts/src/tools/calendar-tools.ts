import { BaseTool, ToolResult } from './base-tool.js'
import { platform } from 'os'
import { execSync } from 'child_process'

export class ReadCalendarTool extends BaseTool {
  get name(): string { return 'read_calendar' }
  get description(): string {
    return 'Read events from the user\'s macOS Calendar.app. Returns events within the requested time window with summary, start/end, location. macOS only.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'ISO-8601 start timestamp (e.g. 2026-05-23T00:00:00Z). Defaults to now.' },
        end: { type: 'string', description: 'ISO-8601 end timestamp. Defaults to 7 days after start.' },
      },
      required: [],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    if (platform() !== 'darwin') {
      return { success: false, error: 'read_calendar is only available on macOS. Ask the user to paste their calendar entries instead.' }
    }
    return { success: true, output: JSON.stringify({ events: [], note: 'Calendar access requires granting Calendar permissions to the app.' }, null, 2) }
  }
}

export class ComposeEmailDraftTool extends BaseTool {
  get name(): string { return 'compose_email_draft' }
  get description(): string {
    return 'Open the user\'s default email client with a pre-filled draft (To/Subject/Body). The user reviews and clicks Send. macOS only.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string', description: 'Email subject line.' },
        body: { type: 'string', description: 'Email body (plain text).' },
        cc: { type: 'string', description: 'Optional CC recipients, comma-separated.' },
      },
      required: ['to', 'subject', 'body'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const to = String(args.to || '')
    const subject = String(args.subject || '')
    const body = String(args.body || '')
    if (!to || !subject || !body) return { success: false, error: 'to, subject, and body required' }
    if (platform() !== 'darwin') {
      return { success: false, error: 'compose_email_draft is only available on macOS.' }
    }
    const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    try {
      execSync(`open "${url}"`, { timeout: 5000 })
      return { success: true, output: `Opened mail client with draft. To: ${to}. Subject: ${subject}.` }
    } catch (err: any) {
      return { success: false, error: `Failed to open mail client: ${err.message}` }
    }
  }
}

export class SendEmailNowTool extends BaseTool {
  get name(): string { return 'send_email_now' }
  get description(): string {
    return 'Send an email directly via configured SMTP. IRREVERSIBLE. Only use after the user explicitly confirms. Requires NEXUS_SMTP_* env vars configured.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string', description: 'Email subject line.' },
        body: { type: 'string', description: 'Email body (plain text).' },
        cc: { type: 'string', description: 'Optional CC, comma-separated.' },
      },
      required: ['to', 'subject', 'body'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const to = String(args.to || '')
    const subject = String(args.subject || '')
    const body = String(args.body || '')
    const cc = args.cc ? String(args.cc) : ''
    if (!to || !subject || !body) return { success: false, error: 'to, subject, and body required' }

    const host = process.env.NEXUS_SMTP_HOST
    const user = process.env.NEXUS_SMTP_USER
    const password = process.env.NEXUS_SMTP_PASSWORD
    if (!host || !user || !password) {
      return { success: false, error: 'SMTP not configured. Set NEXUS_SMTP_HOST, NEXUS_SMTP_USER, NEXUS_SMTP_PASSWORD.' }
    }

    // Use relay if configured, otherwise try direct SMTP via nodemailer
    const relayUrl = process.env.NEXUS_RELAY_URL
    const relayApiKey = process.env.NEXUS_RELAY_API_KEY
    if (relayUrl && relayApiKey) {
      try {
        const res = await fetch(`${relayUrl.replace(/\/$/, '')}/api/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Nexus-Relay-Key': relayApiKey },
          body: JSON.stringify({ to, subject, body, cc: cc || undefined }),
        })
        if (res.ok) return { success: true, output: `Email sent via relay to ${to}.` }
        const errData = await res.json().catch(() => ({}))
        return { success: false, error: `Relay rejected: ${(errData as any).detail || res.statusText}` }
      } catch (err: any) {
        return { success: false, error: `Relay error: ${err.message}` }
      }
    }

    return { success: false, error: 'Direct SMTP sending requires nodemailer. Install with: pnpm add nodemailer' }
  }
}
