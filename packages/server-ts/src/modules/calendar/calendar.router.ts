import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import { getPendingRules } from '../research/protocol-extractor.js'
import prisma from '../../common/prisma'

export async function calendarRouter(app: FastifyInstance) {
  // Public route — token in URL (Apple/Google Calendar can't send headers)
  app.get('/api/v1/calendar/export.ics', async (request, reply) => {
    const token = (request.query as any).token || ''
    if (!token) return { error: 'token required' }
    const { verifyToken } = await import('../../common/jwt.js')
    let userId: string
    try { userId = verifyToken(token).userId } catch { return { error: 'invalid token' } }

    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Heurion//Clinical Calendar//EN',
      'X-WR-CALNAME:Heurion Studies',
    ]

    // 1. Protocol schedule rules → calendar events
    const studies = await (prisma as any).researchStudy.findMany({ where: { userId } })
    for (const study of studies) {
      const rules = getPendingRules(study.id)
      const scheduleRules = rules.filter((r: any) => r.category === 'schedule' && r.confirmed)

      // Use study creation date as study start date
      const studyStart = new Date(study.createdAt)
      
      for (const rule of scheduleRules) {
        // Parse "Visit Name (Day X): assessments" from the rule text
        const match = rule.rule.match(/^(.+?)\s*\((.+?)\):\s*(.+)$/)
        if (!match) continue
        const [, visit, timing, assessments] = match

        // Calculate actual date from relative timing
        const days = parseTiming(timing, studyStart)
        if (!days) continue

        const eventDate = new Date(studyStart)
        eventDate.setDate(eventDate.getDate() + days)

        lines.push(
          'BEGIN:VEVENT',
          `UID:heurion-${study.id}-${rule.id}`,
          `DTSTART;VALUE=DATE:${toDateOnly(eventDate)}`,
          `SUMMARY:📋 ${study.shortCode}: ${visit}`,
          `DESCRIPTION:Study: ${study.name}\\nVisit: ${visit}\\nTiming: ${timing}\\nAssessments: ${assessments}`,
          'CATEGORIES:Research',
          'END:VEVENT',
        )
      }

      // 2. Upcoming assessment due dates (from enrolled patients)
      const rosterEntries = await (prisma as any).researchEnrollment.findMany({
        where: { studyId: study.id, unenrolledAt: null },
      })
      for (const entry of rosterEntries) {
        const enrollDate = new Date(entry.enrolledAt)
        // Generate assessments at protocol intervals (every 21 days = Q3W)
        for (let cycle = 1; cycle <= 12; cycle++) {
          const cycleDate = new Date(enrollDate)
          cycleDate.setDate(cycleDate.getDate() + (cycle - 1) * 21)
          if (cycleDate < new Date()) continue

          lines.push(
            'BEGIN:VEVENT',
            `UID:heurion-cycle-${study.id}-${entry.patientHash}-c${cycle}`,
            `DTSTART;VALUE=DATE:${toDateOnly(cycleDate)}`,
            `SUMMARY:🩺 ${study.shortCode}: Cycle ${cycle} — ${entry.patientHash}`,
            `DESCRIPTION:Treatment cycle ${cycle} for patient ${entry.patientHash}\\nStudy: ${study.name}\\nArm: ${entry.arm}`,
            'CATEGORIES:Treatment',
            'END:VEVENT',
          )
          break // Only show next cycle to avoid flooding calendar
        }
      }
    }

    // 3. Safety reminders (30 days after last update)
    for (const study of studies) {
      const safetyDate = new Date(study.updatedAt)
      safetyDate.setDate(safetyDate.getDate() + 30)
      if (safetyDate > new Date()) {
        lines.push(
          'BEGIN:VEVENT',
          `UID:heurion-safety-${study.id}`,
          `DTSTART;VALUE=DATE:${toDateOnly(safetyDate)}`,
          `SUMMARY:🔬 Safety Review — ${study.shortCode}`,
          `DESCRIPTION:30-day safety follow-up for ${study.name}`,
          'CATEGORIES:Safety',
          'END:VEVENT',
        )
      }
    }

    lines.push('END:VCALENDAR')

    reply.header('Content-Type', 'text/calendar; charset=utf-8')
    reply.header('Content-Disposition', 'inline; filename=heurion.ics')
    return lines.join('\r\n')
  })

  app.get('/api/v1/calendar/subscribe-url', { preHandler: [authGuard] }, async (request) => {
    const header = request.headers.authorization || ''
    const rawToken = header.replace('Bearer ', '')
    const host = request.headers.host || 'heurion.org'
    const proto = 'https'
    return {
      url: `${proto}://${host}/api/v1/calendar/export.ics?token=${rawToken}`,
      instructions: 'Apple: Calendar → File → New Calendar Subscription → paste URL\nGoogle: Settings → Add Calendar → From URL → paste URL',
    }
  })
}

// Parse relative timing like "Day -28 to -1", "Day 1", "every 3 weeks" into absolute day offset
function parseTiming(timing: string, studyStart: Date): number | null {
  // "Day -28 to -1" → -28
  const dayMatch = timing.match(/Day\s+(-?\d+)/)
  if (dayMatch) return parseInt(dayMatch[1])
  
  // "every 3 weeks" → 21
  const weekMatch = timing.match(/every\s+(\d+)\s*week/i)
  if (weekMatch) return parseInt(weekMatch[1]) * 7
  
  // "every 3 months" → 90
  const monthMatch = timing.match(/every\s+(\d+)\s*month/i)
  if (monthMatch) return parseInt(monthMatch[1]) * 30

  // "Day 1 of first 21-day cycle" → 1
  const cycleDay = timing.match(/cycle.*?Day\s+(\d+)/i)
  if (cycleDay) return parseInt(cycleDay[1])

  return null
}

function toDateOnly(d: Date): string {
  return d.toISOString().split('T')[0].replace(/-/g, '')
}
