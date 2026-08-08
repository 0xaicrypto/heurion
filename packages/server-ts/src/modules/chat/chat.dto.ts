/**
 * #349: request validation for core write routes — zod schemas in the
 * auth.dto.ts style. Invalid bodies fail at the entry with a 400 + clear
 * message instead of crashing mid-request.
 */
import { z } from 'zod'

export const chatSendSchema = z.object({
  text: z.string().min(1).max(8000),
  session_id: z.string().min(1).max(128).optional(),
  patient_hash: z.string().min(1).max(128).nullable().optional(),
  attachments: z
    .array(
      z.union([
        z.string().min(1).max(512),
        z.object({
          file_id: z.string().max(512).optional(),
          fileId: z.string().max(512).optional(),
          name: z.string().max(256).optional(),
        }),
      ]),
    )
    .max(20)
    .optional(),
})

export type ChatSendInput = z.infer<typeof chatSendSchema>

export const memoryImportSchema = z
  .object({
    facts: z
      .array(
        z.object({
          content: z.string().min(1).max(4000),
          category: z.enum(['allergy', 'constraint', 'context', 'diagnosis', 'exam', 'fact', 'goal', 'medication', 'plan', 'preference', 'symptom']).optional(),
          importance: z.number().min(1).max(5).optional(),
          sourceType: z.enum(['doctor', 'document', 'general', 'patient', 'research', 'sidecar']).optional(),
          patientHash: z.string().max(128).optional(),
          studyId: z.string().max(128).optional(),
        }),
      )
      .max(200)
      .optional(),
    episodes: z
      .array(
        z.object({
          sessionId: z.string().max(128).optional(),
          summary: z.string().max(4000).optional(),
          turnCount: z.number().int().min(0).optional(),
        }),
      )
      .max(200)
      .optional(),
  })

export type MemoryImportInput = z.infer<typeof memoryImportSchema>

export const manualMemorySchema = z.object({
  content: z.string().min(1).max(4000),
  category: z.string().max(64).optional(),
  importance: z.number().int().min(1).max(5).optional(),
  patient_hash: z.string().max(128).nullable().optional(),
})

export type ManualMemoryInput = z.infer<typeof manualMemorySchema>

export const registerPatientSchema = z.object({
  initials: z.string().min(1).max(16),
  age: z.number().int().min(0).max(130).optional(),
  sex: z.enum(['M', 'F', 'O']).optional(),
  chief_complaint: z.string().max(2000).optional(),
})

export type RegisterPatientInput = z.infer<typeof registerPatientSchema>
