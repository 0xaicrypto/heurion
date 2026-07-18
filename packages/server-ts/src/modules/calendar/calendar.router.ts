import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import prisma from '../../common/prisma'

/**
 * Calendar export — iCal format so users can subscribe from Google/Apple Calendar.
 * Includes:
 *   - Study assessment due dates
 *   - Safety follow-up reminders
 *   - Patient follow-up events (from assessments)
 *
 * User subscribes once, calendar auto-updates on each refresh.
 */
export async function calendarRouter(app: FastifyInstance) {
  // Public route — uses token in URL query param (Apple Calendar can't send custom headers)
  app.get('/api/v1/calendar/export.ics', async (request, reply) => {
    const token = (request.query as any).token || ''
    if (!token) return { error: 'token required' }
    // Verify the token to get userId
    const { verifyToken } = await import('../../common/jwt.js')
    let userId: string
    try { userId = verifyToken(token).userId } catch { return { error: 'invalid token' } }
    const now = new Date()
    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Heurion//Clinical Calendar//EN',
      'X-WR-CALNAME:Heurion Clinical Schedule',
    ]

    // 1. Research study assessments
    const assessments = await (prisma as any).researchAssessment.findMany({
      where: { study: { userId } },
      include: { study: true },
    })
    for (const a of assessments) {
      if (a.completedAt) continue
      const due = new Date(a.dueAt)
      lines.push(
        'BEGIN:VEVENT',
        `UID:heurion-assessment-${a.id}`,
        `DTSTART:${toICSDate(due)}`,
        `SUMMARY:📋 ${a.title || a.visit} — ${a.study?.shortCode || ''}`,
        `DESCRIPTION:Study: ${a.study?.name || ''}\\nVisit: ${a.visit}\\nPatient: ${a.patientHash}`,
        'CATEGORIES:Research',
        'END:VEVENT',
      )
    }

    // 2. Safety follow-up reminders (30 days after last observation)
    const studies = await (prisma as any).researchStudy.findMany({ where: { userId } })
    for (const study of studies) {
      const safetyDate = new Date(study.updatedAt)
      safetyDate.setDate(safetyDate.getDate() + 30)
      if (safetyDate > now) {
        lines.push(
          'BEGIN:VEVENT',
          `UID:heurion-safety-${study.id}`,
          `DTSTART:${toICSDate(safetyDate)}`,
          `SUMMARY:🔬 Safety Review — ${study.shortCode}`,
          `DESCRIPTION:30-day safety follow-up for ${study.name}`,
          'CATEGORIES:Safety',
          'END:VEVENT',
        )
      }
    }

    // 3. Scheduled tasks
    const tasks = await (prisma as any).session.findMany({
      where: { userId, archived: 0 },
      orderBy: { lastMessageAt: 'desc' },
      take: 5,
    })
    for (const t of tasks) {
      if (!t.lastMessageAt) continue
      const remind = new Date(t.lastMessageAt)
      remind.setDate(remind.getDate() + 7)
      if (remind > now) {
        lines.push(
          'BEGIN:VEVENT',
          `UID:heurion-followup-${t.id}`,
          `DTSTART:${toICSDate(remind)}`,
          `SUMMARY:📝 Follow-up — ${t.title || 'Patient chat'}`,
          `DESCRIPTION:Last message: ${t.lastMessageAt}. Session: ${t.id}`,
          'CATEGORIES:Follow-up',
          'END:VEVENT',
        )
      }
    }

    lines.push('END:VCALENDAR')

    reply.header('Content-Type', 'text/calendar; charset=utf-8')
    reply.header('Content-Disposition', 'inline; filename=heurion.ics')
    return lines.join('\r\n')
  })

  // Helper: get calendar subscription URL with embedded token
  app.get('/api/v1/calendar/subscribe-url', { preHandler: [authGuard] }, async (request) => {
    const header = request.headers.authorization || ''
    const rawToken = header.replace('Bearer ', '')
    const host = request.headers.host || 'heurion.org'
    const proto = request.headers['x-forwarded-proto'] || 'https'
    return {
      url: `${proto}://${host}/api/v1/calendar/export.ics?token=${rawToken}`,
      instructions: 'Apple: Calendar → File → New Calendar Subscription → paste URL\nGoogle: Settings → Add Calendar → From URL → paste URL',
    }
  })
}

function toICSDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '') + 'Z'
}
