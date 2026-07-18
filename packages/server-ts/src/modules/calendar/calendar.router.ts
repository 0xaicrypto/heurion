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

    // 1. Generate events from each study
    const studies = await (prisma as any).researchStudy.findMany({ where: { userId } })
    for (const study of studies) {
      const studyStart = new Date(study.createdAt)
      const rules = getPendingRules(study.id)
      const scheduleRules = rules.filter((r: any) => r.category === 'schedule' && r.confirmed)

      if (scheduleRules.length > 0) {
        // Use confirmed schedule rules
        for (const rule of scheduleRules) {
          const match = rule.rule.match(/^(.+?)\s*\((.+?)\):\s*(.+)$/)
          if (!match) continue
          const [, visit, timing, assessments] = match
          const days = parseTiming(timing, studyStart)
          if (!days) continue
          const eventDate = new Date(studyStart)
          eventDate.setDate(eventDate.getDate() + days)
          lines.push(
            'BEGIN:VEVENT', `UID:heurion-${study.id}-${rule.id}`,
            `DTSTART;VALUE=DATE:${toDateOnly(eventDate)}`,
            `SUMMARY:📋 ${study.shortCode}: ${visit}`,
            `DESCRIPTION:Study: ${study.name}\\nTiming: ${timing}\\nAssessments: ${assessments}`,
            'CATEGORIES:Research', 'END:VEVENT',
          )
        }
      } else {
        // Fallback: generate protocol-based schedule from creation date
        const milestones = [
          { day: 0, label: 'Study Start', emoji: '🚀' },
          { day: 7, label: 'Site Initiation', emoji: '🏥' },
          { day: 14, label: 'First Patient Screening', emoji: '🔍' },
          { day: 30, label: 'Safety Review #1', emoji: '🔬' },
          { day: 60, label: 'Interim Analysis', emoji: '📊' },
          { day: 90, label: 'Safety Review #2', emoji: '🔬' },
        ]
        for (const m of milestones) {
          const d = new Date(studyStart)
          d.setDate(d.getDate() + m.day)
          lines.push(
            'BEGIN:VEVENT', `UID:heurion-${study.id}-m${m.day}`,
            `DTSTART;VALUE=DATE:${toDateOnly(d)}`,
            `SUMMARY:${m.emoji} ${study.shortCode}: ${m.label}`,
            `DESCRIPTION:Study: ${study.name}\\nProtocol milestone`,
            'CATEGORIES:Research', 'END:VEVENT',
          )
        }
      }

      // 2. Enrolled patient treatment cycles
      const rosterEntries = await (prisma as any).researchEnrollment.findMany({
        where: { studyId: study.id, unenrolledAt: null },
      })
      for (const entry of rosterEntries) {
        const enrollDate = new Date(entry.enrolledAt)
        for (let cycle = 1; cycle <= 3; cycle++) {
          const cycleDate = new Date(enrollDate)
          cycleDate.setDate(cycleDate.getDate() + (cycle - 1) * 21)
          if (cycleDate < new Date()) continue
          lines.push(
            'BEGIN:VEVENT', `UID:heurion-cycle-${study.id}-${entry.patientHash}-c${cycle}`,
            `DTSTART;VALUE=DATE:${toDateOnly(cycleDate)}`,
            `SUMMARY:🩺 ${study.shortCode}: Cycle ${cycle} — ${entry.patientHash}`,
            `DESCRIPTION:Treatment cycle ${cycle}\\nStudy: ${study.name}\\nArm: ${entry.arm}`,
            'CATEGORIES:Treatment', 'END:VEVENT',
          )
          break
        }
      }

      // 3. Safety review (30 days after last activity)
      const safetyDate = new Date(study.updatedAt)
      safetyDate.setDate(safetyDate.getDate() + 30)
      if (safetyDate > new Date()) {
        lines.push(
          'BEGIN:VEVENT', `UID:heurion-safety-${study.id}`,
          `DTSTART;VALUE=DATE:${toDateOnly(safetyDate)}`,
          `SUMMARY:🔬 Safety Review — ${study.shortCode}`,
          `DESCRIPTION:30-day safety follow-up for ${study.name}`,
          'CATEGORIES:Safety', 'END:VEVENT',
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
    // Generate a dedicated calendar token with 30-day expiry
    const { signToken, verifyToken } = await import('../../common/jwt.js')
    const payload = verifyToken(rawToken)
    const calToken = signToken({ userId: payload.userId, role: payload.role, displayName: payload.displayName }, '720h')
    return {
      url: `https://${host}/api/v1/calendar/export.ics?token=${calToken}`,
      instructions: 'Apple: Calendar → File → New Calendar Subscription → paste URL\nGoogle: Settings → Add Calendar → From URL → paste URL\nToken valid for 30 days.',
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
